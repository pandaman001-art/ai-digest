// fetch.js — RSSを取得し、日本語以外は翻訳して data.json に保存する
// GitHub Actions のサーバー上で実行されるため、CORSプロキシは不要。
// Node.js 20+ を想定（グローバル fetch / DOMParser代替に軽量パーサを使用）。

const fs = require('fs');

// ── ソース定義 ──────────────────────────────
const MAX_EACH = 25;
const SOURCES = [
  {
    key: 'jp',
    url: 'https://news.google.com/rss/search?q=' +
      encodeURIComponent('AI 人工知能 生成AI ChatGPT when:7d') +
      '&hl=ja&gl=JP&ceid=JP:ja',
    cat: 'ai-japan', label: '国内AI', lang: 'ja',
  },
  {
    key: 'us',
    url: 'https://news.google.com/rss/search?q=' +
      encodeURIComponent('AI artificial intelligence ChatGPT LLM when:7d') +
      '&hl=en-US&gl=US&ceid=US:en',
    cat: 'ai-global', label: '海外AI (US)', lang: 'en',
  },
];

// ── ユーティリティ ──────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stripHtml(s) {
  let t = s || '';
  // 1. HTMLエンティティをデコード（&lt; → < など）
  t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
       .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  // 2. HTMLタグを除去
  t = t.replace(/<[^>]*>/g, ' ');
  // 3. 残った実体参照や空白を整理
  t = t.replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  // 4. Google News RSSの description はリンク＋媒体名の羅列で内容が無いため、
  //    URLや "font color" 等のゴミが目立つ場合は本文として使わない
  if (/https?:\/\//.test(t) || /font color|target=/.test(t)) return '';
  return t;
}

// RSSのXMLから <item> を素朴に抜き出す（外部ライブラリ不要）
function parseItems(xml) {
  const items = [];
  const blocks = xml.split(/<item[>\s]/).slice(1);
  for (const block of blocks) {
    const body = block.slice(0, block.indexOf('</item>'));
    const pick = (tag) => {
      const m = body.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    };
    items.push({
      title: pick('title'),
      link: pick('link'),
      pubDate: pick('pubDate'),
      description: pick('description'),
    });
  }
  return items;
}

function splitSrc(raw) {
  const i = raw.lastIndexOf(' - ');
  if (i > 0 && raw.length - i < 60) {
    return { title: raw.slice(0, i).trim(), source: raw.slice(i + 3).trim() };
  }
  return { title: raw, source: '' };
}

// ── RSS取得 ─────────────────────────────────
// GitHub Actions のIPが稀にGoogleに403される場合の保険として中継を1つ用意
const FALLBACK = u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u);

async function getXml(url) {
  // まず直接取得
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (res.ok) {
      const txt = await res.text();
      if (txt && txt.length > 100) return txt;
    }
  } catch (e) { /* 次へ */ }
  // 403等なら中継経由で再試行
  const res2 = await fetch(FALLBACK(url));
  if (!res2.ok) throw new Error('HTTP ' + res2.status);
  const txt2 = await res2.text();
  if (!txt2 || txt2.length < 100) throw new Error('empty');
  return txt2;
}

async function fetchSource(src) {
  const xml = await getXml(src.url);
  const raw = parseItems(xml).slice(0, MAX_EACH);

  return raw.map(it => {
    const { title: origTitle, source } = splitSrc(it.title || '');
    const pub = new Date(it.pubDate || Date.now());
    return {
      cat: src.cat, label: src.label, lang: src.lang,
      source, origTitle, title: origTitle,
      link: (it.link || '#').trim(),
      dateStr: pub.toISOString().slice(0, 10),
      ts: pub.getTime(),
      desc: stripHtml(it.description).slice(0, 600),
      translated: src.lang === 'ja',
    };
  });
}

// ── 翻訳（無料Google翻訳の簡易エンドポイント）──
async function gtranslate(text) {
  if (!text || !text.trim()) return null;
  const url = 'https://translate.googleapis.com/translate_a/single?' +
    new URLSearchParams({ client: 'gtx', sl: 'auto', tl: 'ja', dt: 't', q: text.slice(0, 500) });
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const out = (data[0] || []).map(s => s[0] || '').join('').trim();
    return out || null;
  } catch (e) { return null; }
}

// ── メイン ──────────────────────────────────
(async () => {
  let articles = [];
  for (const src of SOURCES) {
    try {
      const items = await fetchSource(src);
      console.log(src.label + ': ' + items.length + '件取得');
      articles = articles.concat(items);
    } catch (e) {
      console.error(src.label + ' 取得失敗:', e.message);
    }
    await sleep(500);
  }

  // 重複除去
  const seen = new Set();
  articles = articles.filter(a => {
    const k = a.origTitle.toLowerCase().slice(0, 50);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  // 14日より古い記事を除外
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recent = articles.filter(a => a.ts >= cutoff);
  if (recent.length > 0) articles = recent;
  articles.sort((a, b) => b.ts - a.ts);

  // 翻訳
  const targets = articles.filter(a => !a.translated);
  let done = 0;
  for (const a of targets) {
    const t = await gtranslate(a.origTitle);
    if (t && t !== a.origTitle) { a.title = t; a.translated = true; }
    console.log('翻訳 ' + (++done) + '/' + targets.length);
    await sleep(150);
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    count: articles.length,
    articles,
  };
  fs.writeFileSync('data.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log('data.json を保存しました（' + articles.length + '件）');
})();
