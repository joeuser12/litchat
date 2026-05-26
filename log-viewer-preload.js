const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');
const { readNote, saveNote } = require('./notes');
const { loadWatchList, saveWatchList } = require('./watch');

const LOG_DIR = path.join(process.env.LIT_USERDATA || __dirname, 'logs');

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

function readAllMessages() {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .flatMap(file => {
      const lines = fs.readFileSync(path.join(LOG_DIR, file), 'utf8').split('\n');
      return lines.flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    });
}

contextBridge.exposeInMainWorld('logAPI', {
  listUsers() {
    const users = new Set();
    for (const m of readAllMessages()) {
      const name = peerName(m);
      if (name) users.add(name);
    }
    return [...users].sort();
  },

  queryUser(username) {
    const target = username.toLowerCase();
    return readAllMessages()
      .filter(m => peerName(m) === target)
      .map(m => ({ ...m, fromUser: nickOf(m.from), toUser: nickOf(m.to), room: roomOf(m) }));
  },

  readNote,
  saveNote,

  isWatched(username) {
    return loadWatchList().has(username.toLowerCase());
  },
  setWatched(username, watched) {
    const set = loadWatchList();
    if (watched) set.add(username.toLowerCase());
    else set.delete(username.toLowerCase());
    saveWatchList(set);
  },
});
