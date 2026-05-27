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

function msgSig(m) {
  return m.ts + '|' + m.direction + '|' + (m.body || '').slice(0, 80);
}

function rewriteLogs(keep) {
  if (!fs.existsSync(LOG_DIR)) return;
  for (const file of fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.jsonl'))) {
    const filepath = path.join(LOG_DIR, file);
    const lines = fs.readFileSync(filepath, 'utf8').split('\n').filter(l => l.trim());
    const kept = lines.filter(line => {
      try { return keep(JSON.parse(line)); } catch { return true; }
    });
    if (kept.length !== lines.length) {
      fs.writeFileSync(filepath, kept.length ? kept.join('\n') + '\n' : '');
    }
  }
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
      .map(m => ({ ...m, sig: msgSig(m), fromUser: nickOf(m.from), toUser: nickOf(m.to), room: roomOf(m) }));
  },

  recentDMs(limit = 15) {
    const msgs = readAllMessages().filter(m => m.type === 'chat');
    const groups = new Map();
    for (const m of msgs) {
      const peer = peerName(m);
      if (!peer) continue;
      if (!groups.has(peer)) groups.set(peer, []);
      groups.get(peer).push({ ...m, sig: msgSig(m), fromUser: nickOf(m.from), toUser: nickOf(m.to), room: null });
    }
    return [...groups.entries()]
      .map(([peer, messages]) => ({ peer, messages, lastTs: messages[messages.length - 1].ts }))
      .sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0))
      .slice(0, limit);
  },

  deleteMessages(sigs) {
    const sigSet = new Set(sigs);
    rewriteLogs(m => !sigSet.has(msgSig(m)));
  },

  deleteGroup(username, room) {
    const target = username.toLowerCase();
    rewriteLogs(m => {
      if (peerName(m) !== target) return true;
      if (room === null) return roomOf(m) !== null;   // keep non-DMs
      return roomOf(m) !== room;                       // keep other rooms
    });
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
