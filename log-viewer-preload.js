const { contextBridge } = require('electron');
const { readNote, saveNote } = require('./notes');
const { loadWatchList, saveWatchList } = require('./watch');
const { nickOf, roomOf, peerName, readAllMessages, rewriteLogs } = require('./logstore');

function msgSig(m) {
  return m.ts + '|' + m.direction + '|' + (m.body || '').slice(0, 80);
}

function decorate(m) {
  return { ...m, sig: msgSig(m), fromUser: nickOf(m.from), toUser: nickOf(m.to), room: roomOf(m) };
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
    return readAllMessages(m => peerName(m) === target).map(decorate);
  },

  recentDMs(limit = 15) {
    const groups = new Map();
    for (const m of readAllMessages(m => m.type === 'chat')) {
      const peer = peerName(m);
      if (!peer) continue;
      if (!groups.has(peer)) groups.set(peer, []);
      groups.get(peer).push({ ...decorate(m), room: null });
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

  searchMessages(query, limit = 300) {
    if (!query || query.trim().length < 2) return [];
    const q = query.toLowerCase();
    const msgs = readAllMessages(m => m.body && m.body.toLowerCase().includes(q));
    return msgs.slice(-limit).map(decorate);
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
