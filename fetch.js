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
  // VentureBeat は2026年9月以降、GitHub Actions からのアクセスを HTTP 429 で拒否するため除外
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

// 通信はすべてタイムアウト付きで行う（応答待ち・本文の受信待ちの両方を打ち切る）。
// タイムアウトが無いと接続が残ってnodeが終了できず、ジョブが6時間止まったことがある。
const FEED_TIMEOUT_MS = 20000;
const TRANSLATE_TIMEOUT_MS = 15000;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

function fetchWithTimeout(url, opts, ms) {
  return fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(ms) });
}

// 失敗した応答も本文を読み捨てて接続を解放する
async function discard(res) {
  try { await res.body?.cancel(); } catch (_) { /* 解放できなくても続行 */ }
}

function reasonOf(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'タイムアウト' : (e && e.message) || String(e);
}

// XML/HTMLの文字参照をデコードする。名前付き（&amp; 等）に加えて
// 数値参照（&#45; → -、&#8217; → ’、&#x2d; → -）も処理する。
// GIGAZINEのRSSは<link>内のハイフンを &#45; で書いており、これを戻さないと
// URLの「#」以降がページ内アンカー扱いになり、別ページに飛んでしまう。
const NAMED_ENTITIES = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ' };
function decodeEntities(s) {
  return (s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const hex = e[1] === 'x' || e[1] === 'X';
      const code = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return String.fromCodePoint(code); } catch (_) { return m; }
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

// 記事URLとして使える形に整える（文字参照を戻し、http(s)以外は空にする）
function cleanUrl(u) {
  const t = decodeEntities(u).trim();
  return /^https?:\/\//i.test(t) ? t : '';
}

function stripHtml(s) {
  // 1. 文字参照をデコード（&lt; → <、&#8217; → ’ など）
  let t = decodeEntities(s);
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
    // linkの取得。Atomは <link href="..."/> 形式で複数ある場合があるため、
    // rel="alternate"（記事本文）を優先し、無ければ最初のhrefを使う
    let link = '';
    const linkTags = body.match(/<link\b[^>]*>/gi) || [];
    for (const lt of linkTags) {
      if (/rel=["']alternate["']/i.test(lt)) {
        const hm = lt.match(/href=["']([^"']+)["']/i);
        if (hm) { link = hm[1]; break; }
      }
    }
    if (!link) {
      // rel指定なし: hrefを持つ最初のlink、なければ<link>テキスト
      for (const lt of linkTags) {
        if (/rel=/i.test(lt)) continue; // comments等のrel付きは避ける
        const hm = lt.match(/href=["']([^"']+)["']/i);
        if (hm) { link = hm[1]; break; }
      }
    }
    if (!link) link = pick('link');
    if (!link) {
      const lm = body.match(/<link[^>]+href=["']([^"']+)["']/i);
      if (lm) link = lm[1];
    }
    // 文字参照を戻す。それでもURLとして不正なら guid / id（記事の固定URL）で代替
    link = cleanUrl(link) || cleanUrl(pick('guid')) || cleanUrl(pick('id'));
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

// RSS / Atom / RDF のどれかであるか（ブロック画面などのHTMLを弾く）
const looksLikeFeed = txt => /<(rss|feed|rdf:RDF)[\s>]/i.test(txt || '');

async function getXml(url) {
  // 直接取得 → ダメなら中継経由。どちらで何が起きたかをすべてエラーに残す
  const attempts = [['直接', url, { headers: UA }], ['中継', FALLBACK(url), {}]];
  const reasons = [];
  for (const [name, target, opts] of attempts) {
    try {
      const res = await fetchWithTimeout(target, opts, FEED_TIMEOUT_MS);
      if (!res.ok) { await discard(res); reasons.push(name + ' HTTP ' + res.status); continue; }
      const txt = await res.text();
      if (!looksLikeFeed(txt)) { reasons.push(name + ' RSSではない応答(' + txt.length + '文字)'); continue; }
      return txt;
    } catch (e) {
      reasons.push(name + ' ' + reasonOf(e));
    }
  }
  throw new Error(reasons.join(' / '));
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

// ── 翻訳 ──────────────────────────────────
// 翻訳の成否を集計してログに出すためのカウンタ
const translateStats = { google: 0, mymemory: 0, failed: 0 };

// 1) Google翻訳簡易API（GitHubサーバーIPだと弾かれやすい）
// 2) 失敗時 MyMemory（サーバーIPからでも通りやすい無料API）
async function viaGoogle(text) {
  const url = 'https://translate.googleapis.com/translate_a/single?' +
    new URLSearchParams({ client: 'gtx', sl: 'en', tl: 'ja', dt: 't', q: text.slice(0, 500) });
  const res = await fetchWithTimeout(url, { headers: UA }, TRANSLATE_TIMEOUT_MS);
  if (!res.ok) { await discard(res); throw new Error('google HTTP ' + res.status); }
  const data = await res.json();
  const out = (data[0] || []).map(s => s[0] || '').join('').trim();
  if (!out) throw new Error('google empty');
  return out;
}

async function viaMyMemory(text) {
  const url = 'https://api.mymemory.translated.net/get?' +
    new URLSearchParams({ q: text.slice(0, 480), langpair: 'en|ja' });
  const res = await fetchWithTimeout(url, {}, TRANSLATE_TIMEOUT_MS);
  if (!res.ok) { await discard(res); throw new Error('mymemory HTTP ' + res.status); }
  const data = await res.json();
  const out = (data && data.responseData && data.responseData.translatedText || '').trim();
  if (!out || /MYMEMORY WARNING/i.test(out)) throw new Error('mymemory quota/empty');
  return out;
}

// 連続でこの回数失敗した翻訳APIは、その実行中は使わない。
// （止まったAPIに毎回タイムアウトまで待たされて、実行が長引くのを防ぐ）
const DISABLE_AFTER = 6;
const failStreak = { google: 0, mymemory: 0 };

async function tryApi(name, fn, text, waitMs, errors) {
  for (let i = 0; i < 2; i++) {
    if (failStreak[name] >= DISABLE_AFTER) return null;
    try {
      const out = await fn(text);
      failStreak[name] = 0;
      translateStats[name]++;
      return out;
    } catch (e) {
      errors.push(name + ':' + reasonOf(e));
      if (++failStreak[name] === DISABLE_AFTER) {
        console.error('  ' + name + ' が連続' + DISABLE_AFTER + '回失敗したため、今回は使用を停止');
      }
      await sleep(waitMs * (i + 1));
    }
  }
  return null;
}

async function gtranslate(text) {
  if (!text || !text.trim()) return null;
  const errors = [];
  // まずGoogle、ダメならMyMemoryをそれぞれ最大2回
  const out = await tryApi('google', viaGoogle, text, 500, errors)
           || await tryApi('mymemory', viaMyMemory, text, 700, errors);
  if (out) return out;
  translateStats.failed++;
  // 最初の数件だけ詳細な失敗理由を出す（ログが膨大になるのを防ぐ）
  if (translateStats.failed <= 3) {
    console.error('  翻訳失敗の理由: ' + errors.join(' / '));
  }
  return null;
}

// ── 記事ページの公式要約（meta description）を取得 ──
// 各サイトが検索エンジン向けに公開している短い説明文（1〜2文）のみを取得する。
// ── メイン ──────────────────────────────────
(async () => {
  let articles = [];
  for (const src of SOURCES) {
    try {
      const items = await fetchSource(src);
      console.log(src.label + '(' + src.key + '): ' + items.length + '件取得');
      articles = articles.concat(items);
    } catch (e) {
      console.error(src.label + '(' + src.key + ') 取得失敗: ' + e.message);
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

  console.log('--- 翻訳結果 ---');
  console.log('Google成功: ' + translateStats.google);
  console.log('MyMemory成功: ' + translateStats.mymemory);
  console.log('全滅(失敗): ' + translateStats.failed);
  const stillEnglish = articles.filter(a => a.lang !== 'ja' && !a.translated).length;
  console.log('英語のまま残った記事: ' + stillEnglish + '件');

  const payload = {
    updatedAt: new Date().toISOString(),
    count: articles.length,
    articles,
  };
  fs.writeFileSync('data.json', JSON.stringify(payload, null, 2), 'utf8');
  console.log('data.json を保存しました（' + articles.length + '件）');
})().then(
  // 保存が終わったら明示的に終了する（通信が残っていてもジョブを止めない）
  () => process.exit(0),
  (e) => { console.error('致命的エラー:', e); process.exit(1); },
);
