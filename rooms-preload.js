const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('roomsAPI', {
  // Fetch the live room list from the chat window
  getRooms: ()           => ipcRenderer.invoke('rooms:list'),
  // Join a room in the chat window
  joinRoom: (jid)        => ipcRenderer.send('rooms:join', jid),
  // Favourites / settings
  getFavourites: ()      => ipcRenderer.invoke('rooms:getFavourites'),
  setFavourite: (jid, name, val) => ipcRenderer.invoke('rooms:setFavourite', jid, name, val),
  setAutoJoin:  (jid, val)       => ipcRenderer.invoke('rooms:setAutoJoin',  jid, val),
});
