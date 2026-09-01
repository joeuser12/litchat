// logstore.js — the single reader for the chat logs (logs/chat-YYYY-MM-DD.jsonl).
//
// Every consumer used to re-read and JSON.parse every log file on every call
// (main process: DM history, photo gallery, away-reply context; log viewer:
// every list, query and search). On the main process that is synchronous work,
// so once logs reached tens of MB, opening a DM tab visibly froze the app and
// stalled the CDP message logger behind it.
//
// Files are parsed once and cached keyed by (size, mtime); on later calls only
// files that changed — in practice just today's — are re-parsed. Cached
// message objects are shared between calls: treat them as read-only and copy
// before annotating (see logs:dmHistory in main.js).
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.env.LIT_USERDATA || __dirname, 'logs');

// Upper bound on how many *source* bytes we keep parsed in memory. Below this
// (the common case) every file stays cached for the life of the process; above
// it the least-recently-used files are dropped and re-parsed on demand, so a
// very large history costs time rather than unbounded memory.
const CACHE_BYTES_CAP = 48 * 1024 * 1024;

const fileCache = new Map();   // filename → { size, mtimeMs, msgs, lastUsed }
let cachedBytes = 0;
let useCounter = 0;

// ── JID helpers ──────────────────────────────────────────────────────────────

// The nick is always the resource after '/' when present:
//   "nudist@conference.server/arizona527" → "arizona527"
//   "arizona527@server"                  → "arizona527"
function nickOf(jid) {
  if (!jid) return null;
  const slash = jid.indexOf('/');
  if (slash !== -1) return jid.slice(slash + 1).toLowerCase() || null;
  const at = jid.indexOf('@');
  return (at !== -1 ? jid.slice(0, at) : jid).toLowerCase() || null;
}

// Extracts the room name from a groupchat JID's local part.
// XMPP escapes spaces as \20: "literotica\20lobby@..." → "literotica lobby"
function roomOf(m) {
  if (m.type !== 'groupchat') return null;
  const jid = m.direction === 'received' ? m.from : m.to;
  if (!jid) return null;
  const at = jid.indexOf('@');
  const local = at !== -1 ? jid.slice(0, at) : jid;
  return local.replace(/\\20/g, ' ').replace(/\\22/g, '"').replace(/\\26/g, '&')
              .replace(/\\27/g, "'").replace(/\\3a/g, ':').replace(/\\40/g, '@');
}

// Returns the "other person" for a message.
// Sent groupchat is addressed to the room (no resource), so skip it.
function peerName(m) {
  if (m.type === 'groupchat' && m.direction === 'sent') return null;
  const jid = m.direction === 'sent' ? m.to : m.from;
  return nickOf(jid);
}

// ── File cache ───────────────────────────────────────────────────────────────

function logFiles() {
  let names;
  try { names = fs.readdirSync(LOG_DIR); } catch { return []; }
  return names.filter(f => f.endsWith('.jsonl')).sort();
}

function parseFile(filepath) {
  const msgs = [];
  for (const line of fs.readFileSync(filepath, 'utf8').split('\n')) {
    if (!line) continue;
    try { msgs.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  return msgs;
}

function evictIfNeeded() {
  while (cachedBytes > CACHE_BYTES_CAP && fileCache.size > 1) {
    let oldestName = null, oldest = null;
    for (const [name, e] of fileCache) {
      if (!oldest || e.lastUsed < oldest.lastUsed) { oldestName = name; oldest = e; }
    }
    fileCache.delete(oldestName);
    cachedBytes -= oldest.size;
  }
}

function fileMessages(name) {
  const filepath = path.join(LOG_DIR, name);
  let st;
  try { st = fs.statSync(filepath); }
  catch { invalidate(name); return []; }
  let e = fileCache.get(name);
  if (!e || e.size !== st.size || e.mtimeMs !== st.mtimeMs) {
    if (e) cachedBytes -= e.size;
    e = { size: st.size, mtimeMs: st.mtimeMs, msgs: parseFile(filepath), lastUsed: 0 };
    fileCache.set(name, e);
    cachedBytes += st.size;
  }
  e.lastUsed = ++useCounter;
  return e.msgs;
}

function invalidate(name) {
  const e = fileCache.get(name);
  if (!e) return;
  fileCache.delete(name);
  cachedBytes -= e.size;
}

// ISO-8601 UTC strings from toISOString() compare correctly as plain strings;
// localeCompare is ~10x slower and matters at hundreds of thousands of lines.
function byTs(a, b) {
  const x = a.ts || '', y = b.ts || '';
  return x < y ? -1 : x > y ? 1 : 0;
}

// ── Public API ───────────────────────────────────────────────────────────────

// All messages (optionally pre-filtered) sorted oldest-first by ts. Returns a
// fresh array each call. Log-file append order isn't chronological (received
// messages are logged asynchronously and delay-stamped replays carry old
// timestamps into today's file), so callers must never rely on file order.
function readAllMessages(filter) {
  const out = [];
  for (const name of logFiles()) {
    for (const m of fileMessages(name)) {
      if (!filter || filter(m)) out.push(m);
    }
  }
  evictIfNeeded();
  out.sort(byTs);
  return out;
}

// DMs exchanged with `username` (case-insensitive nick), oldest first.
function messagesWithPeer(username) {
  const target = String(username || '').toLowerCase();
  if (!target) return [];
  return readAllMessages(m => m.type === 'chat' && peerName(m) === target);
}

// Rewrite every log file keeping only messages for which keep(m) is true.
// Used by the log viewer's delete actions.
function rewriteLogs(keep) {
  for (const name of logFiles()) {
    const filepath = path.join(LOG_DIR, name);
    const lines = fs.readFileSync(filepath, 'utf8').split('\n').filter(l => l.trim());
    const kept = lines.filter(line => {
      try { return keep(JSON.parse(line)); } catch { return true; }
    });
    if (kept.length !== lines.length) {
      fs.writeFileSync(filepath, kept.length ? kept.join('\n') + '\n' : '');
      invalidate(name);
    }
  }
}

module.exports = { LOG_DIR, nickOf, roomOf, peerName, readAllMessages, messagesWithPeer, rewriteLogs };
