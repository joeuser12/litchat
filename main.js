const { app, BrowserWindow, Menu, shell, Notification, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Profile system ─────────────────────────────────────────────────────────
// Must run before any other requires so logger/watch/notes inherit LIT_USERDATA.

const BASE_USERDATA = app.getPath('userData');
const PROFILES_FILE = path.join(BASE_USERDATA, 'profiles.json');

function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')); }
  catch { return null; }
}

function saveProfiles(p) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(p, null, 2));
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
         `p${Date.now()}`;
}

// First-run migration: move the old flat layout into profiles/default/
function migrateToProfiles() {
  const defaultDir = path.join(BASE_USERDATA, 'profiles', 'default');
  fs.mkdirSync(defaultDir, { recursive: true });
  for (const name of ['settings.json', 'user.css', 'user.js', 'logs', 'page-source']) {
    const src = path.join(BASE_USERDATA, name);
    const dst = path.join(defaultDir, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try { fs.renameSync(src, dst); } catch {}
    }
  }
  const p = { active: 'default', list: { default: { name: 'Default' } } };
  saveProfiles(p);
  return p;
}

let profiles = loadProfiles();
if (!profiles) profiles = migrateToProfiles();

// Guard against a stale active profile
if (!profiles.list[profiles.active]) {
  profiles.active = Object.keys(profiles.list)[0] || 'default';
  if (!profiles.list[profiles.active]) profiles.list[profiles.active] = { name: 'Default' };
  saveProfiles(profiles);
}

// --profile <id> selects a profile for simultaneous multi-instance use.
// Packaged app:  LitChat --profile alice              (works directly)
// npm dev:       npm start -- --profile alice         (-- stops npm consuming the flag)
//                LIT_PROFILE_SELECT=alice npm start   (env var alternative)
const CLI_PROFILE = app.commandLine.getSwitchValue('profile') ||
                    (() => { const i = process.argv.indexOf('--profile'); return i !== -1 ? process.argv[i + 1] : ''; })() ||
                    process.env.LIT_PROFILE_SELECT || '';
const ACTIVE_ID   = CLI_PROFILE && profiles.list[CLI_PROFILE] ? CLI_PROFILE : profiles.active;
const PROFILE_DIR = path.join(BASE_USERDATA, 'profiles', ACTIVE_ID);
fs.mkdirSync(PROFILE_DIR, { recursive: true });

// Set before any other requires so preload scripts inherit it
process.env.LIT_USERDATA = PROFILE_DIR;
process.env.LIT_PROFILE  = ACTIVE_ID;

// ── End profile system ─────────────────────────────────────────────────────

const { extractMessages, writeMessages } = require('./logger');
const { loadWatchList, saveWatchList } = require('./watch');

const USER_CSS      = path.join(PROFILE_DIR, 'user.css');
const USER_JS       = path.join(PROFILE_DIR, 'user.js');
const SOURCE_DIR    = path.join(PROFILE_DIR, 'page-source');
const SETTINGS_FILE = path.join(PROFILE_DIR, 'settings.json');
const THEMES_DIR    = path.join(__dirname, 'themes');

function getThemeFile(theme) {
  return path.join(THEMES_DIR, `${theme || 'dark'}.css`);
}

function getPartition(id) {
  // Keep the original partition for 'default' so existing cookies are preserved
  return id === 'default' ? 'persist:litchat' : `persist:litchat-${id}`;
}

const PARTITION = getPartition(ACTIVE_ID);

const THEMES = [
  { id: 'dark',            label: 'Dark' },
  { id: 'dark-warm',       label: 'Dark — Warm' },
  { id: 'dark-teal',       label: 'Dark — Teal' },
  { id: 'light',           label: 'Light' },
  { id: 'nord',            label: 'Nord' },
  { id: 'dracula',         label: 'Dracula' },
  { id: 'gruvbox',         label: 'Gruvbox' },
  { id: 'catppuccin',      label: 'Catppuccin Mocha' },
  { id: 'tokyo-night',     label: 'Tokyo Night' },
  { id: 'rose-pine',       label: 'Rosé Pine' },
  { id: 'solarized-dark',  label: 'Solarized Dark' },
  { id: 'solarized-light', label: 'Solarized Light' },
  { id: 'ocean',           label: 'Ocean' },
  { id: 'rose',            label: 'Rose' },
  { id: 'forest',          label: 'Forest' },
  { id: 'amethyst',        label: 'Amethyst' },
  { id: 'amber',           label: 'Amber' },
  { id: 'midnight',        label: 'Midnight' },
];

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // Migrate darkMode boolean → theme string
    if (s.darkMode !== undefined && !s.theme) {
      s.theme = s.darkMode ? 'dark' : 'light';
      delete s.darkMode;
    }
    return s;
  }
  catch { return { theme: 'dark' }; }
}
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

const settings = loadSettings();
let cssKeys = []; // keys returned by insertCSS; needed to remove on theme change

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

function savedWindowBounds() {
  const ws = settings.windowState;
  if (!ws?.width) return {};
  const { screen } = require('electron');
  const visible = screen.getAllDisplays().some(d =>
    ws.x < d.bounds.x + d.bounds.width  && ws.x + ws.width  > d.bounds.x &&
    ws.y < d.bounds.y + d.bounds.height && ws.y + ws.height > d.bounds.y
  );
  return visible ? { width: ws.width, height: ws.height, x: ws.x, y: ws.y } : {};
}

let winStateSaveTimer = null;
function scheduleWindowStateSave() {
  clearTimeout(winStateSaveTimer);
  winStateSaveTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    if (!maximized) {
      const [x, y] = win.getPosition();
      const [width, height] = win.getSize();
      settings.windowState = { width, height, x, y, maximized: false };
    } else {
      settings.windowState = { ...(settings.windowState || {}), maximized: true };
    }
    saveSettings();
  }, 500);
}

function createWindow() {
  const profileName  = profiles.list[ACTIVE_ID]?.name || 'Default';
  const multiProfile = Object.keys(profiles.list).length > 1;

  win = new BrowserWindow({
    width: 1280,
    height: 900,
    ...savedWindowBounds(),
    title: multiProfile ? `Lit Chat — ${profileName}` : 'Lit Chat',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      partition: PARTITION,
      spellcheck: true,
    },
  });

  if (settings.windowState?.maximized) win.maximize();

  win.on('resize', scheduleWindowStateSave);
  win.on('move',   scheduleWindowStateSave);
  win.on('close',  scheduleWindowStateSave);

  win.loadURL(CHAT_URL);

  win.webContents.on('did-finish-load', async () => {
    if (readyPoll) { clearInterval(readyPoll); readyPoll = null; }
    cssKeys = [];
    presenceNotifyReady = false;
    onlineWatched.clear();

    if (settings.zoomLevel) win.webContents.setZoomLevel(settings.zoomLevel);

    fs.mkdirSync(PROFILE_DIR, { recursive: true });

    // Migrate old seeded user.css (unmodified copy of bundled theme) to a blank
    // customisation starter so the bundled theme can be injected fresh each update.
    const OLD_SEED_HEADER = '/* Custom overrides — injected on every page load. Ctrl+R to preview changes. */';
    const CUSTOM_STARTER  =
      '/* Lit Chat — personal CSS overrides\n' +
      '   Add your rules here to customise the theme. Ctrl+R to preview changes. */\n';
    if (!fs.existsSync(USER_CSS)) {
      fs.writeFileSync(USER_CSS, CUSTOM_STARTER);
    } else if (fs.readFileSync(USER_CSS, 'utf8').startsWith(OLD_SEED_HEADER)) {
      fs.writeFileSync(USER_CSS, CUSTOM_STARTER); // wipe unmodified seed
    }

    const theme = settings.theme || 'dark';
    const LIGHT_THEMES = new Set(['light', 'solarized-light']);
    if (theme !== 'light') {
      // Always inject the bundled theme first so app updates reach everyone
      const themePath = getThemeFile(theme);
      if (fs.existsSync(themePath))
        cssKeys.push(await win.webContents.insertCSS(fs.readFileSync(themePath, 'utf8')));
      // Then layer the user's personal overrides on top
      if (fs.existsSync(USER_CSS))
        cssKeys.push(await win.webContents.insertCSS(fs.readFileSync(USER_CSS, 'utf8')));

      // Remove the baked-in white background from the logo PNG via canvas pixel manipulation.
      // CSS mix-blend-mode cannot cross GPU compositing layer boundaries so JS is required.
      removeLogoBg();
    }

    // For dark-background themes, force the logo SVG paths white regardless of
    // whether the Literotica site itself has dark_theme active (they're independent).
    if (!LIGHT_THEMES.has(theme)) {
      cssKeys.push(await win.webContents.insertCSS(
        '#headerLogo path{fill:white!important}' +
        '#headerLogo .logo__l,#headerLogo .logo__r{fill:#4a89f3!important}'
      ));
    }

    if (fs.existsSync(USER_JS)) {
      win.webContents.executeJavaScript(fs.readFileSync(USER_JS, 'utf8')).catch(() => {});
    }

    // Always strip ads and simplify the site header
    await win.webContents.insertCSS(
      '#SuperHeader{display:none!important}' +
      '.clearfix.C_fv>*:not(.C_fw){display:none!important}' +
      '#BreadCrumbComponent{display:none!important}' +
      '.s_cH{display:none!important}' +
      '.a_a{display:none!important}' +
      '.SAAWidget__container{display:none!important}' +
      '.C_fw{display:flex!important;align-items:center!important;flex-direction:row!important}' +
      '#HeaderComponent .container{padding-top:6px!important;padding-bottom:6px!important}' +
      '.page.clearfix{margin-top:0!important;padding-top:0!important}' +
      '#headerLogoWrap a{pointer-events:none!important;cursor:default!important}' +
      '#candy #chat-statusmessage-control.lit-room-hide{opacity:0.35!important}' +
      '.room-pane.lit-hide-status .infomessage{display:none!important}' +
      '.room-pane.lit-hide-status .message-pane li:has(.infomessage){display:none!important;border:none!important}'
    );

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
        injectNavButtons();
        setupPerRoomStatus();
        injectEmojiPicker();
      }
    }, 500);
  });

  // Profile links open in a child window; everything else goes to the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/www\.literotica\.com\/authors\//.test(url)) {
      openProfileWindow(url);
    } else {
      shell.openExternal(url);
    }
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
    parent: win,
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
}


function setupPerRoomStatus() {
  win.webContents.executeJavaScript(`
    (async function() {
      var btn = document.getElementById('chat-statusmessage-control');
      if (!btn || btn.dataset.litPatched) return;
      btn.dataset.litPatched = '1';

      function getActiveJid() {
        var t = document.querySelector('#chat-tabs li.active[data-roomjid]');
        return t ? t.dataset.roomjid : null;
      }

      function getPaneFor(jid) {
        return document.querySelector('.room-pane[data-roomjid=' + JSON.stringify(jid) + ']');
      }

      async function applyPref(pane) {
        var hidden = await window.litChat.getStatusHidden(pane.dataset.roomjid);
        pane.classList.toggle('lit-hide-status', hidden);
      }

      // Apply saved prefs to all already-open room panes
      var panes = document.querySelectorAll('.room-pane[data-roomjid]');
      for (var i = 0; i < panes.length; i++) await applyPref(panes[i]);

      // CandyChat controls rendering via an internal flag toggled by its click handler.
      // The button starts unchecked (hide mode). Fire one real click BEFORE adding our
      // intercept so CandyChat switches its internal state to "show".
      if (!btn.classList.contains('checked')) {
        btn.click();
      }

      // From here on, capture every click before CandyChat's bubble-phase handler
      // so CandyChat stays permanently in "show all" mode. Per-room hiding is
      // handled entirely by the .lit-hide-status CSS class on the room pane.
      btn.addEventListener('click', async function(e) {
        e.stopImmediatePropagation();
        var jid = getActiveJid();
        if (!jid) return;
        var nowHidden = !(await window.litChat.getStatusHidden(jid));
        await window.litChat.setStatusHidden(jid, nowHidden);
        var pane = getPaneFor(jid);
        if (pane) pane.classList.toggle('lit-hide-status', nowHidden);
        // Dim the button icon when this room is hiding status messages
        btn.classList.toggle('lit-room-hide', nowHidden);
      }, { capture: true });

      // Sync button dim state when switching rooms
      var tabList = document.getElementById('chat-tabs');
      if (tabList) {
        new MutationObserver(async function() {
          var jid = getActiveJid();
          if (!jid) return;
          var hidden = await window.litChat.getStatusHidden(jid);
          btn.classList.toggle('lit-room-hide', hidden);
        }).observe(tabList, { attributes: true, subtree: true, attributeFilter: ['class'] });
      }

      // Apply pref when a new room pane is added (joining a room mid-session)
      var roomsEl = document.getElementById('chat-rooms');
      if (roomsEl) {
        new MutationObserver(function(muts) {
          muts.forEach(function(m) {
            m.addedNodes.forEach(function(n) {
              if (n.nodeType === 1 && n.dataset && n.dataset.roomjid) applyPref(n);
            });
          });
        }).observe(roomsEl, { childList: true });
      }
    })();
  `).catch(() => {});
}

function adjustZoom(delta) {
  const level = delta === 0 ? 0 : win.webContents.getZoomLevel() + delta;
  win.webContents.setZoomLevel(level);
  settings.zoomLevel = win.webContents.getZoomLevel();
  saveSettings();
}

function removeLogoBg() {
  win.webContents.executeJavaScript(`
    (function() {
      var img = document.querySelector('#headerLogoWrap img');
      if (!img) return;
      function process() {
        try {
          if (!img.dataset.litOrigSrc) img.dataset.litOrigSrc = img.src;
          var c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          if (!c.width || !c.height) { setTimeout(process, 200); return; }
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          var id = ctx.getImageData(0, 0, c.width, c.height);
          var d = id.data;
          for (var i = 0; i < d.length; i += 4) {
            if (d[i] > 200 && d[i+1] > 200 && d[i+2] > 200) d[i+3] = 0;
          }
          ctx.putImageData(id, 0, 0);
          img.src = c.toDataURL('image/png');
          img.style.filter = '';
        } catch(e) {
          img.style.filter = 'invert(1)';
        }
      }
      if (img.complete && img.naturalWidth) process();
      else img.addEventListener('load', process, { once: true });
    })();
  `).catch(() => {});
}

function injectEmojiPicker() {
  const CATS = [
    { icon: '😊', title: 'Faces', emoji: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','😍','🤩','😘','🥰','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👻','👽','👾','🤖'] },
    { icon: '👋', title: 'Gestures', emoji: ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✍️','💅','💪','🦾','👀','👁️','👄','💋'] },
    { icon: '❤️', title: 'Hearts', emoji: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','❤️‍🔥','❤️‍🩹','😍','🥰','😘','💑','👫','💌','💍','💒','🌹','🥀','🌷','💐','🎀','🎁'] },
    { icon: '🐶', title: 'Animals', emoji: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🦆','🦅','🦉','🦇','🐺','🐴','🦄','🐝','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🐙','🦑','🦀','🐡','🐠','🐟','🐬','🐳','🦈','🦭','🦓','🐘','🦏','🐪','🦒','🦬','🐎','🐑','🐐','🦌','🐕','🐩','🐈','🦚','🦜','🕊️','🐇','🦝','🦦','🐁','🐿️','🦔','🐾'] },
    { icon: '🌺', title: 'Nature', emoji: ['💐','🌸','💮','🌹','🥀','🌺','🌻','🌼','🌷','🌱','🌿','☘️','🍀','🍃','🍂','🍁','🌾','🌵','🎄','🌲','🌳','🌴','🌙','☀️','🌤️','⛅','🌦️','🌧️','🌩️','⛈️','🌪️','❄️','☃️','🌈','🌊','🌋','⛰️','🏔️','🏝️','🌅','🌄','⭐','🌟','✨','💫','🌕','🌑','🌠','🌌','🌀','🌬️','💧','💦','🔥'] },
    { icon: '🍕', title: 'Food & Drink', emoji: ['🍎','🍊','🍋','🍇','🍓','🍒','🍑','🥭','🍍','🥝','🍅','🥦','🥬','🥒','🌽','🥕','🥐','🍞','🥖','🧀','🥚','🍳','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🌮','🌯','🥙','🍱','🍣','🍤','🍜','🍝','🍛','🍚','🍙','🥮','🍡','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍵','☕','🫖','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧃','🥤','🧋','🍾'] },
    { icon: '🎉', title: 'Fun & Activities', emoji: ['🎉','🎊','🎈','🎁','🎀','🎆','🎇','🎭','🎨','🎪','🎢','🎡','🎠','🎯','🎳','🎲','🎮','🎰','🃏','🀄','♟️','🎸','🎹','🎻','🥁','🎤','🎧','🎬','🎟️','🏆','🥇','🥈','🥉','🏅','⚽','🏀','🏈','⚾','🎾','🏸','🏊','🏄','🚴','🧘','🤸','💃','🕺','🎄','🎃','🎑','🎐','🧨','🪅','🪆','🪄'] },
    { icon: '💫', title: 'Symbols', emoji: ['✅','❌','❓','❗','‼️','💯','🔥','⚡','💧','💨','💎','🔮','🧿','💡','🕯️','⚠️','🚫','⛔','🔞','💤','💢','💥','💦','💫','💬','💭','🗯️','✉️','📩','📱','💻','⌚','📷','🔑','🔒','🔔','📢','♥️','♠️','♦️','♣️','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🏳️','🏴','🚩','🆗','🆙','🆒','🆕','🆓','🔅','🔆','📶'] },
  ];

  win.webContents.executeJavaScript(`(function() {
    if (document.getElementById('lit-emoji-picker')) return;

    var CATS = ${JSON.stringify(CATS)};

    var s = document.createElement('style');
    s.textContent =
      '#lit-emoji-picker{position:fixed;width:308px;background:#1a1a2a;border:1px solid #3a3a4a;' +
      'border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.6);z-index:99999;' +
      'display:none;flex-direction:column;overflow:hidden;font-family:system-ui,sans-serif;}' +
      '#lit-emoji-tabs{display:flex;background:#0f0f17;padding:4px;gap:2px;flex-shrink:0;}' +
      '.lit-emoji-tab{flex:1;padding:5px 0;text-align:center;cursor:pointer;border-radius:5px;' +
      'font-size:15px;opacity:0.5;transition:opacity 0.12s,background 0.12s;}' +
      '.lit-emoji-tab:hover{opacity:0.85;}' +
      '.lit-emoji-tab.active{opacity:1;background:#2a2a3a;}' +
      '#lit-emoji-grid{display:flex;flex-wrap:wrap;padding:6px;gap:1px;' +
      'max-height:240px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#2a2a3a #0f0f17;}' +
      '#lit-emoji-grid::-webkit-scrollbar{width:6px;}' +
      '#lit-emoji-grid::-webkit-scrollbar-track{background:#0f0f17;}' +
      '#lit-emoji-grid::-webkit-scrollbar-thumb{background:#2a2a3a;border-radius:3px;}' +
      '.lit-emoji-item{font-size:20px;width:34px;height:34px;display:flex;align-items:center;' +
      'justify-content:center;cursor:pointer;border-radius:4px;transition:background 0.1s;line-height:1;}' +
      '.lit-emoji-item:hover{background:#2a2a3a;}' +
      '#lit-emoji-trigger{cursor:pointer;width:auto!important;font-size:13px;line-height:16px;opacity:0.7;transition:opacity 0.15s;}' +
      '#lit-emoji-trigger:hover{opacity:1;}';
    document.head.appendChild(s);

    var picker = document.createElement('div');
    picker.id = 'lit-emoji-picker';
    var tabs = document.createElement('div');
    tabs.id = 'lit-emoji-tabs';
    var grid = document.createElement('div');
    grid.id = 'lit-emoji-grid';
    picker.appendChild(tabs);
    picker.appendChild(grid);
    document.body.appendChild(picker);

    function showCategory(idx) {
      tabs.querySelectorAll('.lit-emoji-tab').forEach(function(t, i) {
        t.classList.toggle('active', i === idx);
      });
      grid.innerHTML = '';
      CATS[idx].emoji.forEach(function(e) {
        var span = document.createElement('span');
        span.className = 'lit-emoji-item';
        span.textContent = e;
        span.title = e;
        span.addEventListener('click', function(ev) {
          ev.stopPropagation();
          insertEmoji(e);
        });
        grid.appendChild(span);
      });
      grid.scrollTop = 0;
    }

    CATS.forEach(function(cat, i) {
      var tab = document.createElement('div');
      tab.className = 'lit-emoji-tab';
      tab.textContent = cat.icon;
      tab.title = cat.title;
      tab.addEventListener('click', function(e) { e.stopPropagation(); showCategory(i); });
      tabs.appendChild(tab);
    });

    showCategory(0);

    function getInput() {
      var panes = document.querySelectorAll('.room-pane');
      for (var i = 0; i < panes.length; i++) {
        if (panes[i].offsetParent !== null) {
          var inp = panes[i].querySelector('input[name="message"]');
          if (inp) return inp;
        }
      }
      return document.querySelector('input[name="message"]');
    }

    function insertEmoji(emoji) {
      var input = getInput();
      if (!input) return;
      var start = input.selectionStart != null ? input.selectionStart : input.value.length;
      var end   = input.selectionEnd   != null ? input.selectionEnd   : input.value.length;
      input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
      var pos = start + emoji.length;
      input.setSelectionRange(pos, pos);
      input.focus();
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function togglePicker(triggerEl) {
      if (picker.style.display === 'flex') { picker.style.display = 'none'; return; }
      var rect = triggerEl.getBoundingClientRect();
      var pw = 308, ph = 296;
      var top  = rect.top - ph - 6;
      if (top < 8) top = rect.bottom + 6;
      var left = rect.left + rect.width / 2 - pw / 2;
      if (left < 8) left = 8;
      if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
      picker.style.top  = top  + 'px';
      picker.style.left = left + 'px';
      picker.style.display = 'flex';
    }

    function setupTrigger() {
      if (document.getElementById('lit-emoji-trigger')) return;
      var orig = document.getElementById('emoticons-icon');
      if (!orig) return;
      // Clone to strip the site's own event listeners; inherit all computed styles via same tag+class
      var el = orig.cloneNode(false);
      el.id = 'lit-emoji-trigger';
      el.title = 'Emoji';
      el.textContent = '🙂';
      orig.parentNode.replaceChild(el, orig);
      el.addEventListener('click', function(e) { e.stopPropagation(); togglePicker(el); });
    }

    document.addEventListener('click', function(e) {
      if (!picker.contains(e.target) && e.target.id !== 'lit-emoji-trigger') {
        picker.style.display = 'none';
      }
    }, true);

    setupTrigger();
    new MutationObserver(function() {
      if (!document.getElementById('lit-emoji-trigger')) setupTrigger();
    }).observe(document.body, { childList: true, subtree: true });
  })();`).catch(() => {});
}

function injectNavButtons() {
  const isDark = (settings.theme || 'dark') !== 'light';
  win.webContents.executeJavaScript(`
    (function() {
      var fw = document.querySelector('.C_fw');
      if (!fw || document.getElementById('lit-nav-btns')) return;
      var wrap = document.createElement('div');
      wrap.id = 'lit-nav-btns';
      wrap.style.cssText = 'display:inline-flex;align-items:center;gap:8px;margin-left:16px;';
      var isDark = ${JSON.stringify(isDark)};
      var baseColor  = isDark ? '#aaa'  : '#555';
      var hoverColor = isDark ? '#fff'  : '#000';
      var baseBorder = isDark ? '#333'  : '#ccc';
      var hoverBorder = isDark ? '#666' : '#999';
      function mkBtn(label) {
        var a = document.createElement('a');
        a.textContent = label;
        a.style.cssText = 'color:' + baseColor + ';cursor:pointer;font-size:13px;padding:4px 10px;' +
                          'border:1px solid ' + baseBorder + ';border-radius:4px;text-decoration:none;';
        a.addEventListener('mouseover', function() { a.style.color=hoverColor; a.style.borderColor=hoverBorder; });
        a.addEventListener('mouseout',  function() { a.style.color=baseColor;  a.style.borderColor=baseBorder; });
        return a;
      }
      var roomsBtn = mkBtn('Rooms');
      var logsBtn  = mkBtn('Logs');
      roomsBtn.addEventListener('click', function() { window.litChat && window.litChat.openRooms(); });
      logsBtn.addEventListener('click',  function() { window.litChat && window.litChat.openLogs(); });
      wrap.appendChild(roomsBtn);
      wrap.appendChild(logsBtn);
      fw.appendChild(wrap);
    })();
  `).catch(() => {});
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

function openProfileWindow(url) {
  const w = new BrowserWindow({
    width: 900,
    height: 700,
    parent: win,
    title: 'User Profile',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: PARTITION, // same session = already logged in
    },
  });
  w.setMenu(null);
  w.loadURL(url);
  // Any further links in the profile page go to the system browser
  w.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u);
    return { action: 'deny' };
  });
}

function openRoomManager() {
  if (roomWin && !roomWin.isDestroyed()) { roomWin.focus(); return; }
  roomWin = new BrowserWindow({
    width: 480,
    height: 640,
    title: 'Rooms',
    parent: win,
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

ipcMain.on('rooms:join',  (_e, jid) => { win.show(); win.focus(); joinRoom(jid); });
ipcMain.on('ui:openRooms', () => openRoomManager());
ipcMain.on('ui:openLogs',  () => openLogViewer());

ipcMain.handle('status:getHidden', (_e, jid) => !!(settings.hideStatusRooms?.[jid]));
ipcMain.handle('status:setHidden', (_e, jid, hidden) => {
  if (!settings.hideStatusRooms) settings.hideStatusRooms = {};
  if (hidden) settings.hideStatusRooms[jid] = true;
  else delete settings.hideStatusRooms[jid];
  saveSettings();
});

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

async function setTheme(theme) {
  settings.theme = theme;
  saveSettings();
  for (const k of cssKeys) await win.webContents.removeInsertedCSS(k).catch(() => {});
  cssKeys = [];
  const LIGHT_THEMES = new Set(['light', 'solarized-light']);
  if (theme !== 'light') {
    const themePath = getThemeFile(theme);
    if (fs.existsSync(themePath))
      cssKeys.push(await win.webContents.insertCSS(fs.readFileSync(themePath, 'utf8')));
    if (fs.existsSync(USER_CSS))
      cssKeys.push(await win.webContents.insertCSS(fs.readFileSync(USER_CSS, 'utf8')));
    removeLogoBg();
  } else {
    // Restore original logo src if we previously replaced it
    win.webContents.executeJavaScript(`
      (function() {
        var img = document.querySelector('#headerLogoWrap img');
        if (img && img.dataset.litOrigSrc) { img.src = img.dataset.litOrigSrc; img.style.filter = ''; }
      })();
    `).catch(() => {});
  }
  if (!LIGHT_THEMES.has(theme)) {
    cssKeys.push(await win.webContents.insertCSS(
      '#headerLogo path{fill:white!important}' +
      '#headerLogo .logo__l,#headerLogo .logo__r{fill:#4a89f3!important}'
    ));
  }
  // Re-inject nav buttons with updated theme colours
  await win.webContents.executeJavaScript(
    `var e=document.getElementById('lit-nav-btns');if(e)e.remove();`
  ).catch(() => {});
  injectNavButtons();
  createAppMenu();
}

function switchProfile(id) {
  const { dialog } = require('electron');
  const name = profiles.list[id]?.name || id;
  dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Switch', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Switch Profile',
    message: `Switch to "${name}"?`,
    detail: 'The app will restart to load the new profile.',
  }).then(({ response }) => {
    if (response !== 0) return;
    if (CLI_PROFILE) {
      // Relaunch replacing the --profile arg so this window switches profiles
      const baseArgs = process.argv.slice(1).filter((a, i, arr) =>
        a !== '--profile' && arr[i - 1] !== '--profile'
      );
      app.relaunch({ args: [...baseArgs, '--profile', id] });
    } else {
      profiles.active = id;
      saveProfiles(profiles);
      app.relaunch();
    }
    app.exit();
  });
}

function createProfile() {
  const dialogWin = new BrowserWindow({
    width: 360,
    height: 145,
    parent: win,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'New Profile',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'profile-dialog-preload.js'),
    },
  });
  dialogWin.setMenu(null);
  dialogWin.loadFile('profile-dialog.html');

  const onName = (_e, name) => {
    if (!name || !name.trim()) return;
    name = name.trim();
    let id = slugify(name);
    let n = 2;
    while (profiles.list[id]) id = `${slugify(name)}-${n++}`;
    profiles.list[id] = { name };
    saveProfiles(profiles);
    fs.mkdirSync(path.join(BASE_USERDATA, 'profiles', id), { recursive: true });
    createAppMenu();
  };

  ipcMain.once('profile:new-name', onName);
  dialogWin.on('closed', () => ipcMain.removeListener('profile:new-name', onName));
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

  const currentTheme = settings.theme || 'dark';
  const themeItems = THEMES.map(({ id, label }) => ({
    label,
    type: 'radio',
    checked: currentTheme === id,
    click: () => setTheme(id),
  }));

  const profileItems = [
    ...Object.entries(profiles.list).map(([id, { name }]) => ({
      label: name,
      type: 'radio',
      checked: id === ACTIVE_ID,
      click: () => { if (id !== ACTIVE_ID) switchProfile(id); },
    })),
    { type: 'separator' },
    { label: 'New Profile…', click: () => createProfile() },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Lit Chat',
      submenu: [
        { label: 'View Logs',  click: () => openLogViewer() },
        { label: 'Rooms', submenu: roomItems },
        { type: 'separator' },
        { label: 'Theme',   submenu: themeItems },
        { label: 'Profile', submenu: profileItems },
        { type: 'separator' },
        { label: 'Reload',    accelerator: 'CmdOrCtrl+R',      click: () => win.webContents.reload(), visible: false },
        { label: 'ZoomIn',    accelerator: 'CmdOrCtrl+shift+=', click: () => adjustZoom(+0.5), visible: false },
        { label: 'ZoomIn2',   accelerator: 'CmdOrCtrl+=',       click: () => adjustZoom(+0.5), visible: false },
        { label: 'ZoomOut',   accelerator: 'CmdOrCtrl+shift+-', click: () => adjustZoom(-0.5), visible: false },
        { label: 'ZoomOut2',  accelerator: 'CmdOrCtrl+-',       click: () => adjustZoom(-0.5), visible: false },
        { label: 'ZoomReset', accelerator: 'CmdOrCtrl+shift+0', click: () => adjustZoom(0),    visible: false },
        { label: 'ZoomReset2',accelerator: 'CmdOrCtrl+0',       click: () => adjustZoom(0),    visible: false },
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

  if (app.isPackaged) {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', () => {
      const { dialog } = require('electron');
      dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['Restart & Update', 'Later'],
        defaultId: 0, cancelId: 1,
        title: 'Update Ready',
        message: 'A new version of Lit Chat has been downloaded.',
        detail: 'Restart now to apply the update.',
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
    });
    autoUpdater.checkForUpdates().catch(() => {});
  }

  // Silence the site's broken favicon requests
  const { session } = require('electron');
  session.fromPartition(PARTITION).webRequest.onBeforeRequest(
    { urls: ['*://*/favicon.png', '*://*/favicon.ico'] },
    (details, callback) => {
      if (details.url.includes('favicon')) callback({ cancel: true });
      else callback({});
    }
  );
});

app.on('window-all-closed', () => app.quit());
