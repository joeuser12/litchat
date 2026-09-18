// LitChat's own ignore list. Candy's native ignore stores room-occupant JIDs
// (room@conference/Nick) in a per-session XEP-0016 privacy list, so it only
// holds in the one room where it was clicked. On this site a nick IS the
// Literotica account name, so the list here is keyed by lowercased nick and
// applies everywhere: every room, private messages, notifications.
const fs = require('fs');
const path = require('path');

const IGNORE_FILE = path.join(process.env.LIT_USERDATA || __dirname, 'ignorelist.json');

function normNick(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// Map of lowercased nick → the name as it was first given (for display).
function loadIgnoreList(file = IGNORE_FILE) {
  const map = new Map();
  try {
    for (const name of JSON.parse(fs.readFileSync(file, 'utf8'))) addTo(map, name);
  } catch { /* missing or unreadable → empty list */ }
  return map;
}

function saveIgnoreList(map, file = IGNORE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...map.values()].sort((a, b) => a.localeCompare(b)), null, 2));
}

// Both return true when the list actually changed.
function addTo(map, name) {
  const key = normNick(name);
  if (!key || map.has(key)) return false;
  map.set(key, String(name).trim());
  return true;
}

function removeFrom(map, name) {
  return map.delete(normNick(name));
}

module.exports = { loadIgnoreList, saveIgnoreList, addTo, removeFrom, normNick };
