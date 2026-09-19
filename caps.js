// Which chat partners are also running LitChat.
//
// The site offers no capability discovery (no XEP-0030/0115), and a chat
// partner's resource is always "/Candy" whether they use a browser or this app,
// so a session cannot be identified from its JID. Instead two LitChat instances
// recognise each other over an invisible in-band handshake — see injectCaps() in
// main.js for the wire format and why it stays invisible to everyone else.
//
// Keyed by lowercased nick, like the ignore list: on this site a nick IS the
// Literotica account name, so capability follows the person across rooms and
// private chats rather than being tied to one occupant JID.
const fs = require('fs');
const path = require('path');

const CAPS_FILE = path.join(process.env.LIT_USERDATA || __dirname, 'peercaps.json');

function normNick(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// Map of lowercased nick → { name, version, lastSeen }.
// `name` keeps the nick as first seen, for display; `version` is the peer's
// handshake protocol version, so a future revision can tell old peers apart.
function loadCaps(file = CAPS_FILE) {
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of Array.isArray(raw) ? raw : []) {
      const key = normNick(e && e.name);
      if (key) map.set(key, { name: String(e.name).trim(), version: String(e.version || '?'), lastSeen: e.lastSeen || null });
    }
  } catch { /* missing or unreadable → nobody known yet */ }
  return map;
}

function saveCaps(map, file = CAPS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

// Returns true when the stored entry actually changed, so callers can skip a
// disk write on the (common) repeat handshake with an already-known peer.
function recordCap(map, name, version) {
  const key = normNick(name);
  if (!key) return false;
  const v = String(version == null ? '?' : version);
  const prev = map.get(key);
  map.set(key, { name: String(name).trim(), version: v, lastSeen: new Date().toISOString() });
  return !prev || prev.version !== v;
}

function hasCap(map, name) {
  return map.has(normNick(name));
}

function forgetCap(map, name) {
  return map.delete(normNick(name));
}

module.exports = { loadCaps, saveCaps, recordCap, hasCap, forgetCap, normNick, CAPS_FILE };
