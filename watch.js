const fs = require('fs');
const path = require('path');

const WATCH_FILE = path.join(process.env.LIT_USERDATA || __dirname, 'logs', 'watchlist.json');

function loadWatchList() {
  try { return new Set(JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'))); }
  catch { return new Set(); }
}

function saveWatchList(set) {
  fs.mkdirSync(path.dirname(WATCH_FILE), { recursive: true });
  fs.writeFileSync(WATCH_FILE, JSON.stringify([...set], null, 2));
}

module.exports = { loadWatchList, saveWatchList };
