// Story search against https://stories.picpub.art (search_web.php): a semantic index of
// Literotica and AO3 stories. The server stores summaries and metadata only, never the
// story text, so a result is read from its source URL.
//
// Pure: builds request URLs and turns raw results into the card model stories.html
// renders, so both can be tested without Electron. The fetch itself is in main.js.

const STORIES_BASE = 'https://stories.picpub.art/search_web.php';
const MAX_QUERY = 300;
const MAX_TAGS = 6;

// Only these options reach the server; anything else the renderer sends is dropped.
function buildSearchUrl(opts = {}) {
  const u = new URL(STORIES_BASE);
  u.searchParams.set('search', '1');
  u.searchParams.set('source', 'both');
  const q = typeof opts.q === 'string' ? opts.q.trim().slice(0, MAX_QUERY) : '';
  if (opts.random) u.searchParams.set('random', '1');
  else if (typeof opts.morelike === 'string' && /^[a-z0-9-]+$/.test(opts.morelike)) u.searchParams.set('morelike', opts.morelike);
  else if (q) u.searchParams.set('q', q);
  if (typeof opts.category === 'string' && opts.category) u.searchParams.set('category', opts.category.slice(0, 100));
  const offset = Math.floor(Number(opts.offset));
  if (Number.isFinite(offset) && offset > 0) u.searchParams.set('offset', String(offset));
  return u.toString();
}

function categoriesUrl() {
  return `${STORIES_BASE}?categories=1`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// One card per result. Series come back already grouped by the server: series_title,
// chapter_count, series_word_count, and a url pointing at chapter 1.
// Returns null for a result without an http(s) url, since there is nothing to open.
function normalizeStory(r) {
  if (!r || typeof r !== 'object') return null;
  let url;
  try { url = new URL(String(r.url || '')); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const slug = String(r.slug || '');
  const chapters = num(r.chapter_count);
  const year = /^\d{4}/.exec(String(r.date_published || ''));
  return {
    slug,
    title: String(r.series_title || r.title || 'Untitled'),
    author: String(r.author || ''),
    category: String(r.category || ''),
    year: year ? year[0] : '',
    words: num(r.series_word_count) || num(r.word_count) || 0,
    rating: num(r.rating),
    votes: num(r.rating_count),
    tags: Array.isArray(r.tags) ? r.tags.filter(t => typeof t === 'string' && t).slice(0, MAX_TAGS) : [],
    summary: String(r.summary || r.description || ''),
    url: url.toString(),
    chapters: chapters && chapters > 1 ? chapters : null,
    source: slug.startsWith('ao3-') || url.hostname.endsWith('archiveofourown.org') ? 'ao3' : 'lit',
  };
}

function normalizeResponse(json) {
  const results = (Array.isArray(json && json.results) ? json.results : []).map(normalizeStory).filter(Boolean);
  const info = (json && json.query_info) || {};
  const offset = num(info.offset) || 0;
  const pageSize = num(info.page_size) || results.length;
  return { results, hasMore: !!info.has_more, nextOffset: offset + pageSize };
}

// rooms.txt: "<room name> = <category>" per line, # comments. Room keys are lowercased;
// lines with nothing after "=" are left out, so those rooms count as unmapped.
function parseRoomMap(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const room = line.slice(0, eq).trim().toLowerCase();
    const category = line.slice(eq + 1).trim();
    if (room && category) map.set(room, category);
  }
  return map;
}

const LOBBY = 'literotica lobby';

// What [Stories] opens for the active tab: random stories from the room's category, a
// search for the room's name when it has no category, and random stories from every
// category in the lobby or a private chat (room is '').
function storyOptsForRoom(room, roomMap) {
  const name = String(room || '').trim();
  if (!name || name.toLowerCase() === LOBBY) return { random: true };
  const category = roomMap.get(name.toLowerCase());
  return category ? { random: true, category } : { q: name };
}

module.exports = { STORIES_BASE, buildSearchUrl, categoriesUrl, normalizeStory, normalizeResponse, parseRoomMap, storyOptsForRoom };
