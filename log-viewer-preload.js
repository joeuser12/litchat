const { contextBridge, ipcRenderer } = require('electron');
const { readNote, saveNote } = require('./notes');
const { loadWatchList } = require('./watch');
const { nickOf, roomOf, peerName, msgSig, readAllMessages } = require('./logstore');

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

  // The `limit` most recent DM partners, each with at most `perPeer` of their
  // latest messages (and the `total` logged). Opening Chat Logs used to decorate
  // every DM ever logged and render each of these partners' complete history.
  recentDMs(limit = 15, perPeer = 200) {
    const groups = new Map();
    for (const m of readAllMessages(m => m.type === 'chat')) {
      const peer = peerName(m);
      if (!peer) continue;
      if (!groups.has(peer)) groups.set(peer, []);
      groups.get(peer).push(m);
    }
    return [...groups.entries()]
      .map(([peer, msgs]) => ({ peer, msgs, lastTs: msgs[msgs.length - 1].ts }))
      .sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0))
      .slice(0, limit)
      .map(({ peer, msgs }) => ({
        peer,
        total: msgs.length,
        messages: msgs.slice(-perPeer).map(m => ({ ...decorate(m), room: null })),
      }));
  },

  // Deletes run on the main process, where new messages are appended (see rewriteLogs).
  deleteMessages(sigs) {
    return ipcRenderer.invoke('logs:deleteMessages', sigs);
  },

  deleteGroup(username, room) {
    return ipcRenderer.invoke('logs:deleteGroup', username, room);
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
  // Through the main process, which owns the watch list (see watchUser in main.js).
  setWatched(username, watched) {
    return ipcRenderer.invoke('watch:set', username, !!watched);
  },
});
