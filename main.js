const { app, BrowserWindow, Menu, shell, Notification, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Set before any other requires so preload scripts inherit it
process.env.LIT_USERDATA = app.getPath('userData');

const { extractMessages, writeMessages } = require('./logger');
const { loadWatchList, saveWatchList } = require('./watch');

const USER_CSS      = path.join(process.env.LIT_USERDATA, 'user.css');
const USER_JS       = path.join(process.env.LIT_USERDATA, 'user.js');
const SOURCE_DIR    = path.join(process.env.LIT_USERDATA, 'page-source');
const SETTINGS_FILE = path.join(process.env.LIT_USERDATA, 'settings.json');
const BUNDLED_CSS   = path.join(__dirname, 'user.css'); // read-only default shipped with the app

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return { darkMode: true }; }
}
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

const settings = loadSettings();
let cssKey = null; // key returned by insertCSS; needed to remove it

let watchList = loadWatchList();           // Set of lowercased nicks to watch
let onlineWatched = new Set();             // currently-online watched nicks this session
let presenceNotifyReady = false;           // false during startup roster flood

// Must be set before app is ready to prevent BOSH keepalive starvation
// when the window is minimized or hidden.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const CHAT_URL = 'https://chat.literotica.com';

function nickOf(jid) {
  if (!jid) return jid;
  const slash = jid.indexOf('/');
  if (slash !== -1) return jid.slice(slash + 1) || jid;
  const at = jid.indexOf('@');
  return at !== -1 ? jid.slice(0, at) : jid;
}

function notifyDMs(messages) {
  for (const m of messages) {
    if (m.type !== 'chat' || m.direction !== 'received') continue;
    const nick = nickOf(m.from);
    sendNotification({
      title: `DM from ${nick}`,
      body: m.body.length > 120 ? m.body.slice(0, 120) + '…' : m.body,
    });
  }
}

// Extracts presence stanzas from a BOSH XML body.
// Handles both self-closing (<presence .../>) and element form (<presence ...>).
function extractPresence(xml) {
  const out = [];
  const re = /<presence\b([^>]*?)(?:\/>|>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const from = (attrs.match(/\bfrom=["']([^"']+)["']/) || [])[1];
    const type = (attrs.match(/\btype=["']([^"']+)["']/) || [])[1] || 'available';
    if (from && (type === 'available' || type === 'unavailable')) {
      out.push({ nick: nickOf(from).toLowerCase(), from, type });
    }
  }
  return out;
}

function handlePresence(presences) {
  watchList = loadWatchList(); // pick up any changes made via the log viewer
  for (const p of presences) {
    const { nick, type } = p;
    if (!watchList.has(nick)) continue;

    if (type === 'available' && !onlineWatched.has(nick)) {
      onlineWatched.add(nick);
      if (!presenceNotifyReady) continue; // suppress startup roster flood
      sendNotification({ title: 'Now online', body: nick });
    } else if (type === 'unavailable' && onlineWatched.has(nick)) {
      onlineWatched.delete(nick);
      if (!presenceNotifyReady) continue;
      sendNotification({ title: 'Went offline', body: nick });
    }
  }
}

let win;
let logWin  = null;
let roomWin = null;
let readyPoll = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Lit Chat',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Persist session across restarts so BOSH reconnects with existing cookies
      partition: 'persist:litchat',
    },
  });

  win.loadURL(CHAT_URL);

  win.webContents.on('did-finish-load', async () => {
    if (readyPoll) { clearInterval(readyPoll); readyPoll = null; }
    cssKey = null;
    presenceNotifyReady = false;
    onlineWatched.clear();

    // Seed user.css into userData on first run
    fs.mkdirSync(process.env.LIT_USERDATA, { recursive: true });
    if (!fs.existsSync(USER_CSS) && fs.existsSync(BUNDLED_CSS)) {
      fs.copyFileSync(BUNDLED_CSS, USER_CSS);
    }

    if (settings.darkMode && fs.existsSync(USER_CSS)) {
      cssKey = await win.webContents.insertCSS(fs.readFileSync(USER_CSS, 'utf8'));
    }
    if (fs.existsSync(USER_JS)) {
      win.webContents.executeJavaScript(fs.readFileSync(USER_JS, 'utf8')).catch(() => {});
    }

    // Poll for the chat UI to be ready (login complete + Candy initialised).
    // #roomPanel-tab only exists once the user is logged in and the room bar has rendered.
    let tries = 0;
    readyPoll = setInterval(async () => {
      let ready = false;
      try {
        ready = await win.webContents.executeJavaScript(
          `!!document.querySelector('#roomPanel-tab')`
        );
      } catch {}
      if (ready || ++tries > 240) { // give up after ~2 min
        clearInterval(readyPoll);
        readyPoll = null;
        if (!ready) return;
        const autoJoins = Object.entries(settings.favourites || {})
          .filter(([, v]) => v.autoJoin);
        for (const [jid] of autoJoins) joinRoom(jid);
        // Suppress presence notifications briefly while the initial roster flood passes
        setTimeout(() => { presenceNotifyReady = true; }, 5000);
      }
    }, 500);
  });

  // Open external links in the system browser, not a new Electron window
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

}

function openLogViewer() {
  if (logWin && !logWin.isDestroyed()) {
    logWin.focus();
    return;
  }
  logWin = new BrowserWindow({
    width: 700,
    height: 600,
    title: 'Chat Logs',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'log-viewer-preload.js'),
    },
  });
  logWin.loadFile('log-viewer.html');
  logWin.on('closed', () => { logWin = null; });
}

async function savePageSource() {
  fs.mkdirSync(SOURCE_DIR, { recursive: true });

  // Full rendered DOM
  const html = await win.webContents.executeJavaScript(
    'document.documentElement.outerHTML'
  );
  fs.writeFileSync(path.join(SOURCE_DIR, 'page.html'), html);

  // Fetch each stylesheet from inside the app session (bypasses CDN CORS restrictions)
  const sheetUrls = await win.webContents.executeJavaScript(
    'Array.from(document.styleSheets).map(s => s.href).filter(Boolean)'
  );
  const cssChunks = [];
  for (const url of sheetUrls) {
    try {
      const resp = await win.webContents.session.fetch(url);
      const text = await resp.text();
      cssChunks.push(`/* === ${url} === */\n${text}`);
    } catch (e) {
      cssChunks.push(`/* === ${url} (failed: ${e.message}) === */`);
    }
  }
  fs.writeFileSync(path.join(SOURCE_DIR, 'styles.css'), cssChunks.join('\n\n'));

  // Starter user.css if it doesn't exist yet
  if (!fs.existsSync(USER_CSS)) {
    fs.writeFileSync(USER_CSS,
      '/* Custom overrides for chat.literotica.com\n' +
      '   Injected on every page load. Edit and reload (Ctrl+R) to preview. */\n'
    );
  }
}


function joinRoom(jid) {
  win.webContents.executeJavaScript(
    `(function(jid){
       // 1. Already in the roombar — click its tab to switch to it
       var tab = document.querySelector('li[data-roomjid=' + JSON.stringify(jid) + '] a.label');
       if (tab) { tab.click(); return; }

       // 2. Open the room panel, click the matching entry, then dismiss the modal
       var tryClick = function() {
         var links = document.querySelectorAll('ul.simplePaginationChatRoomList li a');
         for (var i = 0; i < links.length; i++) {
           var href = (links[i].getAttribute('href') || '').replace(/^#/, '');
           if (href === jid) {
             links[i].click();
             // Dismiss only after the click has been processed
             setTimeout(function() {
               var m = document.getElementById('chat-modal');
               var o = document.getElementById('chat-modal-overlay');
               if (m) m.style.display = 'none';
               if (o) o.style.display = 'none';
             }, 600);
             return true;
           }
         }
         return false;
       };

       if (!tryClick()) {
         document.querySelector('#roomPanel-tab a.label')?.click();
         var tries = 0;
         var poll = setInterval(function() {
           if (tryClick() || ++tries > 30) clearInterval(poll);
         }, 100);
       }
     })(${JSON.stringify(jid)})`
  ).catch(() => {});
}

function openRoomManager() {
  if (roomWin && !roomWin.isDestroyed()) { roomWin.focus(); return; }
  roomWin = new BrowserWindow({
    width: 480,
    height: 640,
    title: 'Rooms',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'rooms-preload.js'),
    },
  });
  roomWin.loadFile('rooms.html');
  roomWin.on('closed', () => { roomWin = null; createAppMenu(); }); // refresh menu on close
}

ipcMain.handle('rooms:list', async () => {
  try {
    // Open the room panel if not already open
    await win.webContents.executeJavaScript(`
      (function() {
        var list = document.querySelector('ul.simplePaginationChatRoomList');
        if (!list || list.children.length === 0)
          document.querySelector('#roomPanel-tab a.label')?.click();
      })()
    `);
    // Poll until the list is populated (up to 5 seconds)
    const rooms = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        let tries = 0;
        function attempt() {
          const items = Array.from(document.querySelectorAll('ul.simplePaginationChatRoomList li a'));
          if (items.length || tries++ > 49) {
            resolve(items.map(a => ({
              jid:   (a.getAttribute('href') || '').replace(/^#/, ''),
              name:  a.querySelector('.roomName')?.textContent?.trim() ?? '',
              count: parseInt(a.querySelector('.roomCounter')?.textContent) || 0,
            })).filter(r => r.jid && r.name));
          } else {
            setTimeout(attempt, 100);
          }
        }
        attempt();
      })
    `);
    return rooms;
  } catch { return []; }
});

ipcMain.on('rooms:join', (_e, jid) => { win.show(); win.focus(); joinRoom(jid); });

ipcMain.handle('rooms:getFavourites', () => settings.favourites ?? {});

ipcMain.handle('rooms:setFavourite', (_e, jid, name, val) => {
  if (!settings.favourites) settings.favourites = {};
  if (val) settings.favourites[jid] = { name, autoJoin: settings.favourites[jid]?.autoJoin ?? false };
  else delete settings.favourites[jid];
  saveSettings();
  createAppMenu();
});

ipcMain.handle('rooms:setAutoJoin', (_e, jid, val) => {
  if (!settings.favourites?.[jid]) return;
  settings.favourites[jid].autoJoin = val;
  saveSettings();
  createAppMenu();
});

async function toggleDarkMode() {
  settings.darkMode = !settings.darkMode;
  saveSettings();
  if (settings.darkMode) {
    if (fs.existsSync(USER_CSS)) {
      cssKey = await win.webContents.insertCSS(fs.readFileSync(USER_CSS, 'utf8'));
    }
  } else {
    if (cssKey) {
      await win.webContents.removeInsertedCSS(cssKey).catch(() => {});
      cssKey = null;
    }
  }
  createAppMenu(); // rebuild to update checkmark
}

function sendNotification({ title, body }) {
  const { execFile } = require('child_process');

  if (process.platform === 'linux') {
    // Electron's Notification silently fails on many Linux setups; prefer notify-send.
    // Pass D-Bus session env vars so notify-send can reach the notification daemon.
    const env = Object.assign({}, process.env);
    execFile('notify-send', ['--app-name=Lit Chat', title, body], { env }, err => {
      if (err) {
        // notify-send failed — fall back to Electron
        if (Notification.isSupported()) {
          const n = new Notification({ title, body });
          n.on('click', () => { win.show(); win.focus(); });
          n.show();
        }
      }
    });
    return;
  }

  if (Notification.isSupported()) {
    const n = new Notification({ title, body });
    n.on('click', () => { win.show(); win.focus(); });
    n.show();
  }
}

function sendTestNotification() {
  const { dialog } = require('electron');

  const supported = Notification.isSupported();
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Notification test',
    message: `Notification.isSupported() = ${supported}\nAttempting to send a notification now…`,
  });

  sendNotification({
    title: 'DM from testuser',
    body: 'This is a test notification from Lit Chat.',
  });
}

function createAppMenu() {
  const favs = Object.entries(settings.favourites ?? {});
  const roomItems = favs.length
    ? [
        ...favs.map(([jid, { name }]) => ({
          label: name,
          click: () => { win.show(); win.focus(); joinRoom(jid); },
        })),
        { type: 'separator' },
        { label: 'Manage Rooms…', click: () => openRoomManager() },
      ]
    : [{ label: 'Manage Rooms…', click: () => openRoomManager() }];

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Lit Chat',
      submenu: [
        { label: 'View Logs',  click: () => openLogViewer() },
        { label: 'Rooms', submenu: roomItems },
        { type: 'separator' },
        { label: 'Dark Mode', type: 'checkbox', checked: settings.darkMode, click: () => toggleDarkMode() },
        { type: 'separator' },
        { label: 'Save Page Source', click: () => savePageSource() },
        { label: 'DevTools', click: () => win.webContents.openDevTools() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
  ]));
}

function attachBOSHLogger() {
  const dbg = win.webContents.debugger;
  try {
    dbg.attach('1.3');
  } catch (e) {
    // already attached (e.g. DevTools open)
  }
  dbg.sendCommand('Network.enable');

  // Track requestIds so we can fetch POST bodies for outgoing messages
  const pendingRequests = new Map();

  dbg.on('message', async (_e, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const { requestId, request } = params;
      if (request.method === 'POST' && request.postData) {
        pendingRequests.set(requestId, request.postData);
      }
    }

    if (method === 'Network.responseReceived') {
      const { requestId, response } = params;
      const ct = response.mimeType || '';
      if (!ct.includes('xml') && !ct.includes('html')) {
        pendingRequests.delete(requestId);
        return;
      }

      // Log sent messages from the request body
      const sent = pendingRequests.get(requestId);
      if (sent) {
        writeMessages(extractMessages(sent, 'sent'));
        pendingRequests.delete(requestId);
      }

      // Log received messages from the response body
      try {
        const result = await dbg.sendCommand('Network.getResponseBody', { requestId });
        const body = result.base64Encoded
          ? Buffer.from(result.body, 'base64').toString('utf8')
          : result.body;
        const received = extractMessages(body, 'received');
        writeMessages(received);
        notifyDMs(received);
        handlePresence(extractPresence(body));
      } catch (_) {}
    }
  });
}

app.whenReady().then(() => {
  createAppMenu();
  createWindow();
  attachBOSHLogger();

  // Silence the site's broken favicon requests
  const { session } = require('electron');
  session.fromPartition('persist:litchat').webRequest.onBeforeRequest(
    { urls: ['*://*/favicon.png', '*://*/favicon.ico'] },
    (details, callback) => {
      if (details.url.includes('favicon')) callback({ cancel: true });
      else callback({});
    }
  );
});

app.on('window-all-closed', () => app.quit());

