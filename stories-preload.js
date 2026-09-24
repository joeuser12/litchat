const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storiesAPI', {
  // { q, category, random, morelike, offset } → { results, hasMore, nextOffset } or { error }
  search:     (opts) => ipcRenderer.invoke('stories:search', opts),
  categories: ()     => ipcRenderer.invoke('stories:categories'),
  // The chat's Stories button pressed while this window is already open
  onRun:      (cb)   => ipcRenderer.on('stories:run', (_e, opts) => cb(opts)),
  onBack:     (cb)   => ipcRenderer.on('stories:back', () => cb()),
});
