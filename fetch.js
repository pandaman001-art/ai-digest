// fetch.js — RSSを取得し、日本語以外は翻訳して data.json に保存する
// GitHub Actions のサーバー上で実行されるため、CORSプロキシは不要。
// Node.js 20+ を想定（グローバル fetch / DOMParser代替に軽量パーサを使用）。

const fs = require('fs');

// ── ソース定義 ──────────────────────────────
// 各媒体のRSSを直接取得する。description に各媒体が書いた記事要約が入るため、
// Google News経由（要約が取れない）を廃止。
const MAX_EACH = 12;
const SOURCES = [
  // 海外（英語・要翻訳）
  { key:'techcrunch', url:'https://techcrunch.com/category/artificial-intelligence/feed/',
    cat:'ai-global', label:'海外AI', lang:'en' },
  { key:'theverge',   url:'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    cat:'ai-global', label:'海外AI', lang:'en' },
  { key:'venturebeat',url:'https://venturebeat.com/category/ai/feed/',
    cat:'ai-global', label:'海外AI', lang:'en' },
  { key:'arstechnica',url:'https://feeds.arstechnica.com/arstechnica/technology-lab',
    cat:'ai-global', label:'海外AI', lang:'en' },
  { key:'mittr',      url:'https://www.technologyreview.com/topic/artificial-intelligence/feed',
    cat:'ai-global', label:'海外AI', lang:'en' },
  // 国内（日本語・翻訳不要）
  { key:'itmedia',    url:'https://rss.itmedia.co.jp/rss/2.0/aiplus.xml',
    cat:'ai-japan', label:'国内AI', lang:'ja' },
  { key:'gigazine',   url:'https://gigazine.net/news/rss_2.0/',
    cat:'ai-japan', label:'国内AI', lang:'ja' },
  { key:'pcwatch',    url:'https://pc.watch.impress.co.jp/data/rss/1.0/pcw/feed.rdf',
    cat:'ai-japan', label:'国内AI', lang:'ja' },
];

// 国内の総合系フィード（GIGAZINE/PC Watch）はAI以外も混ざるため、
// タイトル・本文にAI関連語を含む記事だけ残すフィルタ
const AI_KEYWORDS = /AI|人工知能|生成AI|ChatGPT|LLM|機械学習|ディープラーニング|OpenAI|Gemini|Claude|Copilot|大規模言語モデル/i;
const FILTER_KEYS = new Set(['gigazine', 'pcwatch']);

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
  // 4. 「続きを読む」等の定型末尾を除去
  t = t.replace(/(続きを読む|Read more|The post .+ appeared first on .+)\.?$/i, '').trim();
  return t;
}

// RSS(<item>)とAtom(<entry>)の両方から記事を抜き出す（外部ライブラリ不要）
function parseItems(xml) {
  const items = [];
  const isAtom = /<entry[>\s]/.test(xml) && !/<item[>\s]/.test(xml);
  const tag = isAtom ? 'entry' : 'item';
  const blocks = xml.split(new RegExp('<' + tag + '[>\\s]')).slice(1);
  for (const block of blocks) {
    const end = block.indexOf('</' + tag + '>');
    const body = end > -1 ? block.slice(0, end) : block;
    const pick = (t) => {
      const m = body.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>', 'i'));
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    };
    // Atomのlinkは <link href="..."/> 形式
    let link = pick('link');
    if (!link) {
      const lm = body.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (lm) link = lm[1];
    }
    items.push({
      title: pick('title'),
      link,
      pubDate: pick('pubDate') || pick('published') || pick('updated') || pick('dc:date'),
      description: pick('description') || pick('summary') || pick('content') || pick('content:encoded'),
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
  let raw = parseItems(xml);

  // 総合系フィードはAI関連記事だけに絞る
  if (FILTER_KEYS.has(src.key)) {
    raw = raw.filter(it => AI_KEYWORDS.test((it.title || '') + ' ' + (it.description || '')));
  }
  raw = raw.slice(0, MAX_EACH);

  return raw.map(it => {
    const origTitle = stripHtml(it.title || '');
    const pub = new Date(it.pubDate || Date.now());
    const summary = stripHtml(it.description || '').slice(0, 400);
    return {
      cat: src.cat, label: src.label, lang: src.lang,
      source: src.label,
      origTitle, title: origTitle,
      link: (it.link || '#').trim(),
      dateStr: isNaN(pub) ? new Date().toISOString().slice(0, 10) : pub.toISOString().slice(0, 10),
      ts: isNaN(pub) ? Date.now() : pub.getTime(),
      summaryOrig: summary,
      summary: src.lang === 'ja' ? summary : '',  // 英語は後で翻訳
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

// ── 記事ページの公式要約（meta description）を取得 ──
// 各サイトが検索エンジン向けに公開している短い説明文（1〜2文）のみを取得する。
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

  // タイトルと要約を翻訳（英語ソースのみ。RSSのdescriptionが実要約）
  const targets = articles.filter(a => !a.translated);
  let done = 0;
  for (const a of targets) {
    const t = await gtranslate(a.origTitle);
    if (t && t !== a.origTitle) { a.title = t; a.translated = true; }
    if (a.summaryOrig) {
      const st = await gtranslate(a.summaryOrig);
      a.summary = (st && st.trim()) ? st : a.summaryOrig;
    }
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
