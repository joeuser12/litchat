const { app, BrowserWindow, Menu, Tray, nativeImage, shell, Notification, ipcMain, protocol, session } = require('electron');
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

const USER_CSS        = path.join(PROFILE_DIR, 'user.css');
const USER_JS         = path.join(PROFILE_DIR, 'user.js');
const SOURCE_DIR      = path.join(PROFILE_DIR, 'page-source');
const SETTINGS_FILE   = path.join(PROFILE_DIR, 'settings.json');
const THUMBS_DIR      = path.join(PROFILE_DIR, 'thumbs');
const PHOTO_META_FILE = path.join(PROFILE_DIR, 'photo-meta.json');
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
  { id: 'warm-rose',       label: 'Warm Rose' },
  { id: 'blue-steel',      label: 'Blue Steel' },
  { id: 'sage',            label: 'Sage' },
  { id: 'lavender',        label: 'Lavender' },
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

// photo-meta: maps image hash → { nativeUrl } for linked images so thumbnails survive album expiry
let photoMeta = {};
try { photoMeta = JSON.parse(fs.readFileSync(PHOTO_META_FILE, 'utf8')); } catch {}
function savePhotoMeta() {
  try { fs.writeFileSync(PHOTO_META_FILE, JSON.stringify(photoMeta)); } catch {}
}
let cssKeys = []; // keys returned by insertCSS; needed to remove on theme change

let watchList = loadWatchList();           // Set of lowercased nicks to watch
let onlineWatched = new Set();             // currently-online watched nicks this session
let presenceNotifyReady = false;           // false during startup roster flood
let awayRepliedTo = new Set();             // JIDs already sent an away-reply this away session

const ROOM_IDLE_MS     = 5 * 60 * 1000;   // 5-minute idle window for room notifications
const roomLastJoin    = new Map();         // roomJid → timestamp of last join notification sent
const roomLastMessage = new Map();         // roomJid → timestamp of last message notification sent
let myLitUsername = settings.prefs?.litUsername || null;  // local-part of our own JID
const picpubExpiredTokens = new Set();     // tokens confirmed dead via HEAD check this session

// litpic:// is used for proxied PicPub image URLs with owner-token auth
protocol.registerSchemesAsPrivileged([
  { scheme: 'litpic', privileges: { bypassCSP: true } },
]);
let awayConversations = new Map();         // per-sender conversation history for llama mode

// Auto-updater state — read by createAppMenu() to reflect current status
let updateState = 'idle';   // 'idle' | 'checking' | 'downloading' | 'ready'
let updateVersion = null;
let _autoUpdater = null;

let tray = null;
let trayMinimizeHintShown = false;

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

function notifyRoomMessages(messages) {
  if (!presenceNotifyReady) return;
  for (const m of messages) {
    if (m.type !== 'groupchat' || m.direction !== 'received') continue;
    const slash = (m.from || '').indexOf('/');
    if (slash === -1) continue;
    const roomJid  = unescapeJid(m.from.slice(0, slash));
    const msgNick  = m.from.slice(slash + 1);
    const fav = settings.favourites?.[roomJid];
    if (!fav?.notifyMessage) continue;
    const last = roomLastMessage.get(roomJid) || 0;
    if (Date.now() - last < ROOM_IDLE_MS) continue;
    roomLastMessage.set(roomJid, Date.now());
    const name = fav.name || roomJid.split('@')[0];
    const body = m.body ? (m.body.length > 80 ? m.body.slice(0, 80) + '…' : m.body) : '';
    sendNotification({ title: name, body: `${msgNick}: ${body}` });
  }
}

function notifyDMs(messages) {
  for (const m of messages) {
    if (m.type !== 'chat' || m.direction !== 'received') continue;
    const nick = nickOf(m.from);
    sendNotification({
      title: `DM from ${nick}`,
      body: m.body.length > 120 ? m.body.slice(0, 120) + '…' : m.body,
    });
    if (settings.prefs?.away && m.from && m.body) {
      const awayMsg = settings.prefs.awayMessage || "I'm currently away.";
      if (awayMsg.startsWith('llama-server:')) {
        sendLlamaReply(m.from, m.body).catch(e => console.error('[away/llama] error:', e.message));
      } else if (awayMsg.startsWith('openrouter:')) {
        sendOpenRouterReply(m.from, m.body).catch(e => console.error('[away/openrouter] error:', e.message));
      } else if (!awayRepliedTo.has(m.from)) {
        // Static reply — one per sender
        awayRepliedTo.add(m.from);
        sendAwayReply(m.from, awayMsg);
      }
    }
  }
}

function sendAwayReply(toJid, msg) {
  win.webContents.executeJavaScript(`
    (function() {
      try {
        if (typeof Candy === 'undefined') throw new Error('Candy not defined');
        var conn = Candy.Core.getConnection();
        if (!conn) throw new Error('No connection');
        var stanza = $msg({to: ${JSON.stringify(toJid)}, type: 'chat'}).c('body').t(${JSON.stringify(msg)});
        conn.send(stanza.tree ? stanza.tree() : stanza);
        return 'ok';
      } catch(e) { return 'ERR: ' + e.message; }
    })();
  `).then(r => { if (r !== 'ok') console.error('[away] sendAwayReply:', r); })
    .catch(e => console.error('[away] executeJavaScript failed:', e.message));
}

function loadSystemPrompt() {
  const file = path.join(PROFILE_DIR, 'system-prompt.json');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
      if (typeof parsed.system  === 'string') return parsed.system;
      if (typeof parsed.content === 'string') return parsed.content;
    } catch {}
    return raw; // plain-text fallback
  } catch { return null; }
}

function parseLlamaEndpoint(awayMsg) {
  // "llama-server:/path/to/sock"  → { socketPath }
  // "llama-server:host:port"      → { host, port }
  const spec = awayMsg.slice('llama-server:'.length).trim();
  if (spec.startsWith('/')) return { socketPath: spec };
  const lastColon = spec.lastIndexOf(':');
  if (lastColon !== -1) {
    return { host: spec.slice(0, lastColon), port: parseInt(spec.slice(lastColon + 1), 10) || 8080 };
  }
  return { host: spec, port: 8080 };
}

let _llamaArch = null; // cached per app session

async function detectLlamaArch(endpoint) {
  if (_llamaArch) return _llamaArch;
  const http = require('http');
  return new Promise(resolve => {
    const opts = {
      path: '/v1/models',
      method: 'GET',
      ...(endpoint.socketPath
        ? { socketPath: endpoint.socketPath }
        : { hostname: endpoint.host, port: endpoint.port }),
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const id = (JSON.parse(data).data?.[0]?.id || '').toLowerCase();
          if (id.includes('gemma'))       _llamaArch = 'gemma';
          else if (id.includes('qwen3')) _llamaArch = 'qwen3';
          else                            _llamaArch = 'chatml';
        } catch { _llamaArch = 'chatml'; }
        console.log('[away/llama] detected arch:', _llamaArch);
        resolve(_llamaArch);
      });
    });
    req.on('error', () => { _llamaArch = 'chatml'; resolve(_llamaArch); });
    req.end();
  });
}

function buildLlamaPrompt(arch, messages) {
  let prompt = '';
  for (const msg of messages) {
    if (arch === 'gemma') {
      if (msg.role === 'system') {
        prompt += `<start_of_turn>user\n${msg.content}\n\n`;
      } else if (msg.role === 'user') {
        // first system message already opened user turn; subsequent user messages start fresh
        prompt += prompt ? `${msg.content}\n<end_of_turn>\n<start_of_turn>model\n`
                         : `<start_of_turn>user\n${msg.content}\n<end_of_turn>\n<start_of_turn>model\n`;
      } else if (msg.role === 'assistant') {
        prompt += `${msg.content}<end_of_turn>\n<start_of_turn>user\n`;
      }
    } else {
      // ChatML — covers Qwen3, Llama-3, Mistral, Phi, etc.
      if (msg.role === 'system') {
        prompt += `<|im_start|>system\n${msg.content}<|im_end|>\n`;
      } else if (msg.role === 'user') {
        prompt += `<|im_start|>user\n${msg.content}<|im_end|>\n`;
      } else if (msg.role === 'assistant') {
        prompt += `<|im_start|>assistant\n${msg.content}<|im_end|>\n`;
      }
    }
  }
  // Assistant prefill — Qwen3: empty think block skips chain-of-thought
  if (arch === 'qwen3') prompt += '<|im_start|>assistant\n<think>\n\n</think>\n\n';
  else if (arch === 'gemma') { /* already opened model turn above */ }
  else prompt += '<|im_start|>assistant\n';
  return prompt;
}

async function callLlamaServer(endpoint, messages) {
  const http = require('http');
  const arch = await detectLlamaArch(endpoint);
  const prompt = buildLlamaPrompt(arch, messages);

  const body = JSON.stringify({
    prompt,
    stream: false,
    n_predict: 1024,
    stop: ['<|im_end|>', '<|endoftext|>'],
  });
  const opts = {
    path: '/completion',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    ...(endpoint.socketPath
      ? { socketPath: endpoint.socketPath }
      : { hostname: endpoint.host, port: endpoint.port }),
  };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const reply = (parsed.content || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
          if (!reply) console.error('[away/llama] unexpected response:', JSON.stringify(parsed).slice(0, 300));
          resolve(reply || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function loadOpenRouterKey() {
  try { return fs.readFileSync(path.join(PROFILE_DIR, 'openrouter.key'), 'utf8').trim(); }
  catch { return null; }
}

async function callOpenRouter(model, apiKey, messages) {
  const https = require('https');
  const body = JSON.stringify({ model, messages, stream: false });
  const opts = {
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/joeuser12/litchat',
      'X-Title': 'Lit Chat',
    },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const reply = parsed.choices?.[0]?.message?.content?.trim() || '';
          if (!reply) console.error('[away/openrouter] unexpected response:', JSON.stringify(parsed).slice(0, 300));
          resolve(reply);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendOpenRouterReply(toJid, userText) {
  const awayMsg = settings.prefs?.awayMessage || '';
  const model = awayMsg.slice('openrouter:'.length).trim();
  const apiKey = loadOpenRouterKey();
  if (!apiKey) { console.error('[away/openrouter] no key found at openrouter.key'); return; }

  const systemPrompt = loadSystemPrompt();
  if (!awayConversations.has(toJid)) {
    awayConversations.set(toJid, loadDMHistory(toJid));
  }
  const history = awayConversations.get(toJid);
  history.push({ role: 'user', content: userText });

  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...history,
  ];

  console.log('[away/openrouter] calling', model, 'for', toJid);
  const reply = await callOpenRouter(model, apiKey, messages);
  console.log('[away/openrouter] got reply:', reply.slice(0, 80));
  if (!reply) return;

  history.push({ role: 'assistant', content: reply });
  sendAwayReply(toJid, reply);
}

function loadDMHistory(toJid) {
  const logDir = path.join(PROFILE_DIR, 'logs');
  if (!fs.existsSync(logDir)) return [];
  const slash = toJid.indexOf('/');
  const target = (slash !== -1 ? toJid.slice(slash + 1) : toJid.split('@')[0]).toLowerCase();
  const nickOf = jid => {
    const s = jid.indexOf('/');
    if (s !== -1) return jid.slice(s + 1).toLowerCase();
    const at = jid.indexOf('@');
    return (at !== -1 ? jid.slice(0, at) : jid).toLowerCase();
  };
  const msgs = [];
  for (const file of fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort()) {
    const lines = fs.readFileSync(path.join(logDir, file), 'utf8').split('\n');
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (m.type !== 'chat') continue;
        const peer = nickOf(m.direction === 'sent' ? (m.to || '') : (m.from || ''));
        if (peer === target) msgs.push(m);
      } catch { /* skip malformed */ }
    }
  }
  return msgs.slice(-10).map(m => ({
    role: m.direction === 'sent' ? 'assistant' : 'user',
    content: m.body || '',
  }));
}

async function sendLlamaReply(toJid, userText) {
  const awayMsg  = settings.prefs?.awayMessage || '';
  const endpoint = parseLlamaEndpoint(awayMsg);
  const systemPrompt = loadSystemPrompt();

  if (!awayConversations.has(toJid)) {
    awayConversations.set(toJid, loadDMHistory(toJid));
  }
  const history = awayConversations.get(toJid);
  history.push({ role: 'user', content: userText });

  const messages = [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...history,
  ];

  console.log('[away/llama] calling endpoint', endpoint, 'for', toJid);
  const reply = await callLlamaServer(endpoint, messages);
  console.log('[away/llama] got reply:', reply?.slice(0, 80));
  if (!reply) return;

  history.push({ role: 'assistant', content: reply });
  sendAwayReply(toJid, reply);
}

// Decodes XEP-0106 JID escaping (e.g. \20 → space) used in XMPP stanza from/to attributes.
// Room hrefs in Candy's UI use plain characters; BOSH stanzas use the escaped form.
function unescapeJid(jid) {
  return jid
    .replace(/\\20/g, ' ')
    .replace(/\\22/g, '"')
    .replace(/\\26/g, '&')
    .replace(/\\27/g, "'")
    .replace(/\\2f/g, '/')
    .replace(/\\3a/g, ':')
    .replace(/\\3c/g, '<')
    .replace(/\\3e/g, '>')
    .replace(/\\40/g, '@')
    .replace(/\\5c/g, '\\');
}

// Extracts presence stanzas from a BOSH XML body.
// Parses full elements so we can detect MUC self-join reflections (status code 110).
function extractPresence(xml) {
  const out = [];
  // Match full presence elements (self-closing or with body)
  const re = /<presence\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/presence>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const inner = m[2] || '';
    const from = (attrs.match(/\bfrom=["']([^"']+)["']/) || [])[1];
    const type = (attrs.match(/\btype=["']([^"']+)["']/) || [])[1] || 'available';
    if (from && (type === 'available' || type === 'unavailable')) {
      // status code 110 = MUC server reflecting our own join back to us
      const isSelf = /code=["']110["']/.test(inner);
      out.push({ nick: nickOf(from).toLowerCase(), from, type, isSelf });
    }
  }
  return out;
}

function handlePresence(presences) {
  watchList = loadWatchList(); // pick up any changes made via the log viewer
  for (const p of presences) {
    const { nick, type, from } = p;

    // Watch list: online/offline notifications for specific users
    if (watchList.has(nick)) {
      if (type === 'available' && !onlineWatched.has(nick)) {
        onlineWatched.add(nick);
        if (presenceNotifyReady)
          sendNotification({ title: 'Now online', body: nick });
      } else if (type === 'unavailable' && onlineWatched.has(nick)) {
        onlineWatched.delete(nick);
        if (presenceNotifyReady)
          sendNotification({ title: 'Went offline', body: nick });
      }
    }

    // Room join notifications — skip our own join reflection (MUC status 110)
    if (type === 'available' && presenceNotifyReady && !p.isSelf) {
      const slash = (from || '').indexOf('/');
      if (slash !== -1) {
        const roomJid  = unescapeJid(from.slice(0, slash));
        const joinNick = from.slice(slash + 1);
        const fav = settings.favourites?.[roomJid];
        if (fav?.notifyJoin) {
          const last = roomLastJoin.get(roomJid) || 0;
          if (Date.now() - last >= ROOM_IDLE_MS) {
            roomLastJoin.set(roomJid, Date.now());
            const name = fav.name || roomJid.split('@')[0];
            sendNotification({ title: name, body: `${joinNick} joined` });
          }
        }
      }
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

  win.on('minimize', () => {
    win.hide();
    if (!trayMinimizeHintShown) {
      trayMinimizeHintShown = true;
      new Notification({
        title: 'Lit Chat is still running',
        body: 'Click the tray icon to bring it back.',
      }).show();
    }
  });

  win.loadURL(CHAT_URL);


  win.webContents.on('did-finish-load', async () => {
    // Detect server error pages (e.g. 500 Internal Server Error) and auto-reload
    // instead of leaving the user staring at a blank or cryptic error screen.
    const pageText = await win.webContents.executeJavaScript(
      'document.body ? document.body.innerText.trim() : ""'
    ).catch(() => '');
    if (/^(internal server error|bad gateway|service unavailable|gateway timeout)$/i.test(pageText) ||
        /^[45]\d\d\b/.test(pageText)) {
      win.webContents.executeJavaScript(`
        (function() {
          document.head.innerHTML = '<style>' +
            'body{margin:0;background:#181820;color:#ccc;font-family:sans-serif;' +
            'display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}' +
            'button{background:#7c5cbf;border:none;color:#fff;padding:8px 22px;' +
            'border-radius:6px;cursor:pointer;font-size:14px;margin-top:16px}' +
            'button:hover{background:#9b7de0}</style>';
          document.body.innerHTML =
            '<div><div style="font-size:44px;margin-bottom:14px">⚠️</div>' +
            '<div style="font-size:17px;margin-bottom:6px">Server error</div>' +
            '<div style="color:#888;margin-bottom:4px">Reloading in <span id="_rc">5</span>s…</div>' +
            '<button onclick="clearInterval(window._rt);location.reload()">Reload now</button></div>';
          var n = 5;
          window._rt = setInterval(function() {
            var el = document.getElementById('_rc');
            if (el) el.textContent = --n;
            if (n <= 0) { clearInterval(window._rt); location.reload(); }
          }, 1000);
        })();
      `).catch(() => {});
      return;
    }

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
    const CUSTOM_LIGHT = new Set(['solarized-light', 'warm-rose', 'blue-steel', 'sage', 'lavender']);
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
    if (theme !== 'light' && !CUSTOM_LIGHT.has(theme)) {
      cssKeys.push(await win.webContents.insertCSS(
        '#headerLogo path{fill:white!important}' +
        '#headerLogo .logo__l,#headerLogo .logo__r{fill:#4a89f3!important}'
      ));
    }

    const fsPx = settings.prefs?.fontSize;
    if (fsPx && fsPx !== 15)
      cssKeys.push(await win.webContents.insertCSS(fontSizeCSS(fsPx)));

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
        (async () => {
          // Wait for evidence that room joins will work.
          // Strategy: watch #chat-tabs for the first tab Candy adds via its own
          // bookmark/session restore — that's concrete proof the XMPP connection
          // is warm.  Falls back to 3 s for a brand-new session with no bookmarks.
          await win.webContents.executeJavaScript(`
            new Promise(function(resolve) {
              var resolved = false;
              function done() { if (!resolved) { resolved = true; resolve(); } }

              // Already warm — a tab is present from Candy's own restore
              if (document.querySelector('#chat-tabs li[data-roomjid]')) {
                done(); return;
              }

              // Watch for the first tab Candy adds itself
              var tabs = document.querySelector('#chat-tabs');
              var obs = tabs ? new MutationObserver(function() {
                if (document.querySelector('#chat-tabs li[data-roomjid]')) {
                  obs.disconnect(); done();
                }
              }) : null;
              if (obs) obs.observe(tabs, { childList: true, subtree: true });

              // Fallback: 3 s (no bookmarks / first-ever session)
              setTimeout(function() { if (obs) obs.disconnect(); done(); }, 3000);
            })
          `).catch(() => {});
          for (const [jid] of autoJoins) {
            await joinRoom(jid);
            await new Promise(r => setTimeout(r, 1500)); // let the site settle between joins
          }
        })();
        // Suppress presence notifications briefly while the initial roster flood passes
        setTimeout(() => { presenceNotifyReady = true; }, 5000);
        injectNavButtons();
        setupPerRoomStatus();
        injectEmojiPicker();
        injectDMHistory();
        injectImageSharing();
      }
    }, 500);
  });

  // All links open in a child window; the main chat window never navigates away
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLinkWindow(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).hostname !== 'chat.literotica.com') {
        e.preventDefault();
        openLinkWindow(url);
      }
    } catch { e.preventDefault(); }
  });
}

const CUSTOM_LIGHT_IDS = new Set(['light', 'solarized-light', 'warm-rose', 'blue-steel', 'sage', 'lavender']);

function isLightTheme() {
  return CUSTOM_LIGHT_IDS.has(settings.theme || 'dark');
}

const DIALOG_LIGHT_CSS = `
  body, #toolbar, #tabs, .tab-btn.active, #notes-panel, .date-sep,
  .ctx-header, .ctx-messages, .ctx-group { background: revert; color: revert; border-color: revert; }
  body        { background: #f8f8fc !important; color: #1a1a2a !important; }
  #toolbar    { background: #eeeef4 !important; border-color: #d8d8e4 !important; }
  #tabs       { background: #eeeef4 !important; border-color: #d8d8e4 !important; }
  .tab-btn    { background: none !important; border-color: #d8d8e4 !important; color: #888 !important; }
  .tab-btn.active { background: #f8f8fc !important; color: #1a1a2a !important; border-color: #d8d8e4 !important; }
  .tab        { color: #888 !important; }
  .tab.active { color: #7c5cbf !important; border-color: #7c5cbf !important; }
  .search-input, #filter { background: #ffffff !important; border-color: #d0d0dc !important; color: #1a1a2a !important; }
  .search-input::placeholder, #filter::placeholder { color: #aaa !important; }
  #refresh-btn { background: #e8e8f0 !important; border-color: #d0d0dc !important; color: #444 !important; }
  #refresh-btn:hover { border-color: #7c5cbf !important; color: #1a1a2a !important; }
  #messages   { background: #f8f8fc !important; }
  .placeholder, #empty { color: #aaa !important; }
  .ctx-group  { border-color: #d8d8e4 !important; }
  .ctx-header { background: #eeeef4 !important; }
  .ctx-header:hover { background: #e4e4f0 !important; }
  .ctx-badge.dm   { background: #ede0fc !important; color: #7c5cbf !important; }
  .ctx-badge.room { background: #d8edf8 !important; color: #2879b5 !important; }
  .ctx-title  { color: #333 !important; }
  .ctx-count, .ctx-chevron, .ctx-del { color: #aaa !important; }
  .ctx-messages { background: #f8f8fc !important; }
  .sent     { background: #e8dff8 !important; }
  .received { background: #ddeef8 !important; }
  .date-sep { background: #e8e8f0 !important; color: #aaa !important; }
  mark      { background: #fff0b0 !important; color: #7a5000 !important; }
  .msg-link { color: #5050cc !important; }
  .msg-link:hover { color: #6060dd !important; }
  #notes-panel { background: #eeeef4 !important; border-color: #d8d8e4 !important; }
  #notes-panel textarea { background: #ffffff !important; border-color: #d0d0dc !important; color: #1a1a2a !important; }
  .room-row { border-color: #e8e8f0 !important; }
  .room-row:hover { background: #efeffa !important; }
  .room-count { color: #aaa !important; }
  .aj-label   { color: #aaa !important; }
  .aj-label.on { color: #7c5cbf !important; }
  ::-webkit-scrollbar-track { background: #eeeef4 !important; }
  ::-webkit-scrollbar-thumb { background: #d0d0dc !important; }
  ::-webkit-scrollbar-thumb:hover { background: #b8b8cc !important; }
`;

function injectDialogTheme(wc) {
  if (isLightTheme()) wc.insertCSS(DIALOG_LIGHT_CSS).catch(() => {});
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
  logWin.webContents.once('did-finish-load', () => injectDialogTheme(logWin.webContents));
  logWin.webContents.setWindowOpenHandler(({ url }) => {
    openLinkWindow(url);
    return { action: 'deny' };
  });
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

function injectDMHistory() {
  win.webContents.executeJavaScript(`
    (function() {
      if (window._litDMHistoryActive) return;
      window._litDMHistoryActive = true;

      function escHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }
      function unescXml(s) {
        return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
      }
      function fmtTs(iso) {
        var d = new Date(iso);
        return d.toLocaleDateString([], {month:'short',day:'numeric'}) + ' ' +
               d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      }

      function buildHistory(messages, myNick) {
        var items = messages.map(function(m) {
          function nickOf(jid) { var s=jid.indexOf('/'); return s!==-1?jid.slice(s+1):jid.split('@')[0]; }
          var sender = m.direction === 'sent'
            ? (myNick || 'me')
            : nickOf(m.from || '');
          var body = escHtml(unescXml(m.body || ''));
          // Render photo messages inline
          var IMG_S = 'max-width:280px;max-height:280px;object-fit:contain;border-radius:6px;display:block;margin:4px 0;cursor:pointer';
          // Format A: linked native — "📷 https://picpub.art/hash.ext"
          var nativeM = /^\u{1F4F7} (https:\\/\\/picpub\\.art\\/[a-z0-9]+\\.[a-z]+)$/u.exec(m.body ? m.body.trim() : '');
          if (nativeM) {
            var nurl = escHtml(nativeM[1]);
            body = '<a href="' + nurl + '" target="_blank" style="display:inline-block">' +
                   '<img src="' + nurl + '" style="' + IMG_S + '" title="Click to view image"></a>';
          } else if (m._photoExpired) {
            var THUMB_S = 'max-width:96px;max-height:96px;object-fit:contain;border-radius:4px;' +
              'opacity:0.55;display:block;margin:4px 0;cursor:default';
            var isExpiredVideo = /\\.(?:mp4|webm|mov|mkv|avi)#?/i.test(m.body || '');
            body = m._thumbSrc
              ? '<img src="' + m._thumbSrc + '" style="' + THUMB_S + '" title="Expired photo">'
              : '<span style="color:#444;font-style:italic">' + (isExpiredVideo ? '📹 (video expired)' : '📷 (photo expired)') + '</span>';
          } else {
            // Format B: uploaded — "📷 View photo: https://picpub.art/v/TOKEN#HASH"
            var photoM = /\u{1F4F7} View photo: (https:\\/\\/picpub\\.art\\/v\\/([a-f0-9]+)(?:\\?[^#]*)?)#([\\w.]+)/u.exec(m.body || '');
            if (photoM) {
              var pBase = photoM[1], pToken = photoM[2], pHash = photoM[3];
              var pFull = escHtml(pBase + '#' + pHash);
              var pVtM = /[?&]vt=([^&#]+)/.exec(pBase);
              var pLitpic = 'litpic://' + pToken + '/' + pHash + (pVtM ? '?vt=' + pVtM[1] : '');
              body = '<a href="' + pFull + '" target="_blank" ' +
                     'data-pt="' + pToken + '" data-ph="' + pHash + '" data-pu="' + pFull + '" ' +
                     'onclick="var t=this.dataset.pt,h=this.dataset.ph,u=this.dataset.pu;if(window._litOpenAlbum){window._litOpenAlbum(t,h,u);return false;}" ' +
                     'style="display:inline-block">' +
                     '<img src="' + pLitpic + '" ' +
                     'data-lp-token="' + pToken + '" data-lp-hash="' + pHash + '" ' +
                     'oncontextmenu="window.litChat&&window.litChat.photoContextMenu(this.dataset.lpToken,this.dataset.lpHash);return false;" ' +
                     'style="' + IMG_S + '" title="Click to open album"></a>';
            } else {
              // linkify
              body = body.replace(/(https?:\\/\\/[^\\s<>"']+)/g,
                '<a href="$1" target="_blank" style="color:#818cf8;text-decoration:underline">$1</a>');
            }
          }
          return '<li style="padding:3px 8px;border-bottom:1px solid rgba(255,255,255,0.04);list-style:none">' +
            '<small style="color:#4a4870;margin-right:6px">' + escHtml(fmtTs(m.ts)) + '</small>' +
            '<span style="color:#818cf8;font-weight:600;margin-right:6px">' + escHtml(sender) + '</span>' +
            '<span style="color:#cccaee">' + body + '</span>' +
            '</li>';
        });
        return '<li style="list-style:none;padding:0;margin:0" class="lit-dm-history">' +
          '<details open>' +
          '<summary style="cursor:pointer;padding:6px 8px;color:#4a4870;font-size:11px;' +
            'background:rgba(0,0,0,0.25);letter-spacing:0.05em;user-select:none">' +
            '▸ ' + messages.length + ' previous message' + (messages.length !== 1 ? 's' : '') +
          '</summary>' +
          '<ul style="margin:0;padding:0;background:rgba(0,0,0,0.15)">' +
            items.join('') +
          '</ul>' +
          '</details>' +
          '</li>';
      }

      async function populatePane(pane) {
        if (pane._litHistoryDone) return;
        pane._litHistoryDone = true;

        var jid = pane.dataset.roomjid || '';
        // DMs from group chat rooms use the format room@server/Nick
        // Plain DMs use user@server — both are DMs (not a conference room tab)
        var slash = jid.indexOf('/');
        var username = slash !== -1 ? jid.slice(slash + 1) : jid.split('@')[0];
        // A conference room tab has NO resource (no '/'), AND no '@' local-part nick
        // Skip if it looks like a bare room JID (has @conference. but no resource)
        if (slash === -1 && jid.indexOf('@conference.') !== -1) return;
        if (!username) return;

        var messages = await window.litChat.dmHistory(username).catch(function() { return []; });
        if (!messages.length) return;

        // My own nick — the sender of 'sent' messages
        function nickOf(jid) {
          var s = jid.indexOf('/');
          if (s !== -1) return jid.slice(s + 1);
          return jid.split('@')[0];
        }
        var myNick = null;
        var sentMsg = messages.find(function(m) { return m.direction === 'sent'; });
        if (sentMsg && sentMsg.from) {
          // Own JID is user@server/CandyClient — nick is the local part before '@'
          var at = sentMsg.from.indexOf('@');
          myNick = at !== -1 ? sentMsg.from.slice(0, at) : sentMsg.from;
        }

        var msgPane = pane.querySelector('ul.message-pane, ul[class*="message"]');
        // Candy may not have finished building the pane — retry briefly
        if (!msgPane) {
          await new Promise(function(r) { setTimeout(r, 300); });
          msgPane = pane.querySelector('ul.message-pane, ul[class*="message"]');
        }
        if (!msgPane) return;

        var html = buildHistory(messages, myNick);
        msgPane.insertAdjacentHTML('afterbegin', html);
        // Scroll the containing pane to the bottom so live messages are visible
        var scroller = msgPane.closest('.message-pane-wrapper') || msgPane.parentElement;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      }

      // Populate any already-open DM panes (e.g. DMs from a previous session reopened)
      document.querySelectorAll('.room-pane[data-roomjid]').forEach(populatePane);

      // Watch for new DM panes
      var roomsEl = document.getElementById('chat-rooms');
      if (roomsEl) {
        new MutationObserver(function(muts) {
          muts.forEach(function(mut) {
            mut.addedNodes.forEach(function(n) {
              if (n.nodeType === 1 && n.dataset && n.dataset.roomjid) populatePane(n);
            });
          });
        }).observe(roomsEl, { childList: true });
      }
    })();
  `).catch(() => {});
}

const FONT_SIZES = [
  { px: 13, label: 'Small' },
  { px: 15, label: 'Medium' },
  { px: 17, label: 'Large' },
  { px: 19, label: 'X-Large' },
];

function fontSizeCSS(px) {
  return `#candy .message-pane,#candy .message-pane li,#candy .message-pane li span,#candy .message-pane li div{font-size:${px}px!important}`;
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
  // Each emoji: [glyph, search keywords]
  const CATS = [
    { icon: '😊', title: 'Faces', emoji: [
      ['😀','grin happy smile face'],['😃','happy smile open mouth'],['😄','grin squint happy'],
      ['😁','grin teeth happy'],['😆','laugh squint happy'],['😅','sweat smile nervous'],
      ['🤣','rofl rolling floor laughing'],['😂','joy tears laughing cry'],
      ['🙂','smile slight'],['🙃','upside down smile'],['🙂‍↕️','nodding yes'],['🙂‍↔️','shaking no'],
      ['😉','wink'],['😊','smile blush'],['😇','angel halo innocent'],
      ['😍','heart eyes love adore'],['🤩','star eyes wow amazing starstruck'],
      ['😘','kiss blow love'],['🥰','love hearts smiling'],['😋','yummy delicious tongue'],
      ['😗','kissing'],['😙','kissing smiling eyes'],['😚','kissing closed eyes'],
      ['🥹','holding back tears moved grateful'],['🥲','smiling tear bittersweet'],
      ['🥸','disguised incognito glasses'],
      ['😛','tongue out'],['😜','winking tongue'],['🤪','crazy zany silly'],['😝','tongue squint'],
      ['🤑','money mouth rich'],['🤗','hug hugging arms'],['🤭','hand mouth giggle oops'],
      ['🫣','peeking eye peek shy'],['🫢','gasp hand over mouth shocked'],
      ['🫡','saluting face respect'],['🫠','melting dissolve'],
      ['🫥','dotted line face invisible hidden'],['🫤','diagonal mouth meh unsure'],
      ['🤫','shush quiet secret'],['🤔','thinking hmm ponder'],
      ['🤐','zipper mouth silent zip'],['🤨','raised eyebrow suspicious'],
      ['😐','neutral blank'],['😑','expressionless'],['😶','no mouth silent'],
      ['😏','smirk sly'],['😒','unamused unhappy'],['🙄','eye roll annoyed'],
      ['😬','grimace nervous'],['🤥','lying pinocchio'],['😌','relieved content'],
      ['😔','pensive sad'],['😪','sleepy tired'],['🤤','drool hungry'],['😴','sleep zzz tired'],
      ['😷','mask sick face'],['🤒','sick fever ill'],['🤕','injured bandage hurt'],
      ['🤢','nausea sick gross'],['🤮','vomit puke sick'],['🤧','sneeze sick cold'],
      ['🥵','hot sweating overheated'],['🥶','cold freezing ice'],['🥴','woozy drunk dizzy'],
      ['😵','dizzy faint'],['😵‍💫','dizzy spiral eyes'],['😮‍💨','exhale sigh breathe relief'],
      ['😶‍🌫️','face in clouds spaced out'],['🫩','bags under eyes tired exhausted'],
      ['🤯','exploding head mind blown'],['🤠','cowboy hat western'],
      ['🥳','party celebration festive'],['😎','cool sunglasses'],['🤓','nerd glasses smart'],
      ['🧐','monocle fancy detective'],['😕','confused unsure'],['😟','worried anxious'],
      ['🙁','slight frown sad'],['☹️','frown sad unhappy'],['😮','open mouth surprised'],
      ['😯','hushed surprised'],['😲','astonished shocked'],['😳','flushed embarrassed red'],
      ['🥺','pleading begging puppy eyes'],['😦','frowning open mouth'],['😧','anguished pain'],
      ['😨','fearful scared afraid'],['😰','anxious sweat cold fear'],['😥','sad relieved'],
      ['😢','cry tear sad'],['😭','sob crying loudly'],['😱','scream fear horror'],
      ['😖','confounded frustrated'],['😣','persevere struggle pain'],['😞','disappointed sad'],
      ['😓','sweat downcast'],['😩','weary tired exhausted'],['😫','tired drained'],
      ['🥱','yawn tired bored'],['😤','steam nose triumph frustrated'],
      ['😡','angry pouting rage mad'],['😠','angry mad'],['🤬','swear cursing angry'],
      ['😈','devil evil smiling demon horns mischief imp satan'],
      ['👿','devil angry imp evil horns demon goblin satan'],
      ['💀','skull death dead'],['☠️','skull crossbones death poison danger'],
      ['💩','poop shit'],['🤡','clown'],['👹','ogre oni japanese monster'],['👺','goblin oni demon red'],
      ['👻','ghost boo spooky'],['👽','alien ufo extraterrestrial'],
      ['👾','alien monster game space invader'],['🤖','robot'],
      ['🫨','shaking face vibrate tremble'],
      ['😺','cat grinning'],['😸','cat grin smile'],['😹','cat joy tears laugh'],
      ['😻','cat heart eyes love'],['😼','cat smirk wry'],['😽','cat kiss'],
      ['🙀','cat weary shocked'],['😿','cat cry sad'],['😾','cat pouting angry'],
      ['🫪','distorted face anxiety panic shocked surprised'],
      ['🫯','fight cloud argument brawl disagreement ruckus'],
    ]},
    { icon: '👋', title: 'Gestures', emoji: [
      ['👋','wave hello goodbye'],['🤚','raised back hand stop'],
      ['🖐️','hand five fingers spread'],['✋','raised hand stop high five'],
      ['🖖','vulcan spock live long prosper'],['👌','ok okay perfect'],
      ['🤌','pinched fingers italian chef kiss'],['🤏','pinching hand small'],
      ['✌️','peace victory two fingers'],['🤞','crossed fingers luck hope'],
      ['🤟','love you hand rock'],['🤘','horns rock metal sign'],
      ['🤙','call me shaka hang loose'],['👈','point left'],['👉','point right'],
      ['👆','point up'],['🖕','middle finger rude'],['👇','point down'],
      ['☝️','index point up one'],['👍','thumbs up good yes like approve'],
      ['👎','thumbs down bad no dislike'],['✊','fist bump raise power'],
      ['👊','oncoming fist punch'],['🤛','left fist bump'],['🤜','right fist bump'],
      ['👏','clap applause bravo'],['🙌','raising hands celebrate hooray'],
      ['👐','open hands'],['🤲','palms up together'],['🤝','handshake deal'],
      ['🙏','pray thank you please namaste'],['✍️','write pen sign'],
      ['💅','nail polish fancy manicure'],['💪','flex muscle strong arm'],['🦾','mechanical arm prosthetic'],
      ['👀','eyes look watching see'],['👁️','eye see'],['👄','lips mouth'],['💋','kiss lips'],
      ['🫦','biting lip'],['🫶','heart hands love'],['🫰','finger snap'],
      ['🫸','push right hand'],['🫷','push left hand'],
    ]},
    { icon: '👤', title: 'People', emoji: [
      ['🤦','facepalm disbelief exasperation ugh'],['🤦‍♀️','woman facepalm'],['🤦‍♂️','man facepalm'],
      ['🤷','shrug idk dunno whatever'],['🤷‍♀️','woman shrug'],['🤷‍♂️','man shrug'],
      ['💁','info tipping hand sassy gossip'],['💁‍♀️','woman tipping hand sassy'],['💁‍♂️','man tipping hand'],
      ['🙅','no gesture forbidden stop'],['🙅‍♀️','woman no gesture'],['🙅‍♂️','man no gesture'],
      ['🙆','ok gesture yes'],['🙆‍♀️','woman ok gesture'],['🙆‍♂️','man ok gesture'],
      ['🙋','raise hand question volunteer'],['🙋‍♀️','woman raise hand'],['🙋‍♂️','man raise hand'],
      ['🙇','bow apology respect'],['🙇‍♀️','woman bowing'],['🙇‍♂️','man bowing'],
      ['🙎','pout disappointed frown'],['🙍','frown annoyed disgruntled'],
      ['💆','massage relaxed spa headache'],['💇','haircut barber salon'],
      ['🤳','selfie phone camera'],['🕴️','suit levitate business person'],
      ['👶','baby infant newborn'],['🧒','child kid young'],
      ['👦','boy child son'],['👧','girl child daughter'],
      ['🧑','person adult'],['👩','woman adult lady'],['👨','man adult'],
      ['🧓','older person elderly grandparent'],['👴','old man elderly grandpa'],['👵','old woman elderly grandma'],
      ['🧠','brain smart intelligent mind'],['🫀','anatomical heart organ cardiology'],
      ['🫁','lungs breath breathe'],['🦷','tooth teeth dentist'],
      ['🦻','ear hear accessibility'],['👂','ear hear listen'],['👃','nose smell sniff'],
      ['🦵','leg kick knee'],['🦶','foot feet'],['👅','tongue lick taste'],
      ['🫆','fingerprint detective clue identity'],['👣','footprints barefoot tracks'],
      ['🫂','hug embrace comfort friendship'],['💏','kiss couple romance love'],
      ['🧑‍🤝‍🧑','people holding hands friends couple'],
      ['👤','person shadow silhouette user'],['👥','people group users'],['🗣️','speak talk voice'],
      ['🧙','mage wizard witch magic fantasy'],['🧚','fairy fairytale fantasy myth'],
      ['🧛','vampire blood dracula halloween'],['🧜','mermaid merman creature fairytale'],
      ['🧝','elf fantasy enchantment'],['🧞','genie djinn jinn fantasy'],
      ['🧟','zombie dead apocalypse halloween horror'],['🧌','troll monster fantasy'],['🥷','ninja assassin fighter'],
      ['🛌','sleep bed rest goodnight'],['🤱','breastfeed baby nursing'],
      ['🕵️','detective spy investigate mystery'],['👷','construction worker hardhat build'],
      ['💂','guard soldier royal'],['🤴','prince royal crown fairytale'],['👸','princess royal crown fairytale'],
      ['🦲','bald hairless'],['🦱','curly hair afro'],['🦰','red hair ginger redhead'],['🦳','white hair gray old'],
    ]},
    { icon: '❤️', title: 'Hearts', emoji: [
      ['❤️','red heart love'],['🧡','orange heart'],['💛','yellow heart'],
      ['💚','green heart'],['💙','blue heart'],['💜','purple heart'],
      ['🩷','pink heart'],['🩵','light blue heart'],['🩶','grey gray heart'],
      ['🖤','black heart dark evil'],['🤍','white heart pure'],['🤎','brown heart'],
      ['💔','broken heart sad'],['❣️','heart exclamation'],['💕','two hearts'],
      ['💞','revolving hearts'],['💓','beating heart'],['💗','growing heart'],
      ['💖','sparkling heart'],['💘','heart arrow cupid love'],
      ['💝','heart ribbon gift'],['💟','heart decoration'],
      ['❤️‍🔥','heart fire passion desire'],['❤️‍🩹','mending heart heal repair'],
      ['😍','heart eyes love adore'],['🥰','love hearts smiling'],['😘','kiss blow love'],
      ['💑','couple love'],['👫','couple man woman'],['💌','love letter mail'],
      ['💍','ring engagement wedding'],['💒','wedding chapel'],['🌹','rose flower love'],
      ['🥀','wilted rose flower dead dying'],['🌷','tulip flower'],['💐','bouquet flowers'],
      ['🎀','ribbon bow pink'],['🎁','gift present'],
    ]},
    { icon: '🐶', title: 'Animals', emoji: [
      ['🐶','dog puppy'],['🐱','cat kitten'],['🐭','mouse'],['🐹','hamster'],
      ['🐰','rabbit bunny'],['🦊','fox'],['🐻','bear'],['🐼','panda'],
      ['🐨','koala'],['🐯','tiger'],['🦁','lion'],['🐮','cow moo'],
      ['🐷','pig oink'],['🐸','frog'],['🐵','monkey'],['🙈','see no evil monkey'],
      ['🙉','hear no evil monkey'],['🙊','speak no evil monkey'],
      ['🐔','chicken hen'],['🐧','penguin'],['🐦','bird'],['🦆','duck'],
      ['🦅','eagle'],['🦉','owl'],['🦇','bat'],['🐺','wolf'],
      ['🐴','horse'],['🦄','unicorn magic'],['🐝','bee honey'],['🦋','butterfly'],
      ['🐌','snail slow'],['🐞','ladybug beetle'],['🐜','ant'],['🐢','turtle slow'],
      ['🐍','snake'],['🦎','lizard'],['🐙','octopus'],['🦑','squid'],
      ['🦀','crab'],['🐡','blowfish'],['🐠','tropical fish'],['🐟','fish'],
      ['🐬','dolphin'],['🐳','whale'],['🦈','shark'],['🦭','seal'],
      ['🦓','zebra'],['🐘','elephant'],['🦏','rhinoceros rhino'],['🐪','camel'],
      ['🦒','giraffe'],['🦬','bison buffalo'],['🐎','horse racing'],
      ['🐑','sheep ewe'],['🐐','goat'],['🦌','deer'],
      ['🐕','dog'],['🐩','poodle dog'],['🐈','cat'],
      ['🦚','peacock'],['🦜','parrot'],['🕊️','dove peace bird'],
      ['🐇','rabbit bunny'],['🦝','raccoon'],['🦦','otter'],
      ['🐁','mouse rat'],['🐿️','chipmunk squirrel'],['🦔','hedgehog'],['🐾','paw print animal'],
      ['🦋','butterfly'],['🐛','caterpillar bug'],['🦗','cricket bug'],['🦟','mosquito bug'],
      ['🪿','goose bird'],['🦤','dodo bird extinct'],['🪶','feather bird light'],
      ['🫏','donkey mule'],['🫎','moose elk deer'],['🪽','wing bird fly'],
      ['🪼','jellyfish ocean sea'],['🐦‍⬛','black bird crow raven'],
      ['🐻‍❄️','polar bear arctic'],['🐒','monkey'],['🐽','pig nose snout'],
      ['🐤','baby chick yellow'],['🐣','hatching chick egg'],['🐥','chick bird front'],
      ['🐗','boar wild pig'],['🐅','tiger big cat'],['🐆','leopard big cat spots'],
      ['🦍','gorilla ape'],['🦧','orangutan ape primate'],['🦣','mammoth prehistoric elephant'],
      ['🦛','hippopotamus hippo'],['🐫','two hump camel bactrian'],['🦘','kangaroo marsupial'],
      ['🐃','water buffalo'],['🐂','ox bull'],['🐄','cow dairy'],['🐖','pig sow'],
      ['🐏','ram sheep male'],['🦙','llama alpaca'],
      ['🦮','guide dog service'],['🐕‍🦺','service dog'],['🐈‍⬛','black cat'],
      ['🐓','rooster cock'],['🦃','turkey thanksgiving'],['🦢','swan elegant'],['🦩','flamingo pink'],
      ['🦨','skunk smell stinky'],['🦡','badger honey'],['🦫','beaver dam'],['🦥','sloth slow lazy'],
      ['🐀','rat rodent'],
      ['🪱','worm earthworm'],['🪰','fly insect'],['🪲','beetle bug'],['🪳','cockroach roach'],
      ['🕷️','spider arachnid'],['🕸️','spider web cobweb'],['🦂','scorpion arachnid'],
      ['🦖','t-rex tyrannosaurus dinosaur'],['🦕','sauropod brontosaurus dinosaur'],
      ['🦐','shrimp prawn'],['🦞','lobster seafood'],['🐊','crocodile alligator reptile'],
      ['🐉','dragon mythical'],['🐲','dragon face'],['🐦‍🔥','phoenix firebird mythical'],
      ['🫍','orca killer whale marine ocean'],
    ]},
    { icon: '🌺', title: 'Nature', emoji: [
      ['💐','bouquet flowers'],['🌸','cherry blossom flower pink'],['💮','white flower'],
      ['🌹','rose flower red'],['🥀','wilted rose flower dead dying'],['🌺','hibiscus flower'],
      ['🌻','sunflower yellow'],['🌼','blossom flower yellow'],['🌷','tulip flower pink'],
      ['🌱','seedling plant sprout grow'],['🌿','herb leaf plant green'],['☘️','shamrock clover ireland'],
      ['🍀','four leaf clover luck'],['🍃','leaves wind'],['🍂','fallen leaf autumn'],
      ['🍁','maple leaf autumn canada red'],['🌾','sheaf grain wheat'],['🌵','cactus desert'],
      ['🎄','christmas tree holiday'],['🌲','evergreen tree pine'],['🌳','deciduous tree'],
      ['🌴','palm tree tropical beach'],['🌙','crescent moon night'],['☀️','sun sunny warm'],
      ['🌤️','partly cloudy sun'],['⛅','partly cloudy'],['🌦️','rain sun cloud'],
      ['🌧️','rain cloud wet'],['🌩️','lightning storm'],['⛈️','thunderstorm'],
      ['🌪️','tornado cyclone wind'],['❄️','snowflake cold winter ice'],
      ['☃️','snowman winter snow'],['🌈','rainbow colorful'],['🌊','wave ocean sea water'],
      ['🌋','volcano eruption fire'],['⛰️','mountain peak'],['🏔️','snow mountain peak'],
      ['🏝️','island tropical beach'],['🌅','sunrise morning'],['🌄','mountain sunrise'],
      ['⭐','star yellow'],['🌟','glowing star shine'],['✨','sparkle shine magic'],['💫','dizzy star spin'],
      ['🌕','full moon'],['🌑','new moon dark night'],['🌠','shooting star wish'],
      ['🌌','milky way galaxy space stars'],['🌀','cyclone spiral'],['🌬️','wind blow cold'],
      ['💧','droplet water'],['💦','water splash'],['🫧','bubbles foam'],
      ['🔥','fire flame hot'],['⚡','lightning bolt energy'],['☄️','comet meteor asteroid'],
      ['🪻','hyacinth flower purple'],['🪷','lotus flower'],
      ['🍄','mushroom fungus'],['🍄‍🟫','brown mushroom fungus'],
      ['🐚','spiral shell seashell'],['🪸','coral reef ocean'],['🪨','rock stone'],
      ['🪾','leafless tree bare'],['🪵','log wood timber'],['🪴','potted plant indoor'],
      ['🎍','pine decoration bamboo'],['🎋','tanabata tree bamboo'],
      ['🪺','nest with eggs bird'],['🪹','empty nest bird'],
      ['🌞','sun with face sunny'],['🌝','full moon face'],['🌛','first quarter moon face'],
      ['🌜','last quarter moon face'],['🌚','new moon face dark'],
      ['🌖','waning gibbous moon'],['🌗','last quarter moon'],['🌘','waning crescent moon'],
      ['🌒','waxing crescent moon'],['🌓','first quarter moon'],['🌔','waxing gibbous moon'],
      ['🌎','globe earth americas'],['🌍','globe earth africa europe'],['🌏','globe earth asia'],
      ['🪐','planet saturn ringed'],
      ['🌥️','cloud sun partly'],['☁️','cloud overcast'],['🌨️','cloud snow snowing'],
      ['⛄','snowman no snow'],['☔','umbrella rain'],['☂️','umbrella open'],['🌫️','fog mist haze'],
      ['🐋','whale large ocean'],
    ]},
    { icon: '🍕', title: 'Food & Drink', emoji: [
      ['🍎','apple red fruit'],['🍊','orange tangerine fruit'],['🍋','lemon yellow sour'],
      ['🍇','grapes fruit purple'],['🍓','strawberry fruit red'],['🍒','cherry fruit red'],
      ['🍑','peach fruit'],['🥭','mango tropical fruit'],['🍍','pineapple fruit tropical'],
      ['🥝','kiwi fruit green'],['🍅','tomato red'],['🥦','broccoli green'],['🥬','leafy green vegetable'],
      ['🥒','cucumber green'],['🌽','corn maize yellow'],['🥕','carrot orange'],['🥐','croissant bread pastry'],
      ['🍞','bread loaf'],['🥖','baguette bread french'],['🧀','cheese'],['🥚','egg'],
      ['🍳','egg frying cooking breakfast'],['🥞','pancakes stack breakfast'],['🧇','waffle breakfast'],
      ['🥓','bacon breakfast'],['🥩','meat steak beef'],['🍗','chicken drumstick'],
      ['🍖','meat bone'],['🌭','hot dog sausage'],['🍔','hamburger burger'],
      ['🍟','french fries chips'],['🍕','pizza'],['🌮','taco mexican'],['🌯','burrito wrap'],
      ['🥙','falafel wrap pita'],['🍱','bento box japanese'],['🍣','sushi japanese'],
      ['🍤','shrimp fried tempura'],['🍜','noodles ramen soup'],['🍝','spaghetti pasta italian'],
      ['🍛','curry rice spicy'],['🍚','rice bowl'],['🍙','rice ball onigiri japanese'],
      ['🥮','mooncake chinese'],['🍡','dango sweet japanese'],['🧁','cupcake sweet'],
      ['🍰','cake slice birthday'],['🎂','birthday cake celebrate'],['🍮','pudding custard flan'],
      ['🍭','lollipop candy sweet'],['🍬','candy sweet'],['🍫','chocolate bar sweet'],
      ['🍿','popcorn movie snack'],['🍩','doughnut donut sweet'],['🍪','cookie sweet bake'],
      ['🌰','chestnut nut'],['🥜','peanut nut'],['🫛','pea pod vegetable green'],['🫚','ginger root spice'],['🍵','tea green cup hot'],
      ['☕','coffee hot cup morning'],['🫖','teapot tea'],
      ['🍺','beer mug drink'],['🍻','cheers beer clinking toast'],['🥂','champagne toast cheers celebrate'],
      ['🍷','wine glass red drink'],['🥃','whiskey tumbler spirit drink'],['🍸','cocktail martini drink'],
      ['🍹','tropical drink cocktail'],['🧃','juice box'],['🥤','cup straw drink soda'],
      ['🧋','bubble tea boba drink'],['🍾','champagne bottle celebrate'],
      ['🍏','green apple fruit'],['🍐','pear fruit'],['🍋‍🟩','lime green citrus'],
      ['🍌','banana fruit'],['🍉','watermelon fruit'],['🫐','blueberries fruit'],['🍈','melon honeydew'],
      ['🥥','coconut tropical'],['🍆','eggplant aubergine vegetable'],['🥑','avocado'],
      ['🌶️','hot pepper chili spicy'],['🫑','bell pepper capsicum'],['🫒','olive'],
      ['🧄','garlic'],['🧅','onion shallot'],['🥔','potato'],['🫜','root vegetable'],['🍠','sweet potato roasted'],
      ['🥯','bagel bread'],['🥨','pretzel bread'],['🧈','butter dairy'],
      ['🦴','bone dog'],['🫓','flatbread pita naan'],['🥪','sandwich'],['🧆','falafel'],['🫔','tamale wrap'],
      ['🥗','salad green'],['🥘','paella shallow pan stew'],['🫕','fondue pot'],
      ['🥫','canned food tin'],['🫙','jar preserve'],['🍲','stew pot food'],
      ['🥟','dumpling gyoza'],['🦪','oyster seafood'],
      ['🍘','rice cracker'],['🍥','fish cake swirl narutomaki'],['🥠','fortune cookie'],
      ['🍢','oden skewer'],['🍧','shaved ice dessert'],['🍨','ice cream dessert'],
      ['🍦','soft serve ice cream'],['🥧','pie shortcake dessert'],
      ['🫘','beans legumes'],['🍯','honey pot sweet'],
      ['🥛','milk glass drink'],['🫗','pouring liquid drink'],['🍼','baby bottle milk'],
      ['🧉','mate drink herbal'],['🍶','sake japanese rice wine'],
      ['🧊','ice cube cold'],['🥄','spoon utensil'],['🍴','fork knife utensil'],
      ['🍽️','fork knife plate utensil'],['🥣','bowl spoon cereal'],['🥡','takeout box chinese'],
      ['🥢','chopsticks asian'],['🧂','salt shaker seasoning'],
    ]},
    { icon: '🎉', title: 'Fun & Activities', emoji: [
      ['🎉','party celebrate confetti'],['🎊','confetti ball celebrate'],
      ['🎈','balloon party'],['🎁','gift present wrap'],['🎀','ribbon bow'],
      ['🎆','fireworks celebrate'],['🎇','sparkler firework'],
      ['🎭','theater drama masks arts'],['🎨','art paint palette creative'],
      ['🎪','circus tent performance'],['🎢','roller coaster theme park'],
      ['🎡','ferris wheel fair'],['🎠','carousel merry go round'],
      ['🎯','bullseye target dart aim'],['🎳','bowling pins'],['🎲','dice game chance'],
      ['🎮','game controller video gaming'],['🎰','slot machine gamble luck'],
      ['🃏','joker card game wild'],['🀄','mahjong game tiles'],['♟️','chess pawn strategy'],
      ['🎸','guitar music rock'],['🎹','piano keyboard music'],['🎻','violin music strings'],
      ['🥁','drum music percussion'],['🎺','trumpet music brass'],['🪊','trombone brass instrument jazz slide music'],['🪗','accordion music'],['🪈','flute music woodwind'],['🪇','maracas music shaker'],
      ['🎤','microphone sing karaoke'],['🎧','headphones music listen'],
      ['🎬','clapper film movie action'],['🎟️','ticket event admission'],
      ['🏆','trophy win champion'],['🥇','gold medal first place'],
      ['🥈','silver medal second place'],['🥉','bronze medal third place'],['🏅','medal award'],
      ['⚽','soccer football sport'],['🏀','basketball sport'],['🏈','football american sport'],
      ['⚾','baseball sport'],['🎾','tennis sport'],['🏸','badminton sport'],
      ['🏊','swimming swim sport'],['🏄','surf wave sport'],['🚴','cycling bike sport'],
      ['🧘','yoga meditate calm'],['🤸','gymnastics cartwheel'],
      ['💃','dance woman'],['🕺','dance man'],
      ['🎃','halloween pumpkin jack lantern spooky'],['🎄','christmas tree holiday'],
      ['🎑','moon viewing japanese'],['🎐','wind chime'],['🧨','firecracker chinese new year'],
      ['🪅','piñata party'],['🪆','nesting doll matryoshka russian'],['🪄','magic wand trick'],
      ['🥎','softball baseball sport'],['🏐','volleyball sport'],['🏉','rugby football sport'],
      ['🥏','flying disc frisbee'],['🎱','billiards pool eight ball'],['🪀','yo-yo toy'],
      ['🏓','table tennis ping pong'],['🏒','ice hockey stick puck'],['🏑','field hockey stick'],
      ['🥍','lacrosse stick'],['🏏','cricket bat ball'],['🪃','boomerang throw'],
      ['🥅','goal net sport'],['⛳','golf hole flag'],['🪁','slingshot catapult'],
      ['🛝','playground slide'],['🏹','bow arrow archery'],['🎣','fishing rod fish'],
      ['🤿','diving mask snorkel scuba'],['🥊','boxing glove punch'],['🥋','martial arts kimono karate'],
      ['🎽','running shirt athletics'],['🛹','skateboard skate'],['🛼','roller skate'],
      ['🛷','sled sledge'],['⛸️','ice skate figure skating'],['🥌','curling stone'],
      ['🎿','ski skiing snow'],['⛷️','skier skiing'],['🏂','snowboarder snowboard'],
      ['🪂','parachute skydive'],['🏋️','weight lifting gym'],['🤼','wrestling sport'],
      ['⛹️','basketball bouncing sport'],['🤺','fencing sword sport'],['🤾','handball sport'],
      ['🏌️','golf golfer'],['🏇','horse racing jockey'],['🤽','water polo sport'],
      ['🚣','rowing boat row'],['🧗','climbing rock wall'],['🚵','mountain biking cycling'],
      ['🎖️','military medal award'],['🏵️','rosette award decoration'],['🎗️','ribbon awareness'],
      ['🎫','ticket stub event'],['🤹','juggling circus performance'],['🩰','ballet shoe dance'],
      ['🫟','splatter liquid'],['🎼','musical score sheet music'],['🪘','long drum bongo'],
      ['🎷','saxophone sax jazz'],['🪕','banjo string music'],['🪉','harp string music'],
      ['🧩','puzzle piece jigsaw'],
    ]},
    { icon: '💫', title: 'Symbols', emoji: [
      ['✅','check mark done yes correct'],['❌','cross mark no wrong incorrect'],
      ['❓','question mark unknown'],['❗','exclamation mark important'],['‼️','double exclamation urgent'],
      ['💯','hundred percent perfect score'],['🔥','fire hot trending lit'],['⚡','lightning bolt fast energy'],
      ['💧','water drop'],['💨','dash wind blow'],['💎','diamond gem jewel precious'],
      ['🔮','crystal ball magic fortune'],['🧿','nazar evil eye amulet protection'],
      ['💡','light bulb idea'],['🕯️','candle flame light romantic'],['⚠️','warning caution danger'],
      ['🚫','no prohibited banned'],['⛔','stop no entry'],['🔞','no under 18 adult explicit'],
      ['💤','sleep zzz tired'],['💢','anger symbol frustrated'],['💥','explosion boom impact'],
      ['💦','water sweat splash'],['💫','dizzy star spin'],
      ['💬','speech bubble chat message'],['💭','thought bubble thinking'],['🗯️','anger bubble shout'],
      ['✉️','envelope mail letter send'],['📩','email incoming'],
      ['📱','phone mobile cell'],['💻','laptop computer'],['⌚','watch clock time'],
      ['📷','camera photo picture'],['🔑','key unlock access'],['🔒','lock secure private'],
      ['🔔','bell notification alert'],['📢','loudspeaker announce'],
      ['♥️','heart suit card'],['♠️','spade suit card'],
      ['♦️','diamond suit card'],['♣️','club suit card'],
      ['🔴','red circle'],['🟠','orange circle'],['🟡','yellow circle'],
      ['🟢','green circle'],['🔵','blue circle'],['🟣','purple circle'],
      ['⚫','black circle'],['⚪','white circle'],
      ['🏳️','white flag surrender'],['🏴','black flag pirate'],['🚩','red flag warning'],
      ['🆗','ok button'],['🆙','up button'],['🆒','cool button'],['🆕','new button fresh'],
      ['🆓','free button gratis'],['🔅','dim brightness low'],['🔆','bright brightness high'],
      ['📶','signal bars wifi'],['🛜','wireless wifi signal'],['♾️','infinity forever'],['⚜️','fleur de lis gold'],
      ['🪯','khanda sikh symbol'],['🪭','folding fan hand'],['🪮','hair pick comb afro'],
      ['🔱','trident symbol poseidon'],['☯️','yin yang balance'],['☮️','peace symbol'],
      ['✝️','cross christian'],['☪️','star crescent muslim'],['🕉️','om hindu'],
      ['☸️','dharma wheel buddhist'],['✡️','star of david jewish'],
      ['🔯','dotted six-pointed star'],['🕎','menorah hanukkah jewish'],
      ['☦️','orthodox cross christian'],['🛐','place of worship religion'],
      ['⛎','ophiuchus zodiac'],['♈','aries zodiac'],['♉','taurus zodiac'],
      ['♊','gemini zodiac'],['♋','cancer zodiac'],['♌','leo zodiac'],
      ['♍','virgo zodiac'],['♎','libra zodiac'],['♏','scorpio zodiac'],
      ['♐','sagittarius zodiac'],['♑','capricorn zodiac'],['♒','aquarius zodiac'],
      ['♓','pisces zodiac'],
      ['🆔','id button'],['⚛️','atom science'],['☢️','radioactive hazard'],['☣️','biohazard'],
      ['📴','phone off'],['📳','vibration mode'],
      ['🈶','japanese not free'],['🈚','japanese free'],['🈸','japanese apply'],
      ['🈺','japanese open'],['🈷️','japanese monthly'],['✴️','eight pointed star'],
      ['🆚','vs versus'],['🉐','japanese bargain'],['㊙️','japanese secret'],
      ['㊗️','japanese congratulations'],['🈴','japanese passing'],['🈵','japanese no vacancy'],
      ['🈹','japanese discount'],['🈲','japanese prohibited'],
      ['🅰️','blood type a'],['🅱️','blood type b'],['🆎','ab blood type'],
      ['🆑','cl button'],['🅾️','blood type o'],['🆘','sos emergency'],
      ['⭕','hollow red circle'],['🛑','stop sign octagon'],['📛','name badge'],
      ['♨️','hot springs onsen'],['🚷','no pedestrians'],['🚯','no littering'],
      ['🚳','no bicycles'],['🚱','non-potable water'],['📵','no mobile phones'],
      ['🚭','no smoking'],['❕','white exclamation'],['❔','white question'],['⁉️','exclamation question'],
      ['〽️','part alternation mark'],['🚸','children crossing'],
      ['🔰','beginner japanese'],['♻️','recycling recycle'],
      ['🈯','japanese reserved'],['💹','chart yen'],['❇️','sparkle star'],
      ['✳️','eight spoked asterisk'],['❎','cross mark button'],['🌐','globe internet web'],
      ['💠','diamond blue'],['Ⓜ️','circled m metro'],
      ['🏧','atm cash machine'],['🚾','water closet wc restroom'],
      ['♿','wheelchair accessible disability'],['🅿️','parking'],['🛗','elevator lift'],
      ['🈳','japanese vacancy'],['🈂️','japanese service charge'],
      ['🛂','passport control'],['🛃','customs'],['🛄','baggage claim'],['🛅','left luggage'],
      ['🚹','mens bathroom'],['🚺','womens bathroom'],['🚼','baby bathroom'],
      ['🚻','restroom bathroom'],['🚮','litter bin'],['🎦','cinema film'],
      ['🔣','input symbols'],['ℹ️','information'],['🔤','abc letters'],
      ['🔡','abc lowercase'],['🔠','abc uppercase'],['🆖','ng not good'],
      ['0️⃣','zero keycap'],['1️⃣','one keycap'],['2️⃣','two keycap'],
      ['3️⃣','three keycap'],['4️⃣','four keycap'],['5️⃣','five keycap'],
      ['6️⃣','six keycap'],['7️⃣','seven keycap'],['8️⃣','eight keycap'],
      ['9️⃣','nine keycap'],['🔟','ten keycap'],['🔢','1234 numbers'],
      ['#️⃣','hash keycap number'],['*️⃣','asterisk keycap'],
      ['⏏️','eject button'],['▶️','play button'],['⏸️','pause button'],
      ['⏯️','play pause toggle'],['⏹️','stop button'],['⏺️','record button'],
      ['⏭️','next track skip'],['⏮️','previous track'],['⏩','fast forward'],
      ['⏪','rewind fast back'],['⏫','fast up'],['⏬','fast down'],
      ['◀️','reverse left'],['🔼','up button'],['🔽','down button'],
      ['➡️','right arrow'],['⬅️','left arrow'],['⬆️','up arrow'],['⬇️','down arrow'],
      ['↗️','up right arrow'],['↘️','down right arrow'],['↙️','down left arrow'],['↖️','up left arrow'],
      ['↕️','up down arrow'],['↔️','left right arrow'],
      ['↪️','left arrow curving right'],['↩️','right arrow curving left'],
      ['⤴️','right arrow curving up'],['⤵️','right arrow curving down'],
      ['🔀','shuffle random'],['🔁','repeat loop'],['🔂','repeat once'],
      ['🔄','counterclockwise refresh'],['🔃','clockwise arrows'],
      ['🎵','musical note'],['🎶','musical notes'],
      ['➕','plus add'],['➖','minus subtract'],['➗','divide division'],
      ['✖️','multiply times cross'],['🟰','equals sign'],['💲','dollar sign'],
      ['💱','currency exchange'],['™️','trademark tm'],['©️','copyright'],['®️','registered'],
      ['〰️','wavy dash'],['➰','curly loop'],['➿','double curly loop'],
      ['🔚','end back arrow'],['🔙','back arrow'],['🔛','on arrow'],
      ['🔝','top arrow'],['🔜','soon arrow'],['✔️','check mark heavy'],['☑️','check box tick'],
      ['🔘','radio button'],
      ['🟤','brown circle'],['🔺','red triangle up'],['🔻','red triangle down'],
      ['🔸','small orange diamond'],['🔹','small blue diamond'],
      ['🔶','large orange diamond'],['🔷','large blue diamond'],
      ['🔳','white square button'],['🔲','black square button'],
      ['▪️','black small square'],['▫️','white small square'],
      ['◾','black medium small square'],['◽','white medium small square'],
      ['◼️','black medium square'],['◻️','white medium square'],
      ['⬛','black large square'],['⬜','white large square'],
      ['🟧','orange square'],['🟦','blue square'],['🟥','red square'],
      ['🟫','brown square'],['🟪','purple square'],['🟩','green square'],['🟨','yellow square'],
      ['🔈','speaker low'],['🔇','muted speaker'],['🔉','speaker medium'],
      ['🔊','speaker loud volume'],['🔕','bell muted no'],['📣','megaphone cheer'],
      ['🗨️','speech bubble left'],
      ['🎴','flower playing card'],
      ['🕐','one oclock time'],['🕑','two oclock time'],['🕒','three oclock time'],
      ['🕓','four oclock time'],['🕔','five oclock time'],['🕕','six oclock time'],
      ['🕖','seven oclock time'],['🕗','eight oclock time'],['🕘','nine oclock time'],
      ['🕙','ten oclock time'],['🕚','eleven oclock time'],['🕛','twelve oclock time'],
      ['🕜','one thirty time'],['🕝','two thirty time'],['🕞','three thirty time'],
      ['🕟','four thirty time'],['🕠','five thirty time'],['🕡','six thirty time'],
      ['🕢','seven thirty time'],['🕣','eight thirty time'],['🕤','nine thirty time'],
      ['🕥','ten thirty time'],['🕦','eleven thirty time'],['🕧','twelve thirty time'],
      ['♀️','female sign woman'],['♂️','male sign man'],['⚧','transgender symbol'],
      ['⚕️','medical symbol caduceus'],
    ]},
    { icon: '📱', title: 'Objects', emoji: [
      ['⌚','watch clock wrist'],['📱','phone mobile cell'],['📲','phone arrow call'],
      ['💻','laptop computer'],['⌨️','keyboard type'],['🖥️','desktop monitor computer'],
      ['🖨️','printer'],['🖱️','mouse computer'],['🖲️','trackball'],
      ['🕹️','joystick game controller'],['🗜️','clamp compression'],
      ['💽','minidisc floppy old'],['💾','floppy disk save old'],['💿','cd disc'],
      ['📀','dvd disc'],['📼','videocassette vhs tape'],
      ['📷','camera photo'],['📸','camera flash selfie'],['📹','video camera film'],
      ['🎥','movie camera cinema'],['📽️','film projector cinema'],['🎞️','film strip frames'],
      ['📞','telephone receiver'],['☎️','telephone old rotary'],['📟','pager beeper'],
      ['📠','fax machine'],['📺','television tv screen'],['📻','radio'],
      ['🎙️','studio microphone podcast'],['🎚️','level slider audio'],['🎛️','control knobs audio'],
      ['🧭','compass navigation'],['⏱️','stopwatch timer'],['⏲️','timer clock'],
      ['⏰','alarm clock wake'],['🕰️','mantelpiece clock'],['⌛','hourglass done'],
      ['⏳','hourglass sand time'],['📡','satellite dish antenna signal'],
      ['🔋','battery charge'],['🪫','low battery dead'],['🔌','plug electric power'],
      ['💡','light bulb idea'],['🔦','flashlight torch'],['🕯️','candle flame light'],
      ['🪔','oil lamp diya'],['🧯','fire extinguisher safety'],['🛢️','oil drum barrel'],
      ['💸','money wings flying cash'],['💵','dollar bill usd'],['💴','yen bill jpy'],
      ['💶','euro bill eur'],['💷','pound sterling gbp'],['🪙','coin money'],
      ['💰','money bag cash'],['💳','credit card payment'],['🪪','id card identity badge'],
      ['💎','gem diamond jewel'],['🪎','treasure chest gems gold loot wealth prize'],['⚖️','balance scale justice'],['🪜','ladder climb'],
      ['🧰','toolbox tools'],['🪛','screwdriver tool'],['🔧','wrench spanner tool'],
      ['🔨','hammer tool'],['⚒️','hammer pick tool'],['🛠️','hammer wrench repair'],
      ['⛏️','pick axe mine'],['🪏','trowel garden'],['🪚','saw wood carpentry'],
      ['🔩','bolt nut screw'],['⚙️','gear cog settings'],['🪤','mousetrap snap'],
      ['🧱','brick wall building'],['⛓️','chain link'],['⛓️‍💥','broken chain free freedom'],['🧲','magnet attract'],
      ['🔫','gun pistol water squirt'],['💣','bomb explosion'],['🪓','axe hatchet chop'],
      ['🔪','knife kitchen dagger'],['🗡️','dagger sword'],['⚔️','crossed swords battle'],
      ['🛡️','shield protect defend'],['🚬','cigarette smoking'],
      ['⚰️','coffin funeral death'],['🪦','gravestone tombstone rip'],
      ['⚱️','urn funeral ashes'],['🏺','amphora ancient vase'],
      ['🔮','crystal ball magic fortune'],['📿','prayer beads rosary'],
      ['🧿','nazar evil eye amulet'],['🪬','hamsa hand protection'],['💈','barber pole hair'],
      ['⚗️','alembic chemistry flask'],['🔭','telescope astronomy space'],
      ['🔬','microscope science lab'],['🕳️','hole empty'],
      ['🩻','x-ray scan medical'],['🩹','bandage plaster wound'],['🩺','stethoscope doctor'],
      ['💊','pill medicine tablet drug'],['💉','syringe injection needle'],
      ['🩸','blood drop medical'],['🧬','dna genetics'],
      ['🦠','microbe germ bacteria virus'],['🧫','petri dish lab culture'],
      ['🧪','test tube lab experiment'],['🌡️','thermometer temperature fever'],
      ['🧹','broom sweep clean'],['🪠','plunger toilet unclog'],
      ['🧺','basket laundry'],['🧻','toilet paper roll'],['🚽','toilet bathroom'],
      ['🚰','faucet tap water'],['🚿','shower bathroom'],['🛁','bathtub bath'],
      ['🧼','soap clean wash'],['🪥','toothbrush teeth'],['🪒','razor shave'],
      ['🧽','sponge clean scrub'],['🪣','bucket pail water'],['🧴','lotion cream bottle'],
      ['🛎️','bell service hotel'],['🔑','key unlock door'],['🗝️','old key antique'],
      ['🚪','door entry exit'],['🪑','chair seat furniture'],['🛋️','couch sofa furniture'],
      ['🛏️','bed sleep furniture'],['🧸','teddy bear toy stuffed'],
      ['🖼️','picture frame art painting'],['🪞','mirror reflection'],['🪟','window'],
      ['🛍️','shopping bags retail'],['🛒','shopping cart trolley'],
      ['🎈','balloon party'],['🎏','carp streamer decoration'],['🎎','japanese dolls hina'],
      ['🏮','red lantern chinese'],['🪩','disco ball dance party'],['🧧','red envelope hongbao'],
      ['✉️','envelope mail letter'],['📩','email incoming'],['📨','incoming envelope'],
      ['📧','email electronic mail'],['📥','inbox tray'],['📤','outbox tray'],
      ['📦','package box parcel'],['🏷️','label tag price'],['🪧','placard sign'],
      ['📪','mailbox empty closed'],['📫','mailbox full closed'],
      ['📬','mailbox full open'],['📭','mailbox empty open'],
      ['📮','postbox pillar red'],['📯','postal horn bugle'],
      ['📜','scroll ancient document'],['📃','page curl document'],['📄','page document'],
      ['📑','bookmark tabs document'],['🧾','receipt bill payment'],
      ['📊','bar chart graph data'],['📈','chart up growth'],['📉','chart down decline'],
      ['🗒️','notepad spiral memo'],['🗓️','calendar spiral planner'],
      ['📆','tearoff calendar date'],['📅','calendar date'],['🗑️','wastebasket trash delete'],
      ['📇','card index rolodex'],['🗃️','card file box'],['🗳️','ballot box vote'],
      ['🗄️','file cabinet drawer'],['📋','clipboard document'],
      ['📁','file folder'],['📂','open folder files'],['🗂️','card index dividers'],
      ['🗞️','newspaper rolled'],['📰','newspaper press'],
      ['📓','notebook'],['📔','notebook cover'],['📒','ledger book'],
      ['📕','book red closed'],['📗','book green'],['📘','book blue'],
      ['📙','book orange'],['📚','books stack library'],['📖','open book read'],
      ['🔖','bookmark'],['🧷','safety pin'],['🔗','link chain hyperlink'],
      ['📎','paperclip attach'],['🖇️','paperclips linked'],
      ['📐','triangular ruler geometry'],['📏','ruler measure'],['🧮','abacus calculate'],
      ['📌','pushpin pinned map'],['📍','round pushpin location'],['✂️','scissors cut'],
      ['🖊️','pen write'],['🖋️','fountain pen write'],['✒️','black nib pen'],
      ['🖌️','paintbrush art'],['🖍️','crayon color draw'],['📝','memo note write'],
      ['✏️','pencil write draw'],['🔍','magnifying glass search left'],
      ['🔎','magnifying glass search right'],['🔏','locked pen'],
      ['🔐','locked key secure'],['🔒','locked secure'],['🔓','unlocked open'],
    ]},
    { icon: '✈️', title: 'Travel & Places', emoji: [
      ['🚗','automobile car driving vehicle'],['🚕','taxi cab car'],['🚙','car suv automobile'],['🛻','pickup truck'],
      ['🚐','minibus van'],['🚌','bus transit'],['🚎','trolleybus'],
      ['🏎️','racing car formula one'],['🚓','police car cop'],['🚑','ambulance emergency'],
      ['🚒','fire truck engine'],['🚚','delivery truck'],['🚛','articulated lorry semi truck'],
      ['🚜','tractor farm'],['🛴','kick scooter'],['🚲','bicycle bike'],
      ['🛵','motor scooter moped'],['🏍️','motorcycle motorbike'],['🛺','auto rickshaw tuk tuk'],
      ['🛞','wheel tire'],['🚨','siren police light emergency'],
      ['🚔','oncoming police car'],['🚍','oncoming bus'],['🚘','oncoming car'],['🚖','oncoming taxi'],
      ['🦯','white cane blind mobility'],['🦽','manual wheelchair disability'],
      ['🦼','motorized wheelchair disability'],['🩼','crutch mobility aid'],
      ['🚡','aerial tramway cable car'],['🚠','mountain cableway'],['🚟','suspension railway'],
      ['🚃','railway car train'],['🚋','tram car'],['🚞','mountain railway'],
      ['🚝','monorail'],['🚄','bullet train shinkansen high speed'],['🚅','bullet train fast'],
      ['🚈','light rail'],['🚂','steam locomotive train'],['🚆','train'],
      ['🚇','metro subway underground'],['🚊','tram streetcar'],['🚉','station train'],
      ['✈️','airplane plane flight travel'],['🛫','takeoff departure airplane'],
      ['🛬','landing arrival airplane'],['🛩️','small plane aircraft'],
      ['💺','seat airplane chair'],['🛰️','satellite space orbit'],
      ['🚀','rocket space launch'],['🛸','ufo flying saucer'],['🚁','helicopter'],
      ['🛶','canoe kayak boat'],['⛵','sailboat sailing'],['🚤','speedboat motorboat'],
      ['🛥️','motor boat'],['🛳️','passenger ship cruise'],['⛴️','ferry boat'],
      ['🚢','ship cruise liner'],['🛟','life ring preserver safety'],
      ['⚓','anchor ship port'],['🪝','hook crane'],['⛽','fuel pump gas station'],
      ['🚧','construction barrier roadwork'],['🚦','traffic light vertical'],
      ['🚥','traffic light horizontal'],['🚏','bus stop'],['🗺️','world map travel'],
      ['🗿','moai easter island statue'],['🗽','statue of liberty new york'],
      ['🗼','tokyo tower japan'],['🏰','castle european'],['🏯','japanese castle'],
      ['🏟️','stadium arena sports'],['⛲','fountain park'],['⛱️','umbrella beach sun'],
      ['🏖️','beach sand ocean'],['🏜️','desert dry arid'],['🗻','mount fuji japan'],
      ['🏕️','camping tent outdoors'],['⛺','tent camping'],
      ['🏠','house home'],['🏡','house garden home'],['🏘️','houses neighborhood'],
      ['🏚️','derelict house abandoned'],['🛖','hut cabin'],['🏗️','building construction'],
      ['🏭','factory industrial'],['🏢','office building'],['🏬','department store shopping'],
      ['🏣','japanese post office'],['🏤','post office'],['🏥','hospital medical'],
      ['🏦','bank finance'],['🏨','hotel lodging'],['🏪','convenience store shop'],
      ['🏫','school education'],['🏩','love hotel'],['🏛️','classical building pillars'],
      ['⛪','church christian'],['🕌','mosque islam muslim'],['🕍','synagogue jewish'],
      ['🛕','hindu temple'],['🕋','kaaba mecca islam'],['⛩️','shinto shrine japanese'],
      ['🛤️','railway track'],['🛣️','motorway highway road'],['🗾','japan map island'],
      ['🏞️','national park landscape'],['🌇','sunset city buildings'],
      ['🌆','city at dusk buildings'],['🏙️','cityscape skyline'],
      ['🌃','night city stars'],['🌉','bridge night city'],['🌁','foggy bridge'],
    ]},
    { icon: '👗', title: 'Clothing', emoji: [
      ['🧥','coat jacket outerwear'],['🥼','lab coat doctor'],['🦺','safety vest hi-vis'],
      ['👔','necktie dress shirt suit'],['👗','dress woman'],['👘','kimono japanese'],
      ['🥻','sari india'],['👙','bikini swimwear'],['🩱','one-piece swimsuit'],
      ['👚','womens top clothes'],['👕','t-shirt tee'],['👖','jeans pants denim'],
      ['🩲','briefs underwear'],['🩳','shorts'],
      ['👠','high heel shoe stiletto'],['👡','sandal womens shoe'],['👢','boot womans'],
      ['👞','oxford dress shoe mens'],['👟','sneaker trainer running shoe'],
      ['🥾','hiking boot trail'],['🩴','thong sandal flip flop'],['🥿','flat shoe ballet'],
      ['🧦','socks'],['🧤','gloves mittens'],['🧣','scarf'],
      ['🎩','top hat fancy'],['🧢','baseball cap hat billed'],['👒','sun hat womans'],
      ['🎓','graduation cap mortarboard'],['⛑️','rescue helmet hard hat'],['🪖','military helmet'],
      ['👑','crown king queen royal'],
      ['👓','glasses spectacles'],['🕶️','sunglasses cool shades'],['🥽','goggles safety'],
      ['👜','handbag purse'],['👛','coin purse wallet'],['👝','clutch bag pouch'],
      ['💼','briefcase work business'],['🎒','backpack rucksack school'],['🧳','luggage suitcase travel'],
      ['🌂','umbrella closed rain'],
      ['🪢','knot rope'],['🧶','yarn ball wool knit'],['🧵','thread sewing needle'],['🪡','sewing needle thread'],
    ]},
    { icon: '🚩', title: 'Flags', emoji: [
      ['🏳️','white flag surrender'],['🏴','black flag'],['🏴‍☠️','pirate flag skull crossbones jolly roger'],
      ['🏁','chequered flag racing finish'],['🚩','red flag warning'],
      ['🏳️‍🌈','rainbow flag pride lgbtq gay'],['🏳️‍⚧️','transgender flag trans pride'],
      ['🎌','crossed flags japan'],
      ['🇺🇳','united nations un'],
      ['🇦🇫','afghanistan'],['🇦🇽','aland islands'],['🇦🇱','albania'],['🇩🇿','algeria'],
      ['🇦🇸','american samoa'],['🇦🇩','andorra'],['🇦🇴','angola'],['🇦🇮','anguilla'],
      ['🇦🇶','antarctica'],['🇦🇬','antigua barbuda'],['🇦🇷','argentina'],
      ['🇦🇲','armenia'],['🇦🇼','aruba'],['🇦🇺','australia'],['🇦🇹','austria'],['🇦🇿','azerbaijan'],
      ['🇧🇸','bahamas'],['🇧🇭','bahrain'],['🇧🇩','bangladesh'],['🇧🇧','barbados'],
      ['🇧🇾','belarus'],['🇧🇪','belgium'],['🇧🇿','belize'],['🇧🇯','benin'],['🇧🇲','bermuda'],
      ['🇧🇹','bhutan'],['🇧🇴','bolivia'],['🇧🇦','bosnia herzegovina'],['🇧🇼','botswana'],
      ['🇧🇷','brazil'],['🇮🇴','british indian ocean territory'],['🇻🇬','british virgin islands'],
      ['🇧🇳','brunei'],['🇧🇬','bulgaria'],['🇧🇫','burkina faso'],['🇧🇮','burundi'],
      ['🇰🇭','cambodia'],['🇨🇲','cameroon'],['🇨🇦','canada'],['🇮🇨','canary islands'],
      ['🇨🇻','cape verde cabo verde'],['🇧🇶','caribbean netherlands'],['🇰🇾','cayman islands'],
      ['🇨🇫','central african republic car'],['🇹🇩','chad'],['🇨🇱','chile'],['🇨🇳','china'],
      ['🇨🇽','christmas island'],['🇨🇨','cocos keeling islands'],['🇨🇴','colombia'],
      ['🇰🇲','comoros'],['🇨🇬','congo republic'],['🇨🇩','congo democratic republic drc'],
      ['🇨🇰','cook islands'],['🇨🇷','costa rica'],['🇨🇮','ivory coast cote divoire'],
      ['🇭🇷','croatia'],['🇨🇺','cuba'],['🇨🇼','curacao'],['🇨🇾','cyprus'],['🇨🇿','czech czechia'],
      ['🇩🇰','denmark'],['🇩🇯','djibouti'],['🇩🇲','dominica'],['🇩🇴','dominican republic'],
      ['🇪🇨','ecuador'],['🇪🇬','egypt'],['🇸🇻','el salvador'],['🇬🇶','equatorial guinea'],
      ['🇪🇷','eritrea'],['🇪🇪','estonia'],['🇸🇿','eswatini swaziland'],['🇪🇹','ethiopia'],
      ['🇪🇺','european union eu europe'],
      ['🇫🇰','falkland islands malvinas'],['🇫🇴','faroe islands'],['🇫🇯','fiji'],
      ['🇫🇮','finland'],['🇫🇷','france'],['🇬🇫','french guiana'],['🇵🇫','french polynesia'],
      ['🇹🇫','french southern territories'],
      ['🇬🇦','gabon'],['🇬🇲','gambia'],['🇬🇪','georgia'],['🇩🇪','germany'],['🇬🇭','ghana'],
      ['🇬🇮','gibraltar'],['🇬🇷','greece'],['🇬🇱','greenland'],['🇬🇩','grenada'],
      ['🇬🇵','guadeloupe'],['🇬🇺','guam'],['🇬🇹','guatemala'],['🇬🇬','guernsey'],
      ['🇬🇳','guinea'],['🇬🇼','guinea-bissau'],['🇬🇾','guyana'],
      ['🇭🇹','haiti'],['🇭🇳','honduras'],['🇭🇰','hong kong'],['🇭🇺','hungary'],
      ['🇮🇸','iceland'],['🇮🇳','india'],['🇮🇩','indonesia'],['🇮🇷','iran'],['🇮🇶','iraq'],
      ['🇮🇪','ireland'],['🇮🇲','isle of man'],['🇮🇱','israel'],['🇮🇹','italy'],
      ['🇯🇲','jamaica'],['🇯🇵','japan'],['🇯🇪','jersey'],['🇯🇴','jordan'],
      ['🇰🇿','kazakhstan'],['🇰🇪','kenya'],['🇰🇮','kiribati'],['🇽🇰','kosovo'],
      ['🇰🇼','kuwait'],['🇰🇬','kyrgyzstan'],
      ['🇱🇦','laos'],['🇱🇻','latvia'],['🇱🇧','lebanon'],['🇱🇸','lesotho'],['🇱🇷','liberia'],
      ['🇱🇾','libya'],['🇱🇮','liechtenstein'],['🇱🇹','lithuania'],['🇱🇺','luxembourg'],
      ['🇲🇴','macao macau'],['🇲🇰','north macedonia'],['🇲🇬','madagascar'],['🇲🇼','malawi'],
      ['🇲🇾','malaysia'],['🇲🇻','maldives'],['🇲🇱','mali'],['🇲🇹','malta'],
      ['🇲🇭','marshall islands'],['🇲🇶','martinique'],['🇲🇷','mauritania'],['🇲🇺','mauritius'],
      ['🇾🇹','mayotte'],['🇲🇽','mexico'],['🇫🇲','micronesia'],['🇲🇩','moldova'],
      ['🇲🇨','monaco'],['🇲🇳','mongolia'],['🇲🇪','montenegro'],['🇲🇸','montserrat'],
      ['🇲🇦','morocco'],['🇲🇿','mozambique'],['🇲🇲','myanmar burma'],
      ['🇳🇦','namibia'],['🇳🇷','nauru'],['🇳🇵','nepal'],['🇳🇱','netherlands holland'],
      ['🇳🇨','new caledonia'],['🇳🇿','new zealand'],['🇳🇮','nicaragua'],['🇳🇪','niger'],
      ['🇳🇬','nigeria'],['🇳🇺','niue'],['🇳🇫','norfolk island'],['🇰🇵','north korea'],
      ['🇲🇵','northern mariana islands'],['🇳🇴','norway'],
      ['🇴🇲','oman'],
      ['🇵🇰','pakistan'],['🇵🇼','palau'],['🇵🇸','palestine'],['🇵🇦','panama'],
      ['🇵🇬','papua new guinea png'],['🇵🇾','paraguay'],['🇵🇪','peru'],['🇵🇭','philippines'],
      ['🇵🇳','pitcairn islands'],['🇵🇱','poland'],['🇵🇹','portugal'],['🇵🇷','puerto rico'],
      ['🇶🇦','qatar'],
      ['🇷🇪','reunion'],['🇷🇴','romania'],['🇷🇺','russia'],['🇷🇼','rwanda'],
      ['🇧🇱','saint barthelemy'],['🇸🇭','saint helena'],['🇰🇳','saint kitts nevis'],
      ['🇱🇨','saint lucia'],['🇵🇲','saint pierre miquelon'],['🇻🇨','saint vincent grenadines'],
      ['🇼🇸','samoa'],['🇸🇲','san marino'],['🇸🇹','sao tome principe'],['🇨🇶','sark'],
      ['🇸🇦','saudi arabia'],['🇸🇳','senegal'],['🇷🇸','serbia'],['🇸🇨','seychelles'],
      ['🇸🇱','sierra leone'],['🇸🇬','singapore'],['🇸🇽','sint maarten'],['🇸🇰','slovakia'],
      ['🇸🇮','slovenia'],['🇸🇧','solomon islands'],['🇸🇴','somalia'],['🇿🇦','south africa'],
      ['🇬🇸','south georgia south sandwich islands'],['🇰🇷','south korea'],['🇸🇸','south sudan'],
      ['🇪🇸','spain'],['🇱🇰','sri lanka'],['🇸🇩','sudan'],['🇸🇷','suriname'],
      ['🇸🇪','sweden'],['🇨🇭','switzerland'],['🇸🇾','syria'],
      ['🇹🇼','taiwan'],['🇹🇯','tajikistan'],['🇹🇿','tanzania'],['🇹🇭','thailand'],
      ['🇹🇱','timor-leste east timor'],['🇹🇬','togo'],['🇹🇰','tokelau'],['🇹🇴','tonga'],
      ['🇹🇹','trinidad tobago'],['🇹🇳','tunisia'],['🇹🇷','turkey turkiye'],
      ['🇹🇲','turkmenistan'],['🇹🇨','turks caicos islands'],['🇹🇻','tuvalu'],
      ['🇺🇬','uganda'],['🇺🇦','ukraine'],['🇦🇪','united arab emirates uae'],
      ['🇬🇧','united kingdom uk britain'],['🏴󠁧󠁢󠁥󠁮󠁧󠁿','england'],['🏴󠁧󠁢󠁳󠁣󠁴󠁿','scotland'],['🏴󠁧󠁢󠁷󠁬󠁳󠁿','wales'],
      ['🇺🇸','united states usa america'],['🇻🇮','us virgin islands'],['🇺🇲','us outlying islands'],
      ['🇺🇾','uruguay'],['🇺🇿','uzbekistan'],
      ['🇻🇺','vanuatu'],['🇻🇦','vatican city holy see'],['🇻🇪','venezuela'],['🇻🇳','vietnam'],
      ['🇼🇫','wallis futuna'],['🇪🇭','western sahara'],
      ['🇾🇪','yemen'],
      ['🇿🇲','zambia'],['🇿🇼','zimbabwe'],
      ['🇦🇨','ascension island'],['🇧🇻','bouvet island'],['🇨🇵','clipperton island'],
      ['🇪🇦','ceuta melilla'],['🇩🇬','diego garcia'],['🇭🇲','heard mcdonald islands'],
      ['🇲🇫','saint martin'],['🇸🇯','svalbard jan mayen'],['🇹🇦','tristan da cunha'],
    ]},
    { icon: 'ツ', title: 'Text Art', type: 'text', emoji: [
      ['╰⋃╯',                          'penis'],
      ['(ᶅ͒)',                           'vagina'],
      ['（ ͜•人 ͜•）',                   'boobs'],
      ['（ ͜.人 ͜.）',                   'large boobs'],
      ['( . 人 . )',                     'saggy boobs'],
      ['(‿ˠ‿)',                          'ass'],
      ['𝔾𝕆𝕆𝔻 𝔹𝕆𝕐',                  'good boy'],
      ['𝔾𝕆𝕆𝔻 𝔾𝕀ℝ𝕃',                 'good girl'],
      ['b( • )( • )bies',               'boobies'],
      ['𝒫𝓁ℯ𝒶𝓈ℯ 𝒹𝒶𝒹𝒹𝓎',             'please daddy'],
      ['✨ 𝓦𝓮𝓵𝓬𝓸𝓂𝓮 ✨',              'welcome'],
      ['★𝒲ℯ𝓉 𝒹𝓇ℯ𝒶𝓂𝓈★',             'wet dreams'],
      ['¯\\_(ツ)_/¯',                   'ascii shrug'],
      ['ᕦ(ò_óˇ)ᕤ',                     'flex'],
      ['⚞^. .^⚟',                      'ascii cat'],
      ['𝄃𝄂𝄀𝄁𝄃𝄂𝄂𝄃',                  'barcode'],
      ['𒅌',                             'ascii shark'],
      ['𝓴𝓲𝓼𝓼 𝓶𝒆 𝓹𝓵𝒆𝓪𝓼𝒆',          'kiss me please'],
      ['¡ᶠᶸᶜᵏᵧₒᵤ!',                    'fuck you'],
      ['ℬ𝒾𝓽𝓬𝒽',                       'bitch'],
      ['𓆩🖤𓆪',                         'winged heart'],
      ['I ♡ ( . )( . )',                'i love boobs'],
      ['(,,•᷄ࡇ•᷅ ,,)?',               'confused'],
      ['kiss my ( ㅅ )',                 'kiss my ass'],
      ['⁶🤷⁷',                          '67'],
      ['♡𝑰 𝒍𝒐𝒗𝒆 𝒚𝒐𝒖𝒖♡',             'i love you'],
      ['₊𖥔 ℓo͟v͟ꫀ ყoυ! ۪ ׄ໑୧ ׅ𖥔ׄ', 'love you'],
      ['꧁Good morning ꧂',              'good morning'],
      ['ه 🅾 𝐈𝐧𝐬𝐭𝐚𝐠𝐫𝐚𝐦 ★',          'instagram'],
      ['𝓑𝓮𝓼𝓽𝓲𝓮🌹',                    'bestie'],
      ['୧⍤⃝💐',                        'carrying flowers'],
      ['𝐆𝐨𝐨𝐝 𝐍.ᐟ𝐠𝐡𝐭✨️🌛',           'good night'],
    ]},
  ];

  const showFavEmoji = settings.prefs?.showFavEmoji !== false;
  win.webContents.executeJavaScript(`(function() {
    if (document.getElementById('lit-emoji-picker')) return;

    // Sync server-side preference to localStorage
    localStorage.setItem('lit_emoji_favs_on', ${JSON.stringify(showFavEmoji ? '1' : '0')});

    var CATS = ${JSON.stringify(CATS)};

    var s = document.createElement('style');
    s.textContent =
      '#lit-emoji-picker{position:fixed;width:340px;background:#1a1a2a;border:1px solid #3a3a4a;' +
      'border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,0.6);z-index:99999;' +
      'display:none;flex-direction:column;overflow:hidden;font-family:system-ui,sans-serif;}' +
      '#lit-emoji-search-wrap{padding:6px 6px 4px;background:#0f0f17;flex-shrink:0;}' +
      '#lit-emoji-search{width:100%;padding:5px 9px;background:#1a1a2a;border:1px solid #3a3a4a;' +
      'border-radius:6px;color:#e0e0e8;font-size:13px;outline:none;box-sizing:border-box;}' +
      '#lit-emoji-search:focus{border-color:#7c5cbf;}' +
      '#lit-emoji-search::placeholder{color:#555;}' +
      '#lit-emoji-tabs{display:flex;background:#0f0f17;padding:4px;gap:2px;flex-shrink:0;}' +
      '.lit-emoji-tab{flex:1;padding:5px 0;text-align:center;cursor:pointer;border-radius:5px;' +
      'font-size:15px;opacity:0.5;transition:opacity 0.12s,background 0.12s;}' +
      '.lit-emoji-tab:hover{opacity:0.85;}' +
      '.lit-emoji-tab.active{opacity:1;background:#2a2a3a;}' +
      '#lit-emoji-grid{display:flex;flex-wrap:wrap;padding:6px;gap:1px;' +
      'max-height:220px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#2a2a3a #0f0f17;}' +
      '#lit-emoji-grid::-webkit-scrollbar{width:6px;}' +
      '#lit-emoji-grid::-webkit-scrollbar-track{background:#0f0f17;}' +
      '#lit-emoji-grid::-webkit-scrollbar-thumb{background:#2a2a3a;border-radius:3px;}' +
      '.lit-emoji-item{font-size:20px;width:34px;height:34px;display:flex;align-items:center;' +
      'justify-content:center;cursor:pointer;border-radius:4px;transition:background 0.1s;line-height:1;}' +
      '.lit-emoji-item:hover{background:#2a2a3a;}' +
      '.lit-emoji-none{color:#555;font-size:12px;padding:16px;width:100%;text-align:center;}' +
      '#lit-emoji-trigger{cursor:pointer;width:auto!important;font-size:13px;line-height:16px;opacity:0.7;transition:opacity 0.15s;}' +
      '#lit-emoji-trigger:hover{opacity:1;}' +
      '#lit-emoji-grid.text-mode{flex-direction:column;flex-wrap:nowrap;gap:1px;}' +
      '.lit-emoji-text-item{width:100%;padding:4px 8px;cursor:pointer;border-radius:4px;' +
      'display:flex;align-items:center;gap:8px;box-sizing:border-box;min-height:28px;}' +
      '.lit-emoji-text-item:hover{background:#2a2a3a;}' +
      '.lit-emoji-text-name{font-size:10px;color:#666;min-width:86px;flex-shrink:0;white-space:nowrap;' +
      'text-transform:uppercase;letter-spacing:0.4px;}' +
      '.lit-emoji-text-val{font-size:12px;color:#c8c8d8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}';
    document.head.appendChild(s);

    var picker = document.createElement('div');
    picker.id = 'lit-emoji-picker';
    var searchWrap = document.createElement('div');
    searchWrap.id = 'lit-emoji-search-wrap';
    var searchInput = document.createElement('input');
    searchInput.id = 'lit-emoji-search';
    searchInput.type = 'text';
    searchInput.placeholder = 'Search emoji…';
    searchInput.autocomplete = 'off';
    searchWrap.appendChild(searchInput);
    var tabs = document.createElement('div');
    tabs.id = 'lit-emoji-tabs';
    var grid = document.createElement('div');
    grid.id = 'lit-emoji-grid';
    picker.appendChild(searchWrap);
    picker.appendChild(tabs);
    picker.appendChild(grid);
    document.body.appendChild(picker);

    // Flat list for search: [{e, n, type}]
    var ALL = [];
    CATS.forEach(function(cat) {
      cat.emoji.forEach(function(pair) {
        ALL.push({ e: pair[0], n: pair[1], type: cat.type || 'emoji' });
      });
    });

    function renderEmoji(pairs, catType) {
      grid.innerHTML = '';
      grid.classList.toggle('text-mode', catType === 'text');
      if (!pairs.length) {
        var none = document.createElement('div');
        none.className = 'lit-emoji-none';
        none.textContent = 'No results';
        grid.appendChild(none);
        return;
      }
      pairs.forEach(function(pair) {
        var e = Array.isArray(pair) ? pair[0] : pair.e;
        var n = Array.isArray(pair) ? pair[1] : pair.n;
        var itype = pair.type || catType || 'emoji';
        if (itype === 'text') {
          var row = document.createElement('div');
          row.className = 'lit-emoji-text-item';
          row.title = e;
          var nameEl = document.createElement('span');
          nameEl.className = 'lit-emoji-text-name';
          nameEl.textContent = n;
          var valEl = document.createElement('span');
          valEl.className = 'lit-emoji-text-val';
          valEl.textContent = e;
          row.appendChild(nameEl);
          row.appendChild(valEl);
          row.addEventListener('click', function(ev) { ev.stopPropagation(); insertEmoji(e); });
          grid.appendChild(row);
        } else {
          var span = document.createElement('span');
          span.className = 'lit-emoji-item';
          span.textContent = e;
          span.title = n || e;
          span.addEventListener('click', function(ev) { ev.stopPropagation(); insertEmoji(e); });
          grid.appendChild(span);
        }
      });
      grid.scrollTop = 0;
    }

    function showCategory(idx) {
      tabs.querySelectorAll('.lit-emoji-tab').forEach(function(t, i) {
        t.classList.toggle('active', i === idx);
      });
      renderEmoji(CATS[idx].emoji, CATS[idx].type);
    }

    searchInput.addEventListener('input', function(e) {
      e.stopPropagation();
      var q = searchInput.value.trim().toLowerCase();
      if (!q) { showCategory(currentCat); return; }
      tabs.querySelectorAll('.lit-emoji-tab').forEach(function(t) { t.classList.remove('active'); });
      var results = ALL.filter(function(item) {
        return item.e === q || item.n.indexOf(q) !== -1;
      });
      renderEmoji(results);
    });

    searchInput.addEventListener('click', function(e) { e.stopPropagation(); });
    searchInput.addEventListener('keydown', function(e) { e.stopPropagation(); });

    var currentCat = 0;
    CATS.forEach(function(cat, i) {
      var tab = document.createElement('div');
      tab.className = 'lit-emoji-tab';
      tab.textContent = cat.icon;
      tab.title = cat.title;
      tab.addEventListener('click', function(e) {
        e.stopPropagation();
        searchInput.value = '';
        currentCat = i;
        showCategory(i);
      });
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
      trackEmoji(emoji);
      updateFavBar();
    }

    function trackEmoji(emoji) {
      try {
        var freq = JSON.parse(localStorage.getItem('lit_emoji_freq') || '{}');
        freq[emoji] = (freq[emoji] || 0) + 1;
        localStorage.setItem('lit_emoji_freq', JSON.stringify(freq));
      } catch(e) {}
    }

    function topEmoji(n) {
      try {
        var freq = JSON.parse(localStorage.getItem('lit_emoji_freq') || '{}');
        return Object.entries(freq)
          .sort(function(a, b) { return b[1] - a[1]; })
          .slice(0, n)
          .map(function(entry) { return entry[0]; });
      } catch(e) { return []; }
    }

    function updateFavBar(bar) {
      bar = bar || document.getElementById('lit-emoji-favs');
      if (!bar) return;
      var top = topEmoji(10);
      bar.innerHTML = '';
      if (!top.length) return;
      top.forEach(function(e) {
        var sp = document.createElement('span');
        sp.textContent = e;
        var entry = ALL.find(function(item) { return item.e === e; });
        sp.title = entry ? entry.n : e;
        sp.style.cssText = 'font-size:16px;cursor:pointer;line-height:24px;opacity:0.7;padding:0 2px;transition:opacity 0.1s;';
        sp.addEventListener('mouseover', function() { sp.style.opacity = '1'; });
        sp.addEventListener('mouseout',  function() { sp.style.opacity = '0.7'; });
        sp.addEventListener('click', function(ev) { ev.stopPropagation(); insertEmoji(e); });
        bar.appendChild(sp);
      });
    }

    function setupFavBar() {
      if (document.getElementById('lit-emoji-favs')) return;
      var toolbar = document.getElementById('chat-toolbar');
      if (!toolbar) return;
      var isOn = localStorage.getItem('lit_emoji_favs_on') !== '0';
      var bar = document.createElement('div');
      bar.id = 'lit-emoji-favs';
      // Use position:fixed so we can anchor to the left edge of the viewport
      // at the same vertical position as the toolbar, without touching its layout.
      bar.style.cssText = 'position:fixed;display:' + (isOn ? 'flex' : 'none') +
                          ';align-items:center;gap:2px;padding:0 6px;z-index:10000;pointer-events:auto;';
      document.body.appendChild(bar);

      function positionBar() {
        var rect = toolbar.getBoundingClientRect();
        if (!rect.height) return;
        bar.style.top    = rect.top + 'px';
        bar.style.height = rect.height + 'px';
        bar.style.left   = '6px';
        // Clamp width so bar never reaches the toolbar itself
        bar.style.maxWidth = Math.max(0, rect.left - 12) + 'px';
      }
      positionBar();
      window.addEventListener('resize', positionBar);
      new ResizeObserver(positionBar).observe(toolbar);

      if (isOn) updateFavBar(bar);
    }

    function togglePicker(triggerEl) {
      if (picker.style.display === 'flex') {
        picker.style.display = 'none';
        searchInput.value = '';
        showCategory(currentCat);
        return;
      }
      var rect = triggerEl.getBoundingClientRect();
      var pw = 308, ph = 336;
      var top  = rect.top - ph - 6;
      if (top < 8) top = rect.bottom + 6;
      var left = rect.left + rect.width / 2 - pw / 2;
      if (left < 8) left = 8;
      if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
      picker.style.top  = top  + 'px';
      picker.style.left = left + 'px';
      picker.style.display = 'flex';
      setTimeout(function() { searchInput.focus(); }, 50);
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
        searchInput.value = '';
        showCategory(currentCat);
      }
    }, true);

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && picker.style.display === 'flex') {
        picker.style.display = 'none';
        searchInput.value = '';
        showCategory(currentCat);
        e.stopPropagation();
      }
    }, true);

    window._litInsertEmoji = insertEmoji;
    window._litUpdateFavBar = updateFavBar;

    setupTrigger();
    setupFavBar();
    new MutationObserver(function() {
      if (!document.getElementById('lit-emoji-trigger')) setupTrigger();
      if (!document.getElementById('lit-emoji-favs')) setupFavBar();
    }).observe(document.body, { childList: true, subtree: true });
  })();`).catch(() => {});
}

function injectNavButtons() {
  const LIGHT_THEME_IDS = new Set(['light', 'solarized-light', 'warm-rose', 'blue-steel', 'sage', 'lavender']);
  const isDark = !LIGHT_THEME_IDS.has(settings.theme || 'dark');
  const awayOn = settings.prefs?.away ?? false;
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
        var s = document.createElement('span');
        s.textContent = label;
        s.setAttribute('role', 'button');
        s.style.cssText = 'color:' + baseColor + ';cursor:pointer;font-size:13px;padding:4px 10px;' +
                          'border:1px solid ' + baseBorder + ';border-radius:4px;display:inline-block;' +
                          'user-select:none;white-space:nowrap;';
        s.addEventListener('mouseover', function() { s.style.color=hoverColor; s.style.borderColor=hoverBorder; });
        s.addEventListener('mouseout',  function() { s.style.color=baseColor;  s.style.borderColor=baseBorder; });
        return s;
      }
      // Use capture=true so we intercept before any ancestor capture-phase handler the site may have
      function armBtn(el, action) {
        ['mousedown', 'mouseup', 'click'].forEach(function(t) {
          el.addEventListener(t, function(e) {
            e.stopPropagation();
            e.stopImmediatePropagation();
            e.preventDefault();
            if (t === 'click') action();
          }, true);
        });
      }

      var roomsBtn   = mkBtn('Rooms');
      var logsBtn    = mkBtn('Logs');
      var profileBtn = mkBtn('My Profile');

      // Away button — built manually so hover respects the active state
      var awayActive = ${JSON.stringify(awayOn)};
      var awayBtn = document.createElement('span');
      awayBtn.textContent = 'Away';
      awayBtn.setAttribute('role', 'button');
      awayBtn.style.cssText = 'cursor:pointer;font-size:13px;padding:4px 10px;' +
        'border:1px solid;border-radius:4px;display:inline-block;user-select:none;white-space:nowrap;';
      var BASE_BTN_CSS = 'cursor:pointer;font-size:13px;padding:4px 10px;border:1px solid;' +
        'border-radius:4px;display:inline-block;user-select:none;white-space:nowrap;transition:none;';
      function applyAwayStyle(on) {
        awayActive = on;
        awayBtn.style.cssText = BASE_BTN_CSS + (on
          ? (isDark
              ? 'color:#fce7f3;border-color:#db2777;background:rgba(219,39,119,0.45);font-weight:bold;'
              : 'color:#9d174d;border-color:#db2777;background:#fce7f3;font-weight:bold;')
          : 'color:' + baseColor + ';border-color:' + baseBorder + ';background:none;');
      }
      awayBtn.addEventListener('mouseover', function() {
        awayBtn.style.color = hoverColor; awayBtn.style.borderColor = hoverBorder;
      });
      awayBtn.addEventListener('mouseout',  function() { applyAwayStyle(awayActive); });
      applyAwayStyle(awayActive);

      window._litSetAway = function(on) { applyAwayStyle(on); };

      armBtn(roomsBtn,   function() { window.litChat && window.litChat.openRooms(); });
      armBtn(logsBtn,    function() { window.litChat && window.litChat.openLogs(); });
      armBtn(profileBtn, function() { window.litChat && window.litChat.openLitProfile(); });
      armBtn(awayBtn,    function() {
        window.litChat && window.litChat.toggleAway()
          .then(function(on) { applyAwayStyle(on); })
          .catch(function(e) { console.error('[away-btn] toggleAway failed:', e); });
      });

      wrap.appendChild(roomsBtn);
      wrap.appendChild(logsBtn);
      wrap.appendChild(profileBtn);
      wrap.appendChild(awayBtn);
      fw.appendChild(wrap);
    })();
  `).catch(() => {});
}


function joinRoom(jid) {
  return win.webContents.executeJavaScript(
    `new Promise(function(resolve) {
       var jid = ${JSON.stringify(jid)};

       // 1. Already in the roombar — nothing to do.
       // By the time we get here, Candy.Core.getUser() has confirmed auth, so a tab
       // in the roombar means the room is genuinely joined (not just a stale restored element).
       if (document.querySelector('li[data-roomjid=' + JSON.stringify(jid) + '] a.label')) {
         resolve(); return;
       }

       function dismiss() {
         var m = document.getElementById('chat-modal');
         var o = document.getElementById('chat-modal-overlay');
         if (m) m.style.display = 'none';
         if (o) o.style.display = 'none';
       }

       function waitForTab(timeoutMs) {
         var deadline = Date.now() + (timeoutMs || 8000);
         var poll = setInterval(function() {
           if (document.querySelector('li[data-roomjid=' + JSON.stringify(jid) + '] a.label')) {
             clearInterval(poll); dismiss(); resolve();
           } else if (Date.now() > deadline) {
             clearInterval(poll); dismiss();
             console.warn('[join] gave up waiting for tab, falling back to UI click:', jid);
             tryViaUI();
           }
         }, 100);
       }

       // 2. Try Candy's programmatic join — bypasses pagination entirely.
       // NOTE: disabled — if the server rejects this stanza, Candy marks the room
       // as failed internally and the subsequent UI-click fallback also silently fails.
       // Going straight to path 3 keeps Candy's state clean for the first attempt.
       // Re-enable if path 3 proves too slow for rooms that do work via direct join.
       //
       // try {
       //   var act = typeof Candy !== 'undefined' && Candy.Core &&
       //             Candy.Core.Action && Candy.Core.Action.Jabber &&
       //             Candy.Core.Action.Jabber.Room;
       //   if (act && typeof act.Join === 'function') {
       //     act.Join(jid);
       //     waitForTab(8000);
       //     return;
       //   }
       // } catch(e) {}

       // 3. Room panel UI — open it if not already open, search across pages
       function tryViaUI() {
         var tryClickInList = function() {
           var links = document.querySelectorAll('ul.simplePaginationChatRoomList li a');
           for (var i = 0; i < links.length; i++) {
             var href = (links[i].getAttribute('href') || '').replace(/^#/, '');
             if (href === jid) {
               links[i].click();
               return true;
             }
           }
           return false;
         };

         // Click the pagination "next page" control
         var seenPages = new Set();
         function advancePage() {
           var items = document.querySelectorAll('#roomPanel li, #chat-rooms li, .simplePagination li');
           var foundCurrent = false;
           for (var i = 0; i < items.length; i++) {
             var cls = items[i].className || '';
             if (/current/i.test(cls)) { foundCurrent = true; continue; }
             if (foundCurrent && !(/disabled|prev/i.test(cls))) {
               var a = items[i].querySelector('a');
               if (a) {
                 var key = a.textContent.trim();
                 if (seenPages.has(key)) return false;
                 seenPages.add(key);
                 a.click();
                 return true;
               }
             }
           }
           return false;
         }
         // Only open the panel if the room list isn't already visible —
         // clicking the tab when it's already open would toggle it closed
         if (!document.querySelector('ul.simplePaginationChatRoomList li a')) {
           document.querySelector('#roomPanel-tab a.label')?.click();
         }

         var tries = 0;
         var clickedLink = false;
         var clickAttempts = 0;
         var poll = setInterval(function() {
           // After clicking the link, wait for the tab — retry the click every 3 s if needed
           if (clickedLink) {
             if (document.querySelector('li[data-roomjid=' + JSON.stringify(jid) + '] a.label')) {
               clearInterval(poll); dismiss(); resolve(); return;
             }
             if (++tries > 80) {
               console.warn('[join] tab never appeared after click for:', jid);
               clearInterval(poll); dismiss(); resolve(); return;
             }
             // Retry the click every 30 ticks (3 s) in case the first click was lost
             if (tries % 30 === 0 && clickAttempts < 3) {
               ++clickAttempts;
               tryClickInList();
             }
             return;
           }
           if (tryClickInList()) {
             clickedLink = true; clickAttempts = 1; tries = 0; return;
           }
           tries++;
           if (tries % 20 === 0) advancePage();
           if (tries > 100) {
             clearInterval(poll);
             console.warn('[join] gave up on:', jid,
               '— visible rooms:', Array.from(
                 document.querySelectorAll('ul.simplePaginationChatRoomList li a')
               ).map(function(a){ return (a.getAttribute('href')||'').replace(/^#/,''); }));
             dismiss(); resolve();
           }
         }, 100);
       }

       tryViaUI();
     })`
  ).catch(() => {});
}

function openLinkWindow(url) {
  let title;
  try { title = new URL(url).hostname; } catch { title = 'Link'; }
  const w = new BrowserWindow({
    width: 900,
    height: 700,
    parent: win,
    title,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: PARTITION, // same session = already logged in
    },
  });
  w.setMenu(null);
  w.loadURL(url);
  // Links inside the child window also open in new child windows
  w.webContents.setWindowOpenHandler(({ url: u }) => {
    openLinkWindow(u);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (_e, navUrl) => {
    // Allow navigation within the child window (browsing around the site)
    // Update the title as the user navigates
    w.webContents.once('did-finish-load', () => {
      try { w.setTitle(new URL(w.webContents.getURL()).hostname); } catch { /* ignore */ }
    });
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
  roomWin.webContents.once('did-finish-load', () => injectDialogTheme(roomWin.webContents));
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
ipcMain.on('ui:openLitProfile', () => openLinkWindow('https://www.literotica.com/my/#/user/profile'));

ipcMain.handle('prefs:toggleAway', () => {
  if (!settings.prefs) settings.prefs = {};
  settings.prefs.away = !settings.prefs.away;
  if (!settings.prefs.away) { awayRepliedTo.clear(); awayConversations.clear(); }
  saveSettings();
  createAppMenu();
  updateTray();
  return settings.prefs.away; // returned to renderer so button can update its style
});

ipcMain.handle('status:getHidden', (_e, jid) => !!(settings.hideStatusRooms?.[jid]));
ipcMain.handle('status:setHidden', (_e, jid, hidden) => {
  if (!settings.hideStatusRooms) settings.hideStatusRooms = {};
  if (hidden) settings.hideStatusRooms[jid] = true;
  else delete settings.hideStatusRooms[jid];
  saveSettings();
});

ipcMain.handle('logs:dmHistory', async (_e, username) => {
  const logDir = path.join(PROFILE_DIR, 'logs');
  if (!fs.existsSync(logDir)) return [];
  const target = username.toLowerCase();
  const nickOf = jid => {
    const slash = jid.indexOf('/');
    if (slash !== -1) return jid.slice(slash + 1).toLowerCase();
    const at = jid.indexOf('@');
    return (at !== -1 ? jid.slice(0, at) : jid).toLowerCase();
  };
  const msgs = [];
  for (const file of fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort()) {
    const lines = fs.readFileSync(path.join(logDir, file), 'utf8').split('\n');
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (m.type !== 'chat') continue;
        const peer = nickOf(m.direction === 'sent' ? (m.to || '') : (m.from || ''));
        if (peer === target) msgs.push(m);
      } catch { /* skip malformed lines */ }
    }
  }
  const now = Date.now() / 1000;
  const photoRe = /\u{1F4F7} View photo: https:\/\/picpub\.art\/v\/([a-f0-9]+)(?:\?[^#]*)?#([\w.]+)/u;
  const last30 = msgs.slice(-30);
  const toCheck = new Set();
  for (const m of last30) {
    const match = photoRe.exec(m.body || '');
    if (!match) continue;
    const token = match[1];
    const album = settings.picpubAlbums?.[token];
    if (album) {
      if (album.expiresAt < now) m._photoExpired = true;
    } else if (picpubExpiredTokens.has(token)) {
      m._photoExpired = true;
    } else {
      toCheck.add(token);
    }
  }
  // HEAD-check tokens we don't own (partner's uploads) in parallel
  if (toCheck.size) {
    await Promise.all([...toCheck].map(async token => {
      try {
        const res = await fetch(`https://picpub.art/v/${token}`, { method: 'HEAD' });
        if (res.status === 404 || res.status === 410) picpubExpiredTokens.add(token);
      } catch { /* network error — assume still live */ }
    }));
    // Second pass: annotate now that we have results
    for (const m of last30) {
      if (m._photoExpired) continue;
      const match = photoRe.exec(m.body || '');
      if (match && picpubExpiredTokens.has(match[1])) m._photoExpired = true;
    }
  }
  // Attach thumbnail source for expired photo messages
  for (const m of last30) {
    if (!m._photoExpired) continue;
    const match = photoRe.exec(m.body || '');
    if (!match) continue;
    const hash = match[2];
    const meta = photoMeta[hash];
    const isVideo = /\.(mp4|webm|mov|mkv|avi)$/i.test(hash);
    if (!isVideo && meta?.nativeUrl) {
      m._thumbSrc = `https://picpub.art/96x96/${hash}`;
    } else if (!isVideo) {
      const thumbFile = path.join(THUMBS_DIR, hash + '.jpg');
      if (fs.existsSync(thumbFile))
        m._thumbSrc = 'data:image/jpeg;base64,' + fs.readFileSync(thumbFile).toString('base64');
    }
  }
  return last30;
});

ipcMain.handle('rooms:getFavourites', () => settings.favourites ?? {});

ipcMain.handle('rooms:setFavourite', (_e, jid, name, val) => {
  if (!settings.favourites) settings.favourites = {};
  if (val) settings.favourites[jid] = {
    name,
    autoJoin:      settings.favourites[jid]?.autoJoin      ?? false,
    notifyJoin:    settings.favourites[jid]?.notifyJoin    ?? false,
    notifyMessage: settings.favourites[jid]?.notifyMessage ?? false,
  };
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

ipcMain.handle('rooms:setNotifyJoin', (_e, jid, val) => {
  if (!settings.favourites?.[jid]) return;
  settings.favourites[jid].notifyJoin = val;
  saveSettings();
});

ipcMain.handle('rooms:setNotifyMessage', (_e, jid, val) => {
  if (!settings.favourites?.[jid]) return;
  settings.favourites[jid].notifyMessage = val;
  saveSettings();
});

async function setTheme(theme) {
  settings.theme = theme;
  saveSettings();
  for (const k of cssKeys) await win.webContents.removeInsertedCSS(k).catch(() => {});
  cssKeys = [];
  // Themes that supply their own CSS (everything except the bare 'light' which needs none)
  const CUSTOM_LIGHT = new Set(['solarized-light', 'warm-rose', 'blue-steel', 'sage', 'lavender']);
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
  // White logo override only for dark themes; light themes handle logo colour in their own CSS
  if (theme !== 'light' && !CUSTOM_LIGHT.has(theme)) {
    cssKeys.push(await win.webContents.insertCSS(
      '#headerLogo path{fill:white!important}' +
      '#headerLogo .logo__l,#headerLogo .logo__r{fill:#4a89f3!important}'
    ));
  }
  const fsPx = settings.prefs?.fontSize;
  if (fsPx && fsPx !== 15)
    cssKeys.push(await win.webContents.insertCSS(fontSizeCSS(fsPx)));

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

function playNotificationSound() {
  if (settings.prefs?.notificationSound === false) return;
  win.webContents.executeJavaScript(`
    (function() {
      try {
        var ctx = new AudioContext();
        [523.25, 659.25].forEach(function(freq, i) {
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.connect(gain); gain.connect(ctx.destination);
          osc.type = 'sine';
          osc.frequency.value = freq;
          var t = ctx.currentTime + i * 0.13;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(0.12, t + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
          osc.start(t); osc.stop(t + 0.35);
        });
      } catch(e) {}
    })()
  `).catch(() => {});
}

function sendNotification({ title, body }) {
  if (settings.prefs?.notifications === false) return;
  playNotificationSound();
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

function buildPhotoAlbumsSubmenu() {
  const now = Date.now() / 1000;
  const entries = Object.entries(settings.dmAlbumsByPartner || {})
    .map(([partner, token]) => {
      const album = settings.picpubAlbums?.[token];
      return (album && album.expiresAt > now) ? { partner, token, album } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.partner.localeCompare(b.partner));

  if (!entries.length) return [{ label: 'No active albums', enabled: false }];

  return entries.map(({ partner, token, album }) => {
    const secs = album.expiresAt - now;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const expiry = h > 0 ? `${h}h ${m}m` : `${m}m`;
    return {
      label: `${partner} — expires in ${expiry}`,
      submenu: [
        { label: 'Delete Album', click: async () => {
          const { response } = await require('electron').dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Delete', 'Cancel'],
            defaultId: 1,
            message: `Delete album for ${partner}?`,
            detail: 'This removes all photos from the album. Shared links will stop working.',
          });
          if (response !== 0) return;
          try {
            await fetch(`https://picpub.art/v/api/albums/${token}`, {
              method: 'DELETE',
              headers: { 'X-Owner-Token': album.ownerToken },
            });
          } catch { /* already gone */ }
          invalidateDMAlbum(partner);
          createAppMenu();
        }},
      ],
    };
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

  const prefsItems = [
    {
      label: 'Show Favourite Emoji Bar',
      type: 'checkbox',
      checked: settings.prefs?.showFavEmoji !== false,
      click: (menuItem) => {
        if (!settings.prefs) settings.prefs = {};
        settings.prefs.showFavEmoji = menuItem.checked;
        saveSettings();
        const on = menuItem.checked;
        win.webContents.executeJavaScript(`
          localStorage.setItem('lit_emoji_favs_on', '${on ? '1' : '0'}');
          var bar = document.getElementById('lit-emoji-favs');
          if (bar) {
            bar.style.display = '${on ? 'flex' : 'none'}';
            if (${on} && window._litUpdateFavBar) window._litUpdateFavBar(bar);
          }
        `).catch(() => {});
      },
    },
    {
      label: 'Notifications',
      type: 'checkbox',
      checked: settings.prefs?.notifications !== false,
      click: (menuItem) => {
        if (!settings.prefs) settings.prefs = {};
        settings.prefs.notifications = menuItem.checked;
        saveSettings();
      },
    },
    {
      label: 'Notification Sound',
      type: 'checkbox',
      checked: settings.prefs?.notificationSound !== false,
      click: (menuItem) => {
        if (!settings.prefs) settings.prefs = {};
        settings.prefs.notificationSound = menuItem.checked;
        saveSettings();
      },
    },
    {
      label: 'Photo Link Duration',
      submenu: [
        { ttl: '1h', label: '1 hour' },
        { ttl: '6h', label: '6 hours' },
        { ttl: '24h', label: '24 hours' },
        { ttl: '7d', label: '7 days' },
      ].map(({ ttl, label }) => ({
        label,
        type: 'checkbox',
        checked: (settings.prefs?.photoTtl ?? '1h') === ttl,
        click: () => {
          if (!settings.prefs) settings.prefs = {};
          settings.prefs.photoTtl = ttl;
          saveSettings();
          createAppMenu();
        },
      })),
    },
    {
      label: 'Text Size',
      submenu: FONT_SIZES.map(({ px, label }) => ({
        label,
        type: 'checkbox',
        checked: (settings.prefs?.fontSize ?? 15) === px,
        click: async () => {
          if (!settings.prefs) settings.prefs = {};
          settings.prefs.fontSize = px;
          saveSettings();
          await setTheme(settings.theme || 'dark');
        },
      })),
    },
    { type: 'separator' },
    {
      label: 'Watermark IP on Shared Photos',
      type: 'checkbox',
      checked: settings.prefs?.watermarkIp ?? false,
      click: (menuItem) => {
        if (!settings.prefs) settings.prefs = {};
        settings.prefs.watermarkIp = menuItem.checked;
        saveSettings();
      },
    },
    { type: 'separator' },
    {
      label: 'Away',
      type: 'checkbox',
      checked: settings.prefs?.away ?? false,
      click: (menuItem) => {
        if (!settings.prefs) settings.prefs = {};
        settings.prefs.away = menuItem.checked;
        saveSettings();
        if (!menuItem.checked) { awayRepliedTo.clear(); awayConversations.clear(); }
      },
    },
    {
      label: 'Set Away Message…',
      click: async () => {
        const current = settings.prefs?.awayMessage || "I'm currently away.";
        const result = await win.webContents.executeJavaScript(`
          new Promise(function(resolve) {
            var overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:999999;display:flex;align-items:center;justify-content:center;';
            var box = document.createElement('div');
            box.style.cssText = 'background:#1a1a2a;border:1px solid #3a3a4a;border-radius:10px;padding:20px 20px 16px;width:380px;font-family:system-ui,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.6);';
            var lbl = document.createElement('div');
            lbl.textContent = 'Away message';
            lbl.style.cssText = 'color:#aaa;font-size:12px;margin-bottom:8px;letter-spacing:0.04em;text-transform:uppercase;';
            var inp = document.createElement('input');
            inp.type = 'text';
            inp.value = ${JSON.stringify(current)};
            inp.style.cssText = 'width:100%;padding:8px 10px;background:#0f0f17;border:1px solid #3a3a4a;border-radius:6px;color:#e0e0e8;font-size:14px;outline:none;box-sizing:border-box;';
            inp.addEventListener('focus', function() { inp.style.borderColor='#7c5cbf'; });
            inp.addEventListener('blur',  function() { inp.style.borderColor='#3a3a4a'; });
            var btns = document.createElement('div');
            btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;';
            var cancel = document.createElement('button');
            cancel.textContent = 'Cancel';
            cancel.style.cssText = 'padding:6px 16px;background:transparent;border:1px solid #3a3a4a;border-radius:6px;color:#aaa;cursor:pointer;font-size:13px;';
            var save = document.createElement('button');
            save.textContent = 'Save';
            save.style.cssText = 'padding:6px 18px;background:#7c5cbf;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:13px;';
            function done(v) { document.body.removeChild(overlay); resolve(v); }
            cancel.onclick = function() { done(null); };
            save.onclick   = function() { done(inp.value); };
            inp.addEventListener('keydown', function(e) {
              if (e.key === 'Enter')  { e.preventDefault(); done(inp.value); }
              if (e.key === 'Escape') { e.preventDefault(); done(null); }
            });
            btns.appendChild(cancel); btns.appendChild(save);
            box.appendChild(lbl); box.appendChild(inp); box.appendChild(btns);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            setTimeout(function() { inp.focus(); inp.select(); }, 30);
          })
        `).catch(() => null);
        if (result !== null && result !== undefined) {
          if (!settings.prefs) settings.prefs = {};
          settings.prefs.awayMessage = result;
          saveSettings();
        }
      },
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Lit Chat',
      submenu: [
        { label: 'View Logs',       click: () => openLogViewer() },
        { label: 'Edit Lit Profile', click: () => openLinkWindow('https://www.literotica.com/my/#/user/profile') },
        { label: 'Rooms', submenu: roomItems },
        { label: 'Photo Albums', submenu: buildPhotoAlbumsSubmenu() },
        { type: 'separator' },
        { label: 'Theme',   submenu: themeItems },
        { label: 'Profile', submenu: profileItems },
        { label: 'Preferences', submenu: prefsItems },
        { type: 'separator' },
        (() => {
          if (!app.isPackaged) return { label: 'Check for Updates (dev build)', enabled: false };
          if (updateState === 'ready')       return { label: `Install Update (${updateVersion})…`, click: () => _autoUpdater.quitAndInstall() };
          if (updateState === 'downloading') return { label: `Downloading ${updateVersion}…`, enabled: false };
          if (updateState === 'checking')    return { label: 'Checking for Updates…', enabled: false };
          return { label: 'Check for Updates', click: () => _autoUpdater?.checkForUpdates().catch(() => {}) };
        })(),
        { label: 'About Lit Chat', click: () => {
          const { dialog } = require('electron');
          dialog.showMessageBox(win, {
            type: 'info',
            title: 'Lit Chat',
            message: `Lit Chat v${app.getVersion()}`,
            detail: 'An Electron wrapper for chat.literotica.com\nBy ai_joe',
          });
        }},
        { type: 'separator' },
        { label: 'Reload',    accelerator: 'CmdOrCtrl+R',      click: () => win.webContents.reload(), visible: false },
        { label: 'ZoomIn',    accelerator: 'CmdOrCtrl+shift+=', click: () => adjustZoom(+0.5), visible: false },
        { label: 'ZoomIn2',   accelerator: 'CmdOrCtrl+=',       click: () => adjustZoom(+0.5), visible: false },
        { label: 'ZoomOut',   accelerator: 'CmdOrCtrl+shift+-', click: () => adjustZoom(-0.5), visible: false },
        { label: 'ZoomOut2',  accelerator: 'CmdOrCtrl+-',       click: () => adjustZoom(-0.5), visible: false },
        { label: 'ZoomReset', accelerator: 'CmdOrCtrl+shift+0', click: () => adjustZoom(0),    visible: false },
        { label: 'ZoomReset2',accelerator: 'CmdOrCtrl+0',       click: () => adjustZoom(0),    visible: false },
        { label: 'DevTools', click: () => win.webContents.openDevTools() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
  ]));
}

function updateTray() {
  if (!tray) return;
  const away = settings.prefs?.away ?? false;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Away', type: 'checkbox', checked: away,
      click: () => {
        if (!settings.prefs) settings.prefs = {};
        settings.prefs.away = !settings.prefs.away;
        if (!settings.prefs.away) { awayRepliedTo.clear(); awayConversations.clear(); }
        saveSettings();
        createAppMenu();
        updateTray();
        // Sync the nav button in the renderer
        if (win && !win.isDestroyed())
          win.webContents.executeJavaScript(
            `if (window._litSetAway) window._litSetAway(${settings.prefs.away});`
          ).catch(() => {});
      },
    },
    { type: 'separator' },
    { label: 'Show', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function setupTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Lit Chat');
  updateTray();
  tray.on('click', () => {
    if (win.isVisible()) { win.focus(); } else { win.show(); win.focus(); }
  });
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;

  const { autoUpdater } = require('electron-updater');
  _autoUpdater = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    updateState = 'checking';
    createAppMenu();
  });

  autoUpdater.on('update-available', info => {
    updateState = 'downloading';
    updateVersion = info.version;
    createAppMenu();
    new Notification({
      title: 'Update downloading',
      body: `Lit Chat ${info.version} is downloading in the background.`,
    }).show();
  });

  autoUpdater.on('update-not-available', () => {
    updateState = 'idle';
    createAppMenu();
  });

  autoUpdater.on('update-downloaded', info => {
    updateState = 'ready';
    updateVersion = info.version;
    createAppMenu();
    const { dialog } = require('electron');
    dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart & Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: `Lit Chat ${info.version} is ready to install.`,
      detail: 'Restart now to apply the update, or install it the next time you quit.',
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', err => {
    console.error('[updater]', err.message);
    updateState = 'idle';
    createAppMenu();
  });

  // Check on startup, then every 4 hours
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ── PicPub photo sharing ─────────────────────────────────────────────────────

function invalidateDMAlbum(partnerUsername) {
  const token = settings.dmAlbumsByPartner?.[partnerUsername];
  if (token) delete settings.picpubAlbums[token];
  if (settings.dmAlbumsByPartner) delete settings.dmAlbumsByPartner[partnerUsername];
  saveSettings();
}

async function getOrCreateDMAlbum(partnerUsername) {
  const token = settings.dmAlbumsByPartner?.[partnerUsername];
  const existing = token && settings.picpubAlbums?.[token];
  if (existing && existing.expiresAt > Date.now() / 1000 + 120) {
    return { token, ownerToken: existing.ownerToken, viewUrl: `https://picpub.art/v/${token}` };
  }
  const res = await fetch('https://picpub.art/v/api/albums', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      literotica_user: myLitUsername || 'user',
      ttl: settings.prefs?.photoTtl ?? '1h',
      options: {
        show_chat: false,
        ...(settings.prefs?.watermarkIp ? { watermark_ip: true } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`PicPub create failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!settings.picpubAlbums) settings.picpubAlbums = {};
  if (!settings.dmAlbumsByPartner) settings.dmAlbumsByPartner = {};
  settings.picpubAlbums[data.token] = { ownerToken: data.owner_token, expiresAt: data.expires_at, literoticaUser: myLitUsername || 'user' };
  settings.dmAlbumsByPartner[partnerUsername] = data.token;
  saveSettings();
  createAppMenu();
  return { token: data.token, ownerToken: data.owner_token, viewUrl: data.view_url };
}

async function uploadToAlbum(album, filePath, mimeType) {
  const buf = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const ct = mimeType || 'application/octet-stream';
  const boundary = '----LitPicBoundary' + Date.now().toString(16);
  const CRLF = '\r\n';
  const bodyBuf = Buffer.concat([
    Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="files[]"; filename="${filename}"${CRLF}` +
      `Content-Type: ${ct}${CRLF}${CRLF}`
    ),
    buf,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
  ]);
  return fetch(`https://picpub.art/v/api/albums/${album.token}/upload`, {
    method: 'POST',
    headers: {
      'X-Owner-Token': album.ownerToken,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: bodyBuf,
  });
}

ipcMain.handle('picpub:upload', async (_e, partnerUsername, filePath, mimeType) => {
  try {
    let album = await getOrCreateDMAlbum(partnerUsername);
    let res = await uploadToAlbum(album, filePath, mimeType);
    // Album was deleted server-side while our cache still considered it valid — retry once
    if (res.status === 404 || res.status === 410) {
      invalidateDMAlbum(partnerUsername);
      album = await getOrCreateDMAlbum(partnerUsername);
      res = await uploadToAlbum(album, filePath, mimeType);
    }
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const added = data.added?.[0];
    if (!added) throw new Error('No file returned from upload');
    const partnerViewUrl = await makeViewerLink(album.token, album.ownerToken, partnerUsername);
    return { ok: true, token: album.token, hash: added.hash, viewUrl: album.viewUrl, partnerViewUrl };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

async function linkToAlbum(album, picpubUrl) {
  return fetch(`https://picpub.art/v/api/albums/${album.token}/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Owner-Token': album.ownerToken },
    body: JSON.stringify({ url: picpubUrl }),
  });
}

ipcMain.handle('picpub:link', async (_e, partnerUsername, picpubUrl) => {
  try {
    if (!/^https?:\/\/picpub\.art\//.test(picpubUrl))
      throw new Error('Not a picpub.art URL');
    let album = await getOrCreateDMAlbum(partnerUsername);
    let res = await linkToAlbum(album, picpubUrl);
    if (res.status === 404 || res.status === 410) {
      invalidateDMAlbum(partnerUsername);
      album = await getOrCreateDMAlbum(partnerUsername);
      res = await linkToAlbum(album, picpubUrl);
    }
    if (!res.ok) throw new Error(`Link failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    if (data.native_url && data.hash) {
      photoMeta[data.hash] = { nativeUrl: data.native_url };
      savePhotoMeta();
    }
    const partnerViewUrl = await makeViewerLink(album.token, album.ownerToken, partnerUsername);
    return { ok: true, token: album.token, hash: data.hash, native_url: data.native_url || null, viewUrl: album.viewUrl, partnerViewUrl };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

async function makeViewerLink(token, ownerToken, username) {
  if (!ownerToken || !username) return null;
  try {
    const res = await fetch(`https://picpub.art/v/api/albums/${token}/viewer-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Token': ownerToken },
      body: JSON.stringify({ username }),
    });
    if (!res.ok) {
      console.warn('[picpub:viewerLink] API error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return data.url || null;
  } catch (e) {
    console.warn('[picpub:viewerLink] fetch error:', e.message);
    return null;
  }
}

ipcMain.handle('picpub:viewerLink', async (_e, token) => {
  const album = settings.picpubAlbums?.[token];
  const username = myLitUsername || album?.literoticaUser;
  if (!album?.ownerToken || !username) return null;
  return makeViewerLink(token, album.ownerToken, username);
});

ipcMain.handle('thumbs:save', (_e, hash, dataUrl) => {
  try {
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
    const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(THUMBS_DIR, hash + '.jpg'), Buffer.from(b64, 'base64'));
  } catch (e) { console.warn('[thumbs:save]', e.message); }
});

ipcMain.handle('picpub:contextMenu', (_e, token, hash) => {
  const album = settings.picpubAlbums?.[token];
  if (!album?.ownerToken) return null;  // not our album — no menu
  const menu = Menu.buildFromTemplate([{
    label: 'Remove image from album',
    click: async () => {
      try {
        const res = await fetch(`https://picpub.art/v/api/albums/${token}/images/${hash}`, {
          method: 'DELETE',
          headers: { 'X-Owner-Token': album.ownerToken },
        });
        if (!res.ok) { console.warn('[picpub] remove image failed:', res.status); return; }
        // Replace the thumbnail in the renderer with a dim placeholder
        win.webContents.executeJavaScript(`
          document.querySelectorAll('img[data-lp-token="${token}"][data-lp-hash="${hash}"]')
            .forEach(function(img) {
              var wrap = img.closest('a') || img;
              var ph = document.createElement('span');
              ph.style.cssText = 'color:#444;font-style:italic;font-size:12px';
              ph.textContent = '\\u{1F4F7} (image removed)';
              wrap.replaceWith(ph);
            });
        `).catch(() => {});
      } catch (e) {
        console.warn('[picpub] remove image error:', e.message);
      }
    },
  }]);
  menu.popup({ window: win });
  return null;
});

// ── Link previews ────────────────────────────────────────────────────────────

const linkPreviewCache = new Map(); // url → { result, ts }

ipcMain.handle('links:preview', async (_e, url) => {
  const cached = linkPreviewCache.get(url);
  if (cached && Date.now() - cached.ts < 3_600_000) return cached.result;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LitChat/1.0)' },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
    if (!res.ok) { linkPreviewCache.set(url, { result: null, ts: Date.now() }); return null; }
    const html = await res.text();
    function getMeta(prop) {
      const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const r1 = new RegExp('<meta[^>]+property=["\']' + esc + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
      const r2 = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']' + esc + '["\']', 'i');
      return (html.match(r1)?.[1] || html.match(r2)?.[1])?.trim() || null;
    }
    function getNameMeta(name) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const r1 = new RegExp('<meta[^>]+name=["\']' + esc + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
      const r2 = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']' + esc + '["\']', 'i');
      return (html.match(r1)?.[1] || html.match(r2)?.[1])?.trim() || null;
    }
    const title       = getMeta('og:title')       || html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.trim() || null;
    const description = getMeta('og:description') || getNameMeta('description') || null;
    const image       = getMeta('og:image')       || null;
    const siteName    = getMeta('og:site_name')   || null;
    if (!title && !description) { linkPreviewCache.set(url, { result: null, ts: Date.now() }); return null; }
    const result = { title, description: description ? description.slice(0, 200) : null, image, siteName };
    linkPreviewCache.set(url, { result, ts: Date.now() });
    return result;
  } catch {
    linkPreviewCache.set(url, { result: null, ts: Date.now() });
    return null;
  }
});

// ── Photo gallery ─────────────────────────────────────────────────────────────

ipcMain.handle('logs:dmPhotos', (_e, username) => {
  const logDir = path.join(PROFILE_DIR, 'logs');
  if (!fs.existsSync(logDir)) return [];
  const target = username.toLowerCase();
  const nickOf = jid => {
    const slash = jid.indexOf('/');
    if (slash !== -1) return jid.slice(slash + 1).toLowerCase();
    const at = jid.indexOf('@');
    return (at !== -1 ? jid.slice(0, at) : jid).toLowerCase();
  };
  const fmtA = /^\u{1F4F7} (https:\/\/picpub\.art\/([a-z0-9]+\.[a-z]+))/u;
  const fmtB = /\u{1F4F7} View photo: https:\/\/picpub\.art\/v\/([a-f0-9]+)(?:\?[^#]*)?#([\w.]+)/u;
  const seen = new Set();
  const photos = [];
  for (const file of fs.readdirSync(logDir).filter(f => f.endsWith('.jsonl')).sort()) {
    const lines = fs.readFileSync(path.join(logDir, file), 'utf8').split('\n');
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (m.type !== 'chat') continue;
        const peer = nickOf(m.direction === 'sent' ? (m.to || '') : (m.from || ''));
        if (peer !== target) continue;
        let hash, token, viewUrl;
        const mA = fmtA.exec(m.body || '');
        const mB = !mA && fmtB.exec(m.body || '');
        if (mA) {
          hash = mA[2]; viewUrl = mA[1]; token = null;
        } else if (mB) {
          token = mB[1]; hash = mB[2];
          const album = settings.picpubAlbums?.[token];
          const expired = album ? album.expiresAt < Date.now() / 1000 : false;
          viewUrl = expired ? null : `https://picpub.art/v/${token}#${hash}`;
        } else continue;
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        const meta = photoMeta[hash];
        const isVideo = /\.(mp4|webm|mov|mkv|avi)$/i.test(hash);
        let thumbSrc = null;
        if (!isVideo && meta?.nativeUrl) {
          thumbSrc = `https://picpub.art/96x96/${hash}`;
        } else if (!isVideo) {
          const tf = path.join(THUMBS_DIR, hash + '.jpg');
          if (fs.existsSync(tf))
            thumbSrc = 'data:image/jpeg;base64,' + fs.readFileSync(tf).toString('base64');
        }
        if (!viewUrl && meta?.nativeUrl) viewUrl = meta.nativeUrl;
        photos.push({ hash, thumbSrc, viewUrl, ts: m.ts, direction: m.direction, isVideo });
      } catch {}
    }
  }
  return photos.reverse();
});

function injectImageSharing() {
  win.webContents.executeJavaScript(`
    (function() {
      if (window._litImageSharingActive) return;
      window._litImageSharingActive = true;

      // ── Inline rendering ────────────────────────────────────────────────────

      var IMG_STYLE = 'max-width:300px;max-height:300px;object-fit:contain;' +
        'border-radius:8px;cursor:pointer;display:block;margin:4px 0 2px';

      function isVideoHash(s) {
        return s && /\\.(?:mp4|webm|mov|mkv|avi)$/i.test(s);
      }

      function captureThumb(img, hash) {
        if (!hash || !window.litChat || !window.litChat.saveThumb) return;
        img.addEventListener('load', function() {
          try {
            var MAX = 96, w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) return;
            var scale = Math.min(MAX / w, MAX / h, 1);
            var c = document.createElement('canvas');
            c.width = Math.round(w * scale); c.height = Math.round(h * scale);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            window.litChat.saveThumb(hash, c.toDataURL('image/jpeg', 0.5));
          } catch(e) {}
        }, { once: true });
      }

      function makeThumb(src, onclick, token, hash) {
        var isVid = isVideoHash(hash) || isVideoHash(src);
        var el;
        if (isVid) {
          el = document.createElement('video');
          el.src = src;
          el.controls = true;
          el.preload = 'metadata';
          el.style.cssText = IMG_STYLE;
        } else {
          el = document.createElement('img');
          el.src = src;
          el.style.cssText = IMG_STYLE;
          el.addEventListener('click', onclick);
          captureThumb(el, hash);
        }
        if (token && hash) {
          el.dataset.lpToken = token;
          el.dataset.lpHash = hash;
          el.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            window.litChat.photoContextMenu(token, hash);
          });
        }
        return el;
      }

      // Open album viewer with a signed viewer-link so the gate is bypassed.
      // signedFallback: the URL already in the message (may contain ?vt=), used when we
      // don't own the album and can't generate a fresh viewer-link ourselves.
      function openAlbum(token, hash, signedFallback) {
        var fallback = signedFallback || ('https://picpub.art/v/' + token + (hash ? '#' + hash : ''));
        if (!window.litChat || !window.litChat.getViewerLink) { window.open(fallback); return; }
        window.litChat.getViewerLink(token).then(function(signed) {
          window.open(signed ? signed + (hash ? '#' + hash : '') : fallback);
        }).catch(function() { window.open(fallback); });
      }
      // Expose for buildHistory onclick attributes (injected in a separate executeJavaScript)
      window._litOpenAlbum = openAlbum;

      // Remove the photo message text so only the thumbnail shows.
      // If there is surrounding text, remove just the photo portion; otherwise hide the element.
      // URL part is optional because Candy's link detection may have moved it into an <a> element.
      var _photoTextRe = /\\s*\\u{1F4F7}(?:\\s+View photo:)?(?:\\s+https?:\\/\\/\\S*)?\\s*/gu;
      function hidePhotoText(li, thumb) {
        // Hide any <a> elements Candy created for the picpub viewer URL
        li.querySelectorAll('a').forEach(function(a) {
          if (thumb && thumb.contains(a)) return;
          if (/picpub\\.art\\/v\\//.test(a.getAttribute('href') || '')) a.style.display = 'none';
        });
        function walk(node) {
          if (node === thumb || (thumb && thumb.contains(node))) return;
          if (node.nodeType === 3 && node.nodeValue.indexOf('\\u{1F4F7}') !== -1) {
            var cleaned = node.nodeValue.replace(_photoTextRe, ' ').trimEnd();
            if (!cleaned.trim()) {
              var p = node.parentElement;
              if (p && p !== li) p.style.display = 'none';
            } else {
              node.nodeValue = cleaned;
            }
          } else if (node.nodeType === 1) {
            for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
          }
        }
        walk(li);
      }

      function hideImgUrl(li, iurl) {
        li.querySelectorAll('a').forEach(function(a) {
          var href = a.getAttribute('href') || '';
          if (href === iurl || a.textContent.trim() === iurl) a.style.display = 'none';
        });
        (function walk(node) {
          if (node.nodeType === 3 && node.nodeValue.indexOf(iurl) !== -1) {
            var cleaned = node.nodeValue.replace(iurl, '').replace(/\\s{2,}/g, ' ').trimEnd();
            if (!cleaned.trim()) {
              var p = node.parentElement;
              if (p && p !== li) p.style.display = 'none';
            } else {
              node.nodeValue = cleaned;
            }
          } else if (node.nodeType === 1) {
            for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
          }
        })(li);
      }

      function renderPhotoMsg(li) {
        if (li._litPhotoRendered) return;
        var text = li.textContent || '';

        // Format A: linked image — native URL, directly embeddable, no auth needed
        // Message body: "📷 https://picpub.art/hash.ext"
        var nativeM = /^\u{1F4F7} (https:\\/\\/picpub\\.art\\/[a-z0-9]+\\.[a-z]+)$/u.exec(text.trim());
        if (nativeM) {
          li._litPhotoRendered = true;
          var nurl = nativeM[1];
          var thumb = makeThumb(nurl, function() { window.open(nurl); });
          li.appendChild(thumb);
          hidePhotoText(li, thumb);
          return;
        }

        // Format B: uploaded image — proxied via litpic://
        // Message body: "📷 View photo: https://picpub.art/v/TOKEN#HASH"
        var m = /\u{1F4F7} View photo: (https:\\/\\/picpub\\.art\\/v\\/([a-f0-9]+)(?:\\?[^#]*)?)#([\\w.]+)/u.exec(text);
        if (m) {
          li._litPhotoRendered = true;
          var signedBase = m[1], token = m[2], hash = m[3];
          var vtM = /[?&]vt=([^&#]+)/.exec(signedBase);
          var litpicSrc = 'litpic://' + token + '/' + hash + (vtM ? '?vt=' + vtM[1] : '');
          var thumb = makeThumb(litpicSrc, function() {
            openAlbum(token, hash, signedBase + '#' + hash);
          }, token, hash);
          li.appendChild(thumb);
          hidePhotoText(li, thumb);
          return;
        }

        // Format C: direct image URL from any host (jpg/jpeg/png/gif/webp)
        var imgM = /(https?:\\/\\/[^\\s<>"']+\\.(?:jpg|jpeg|png|gif|webp)(?:\\?[^\\s<>"']*)?)/i.exec(text);
        if (!imgM) return;
        var iurl = imgM[1];
        li._litPhotoRendered = true;
        var imgThumb = makeThumb(iurl, function() { window.open(iurl); });
        li.appendChild(imgThumb);
        hideImgUrl(li, iurl);
      }

      function observePane(ul) {
        if (ul._litPhotoObs) return;
        ul._litPhotoObs = true;
        ul.querySelectorAll('li').forEach(renderPhotoMsg);
        new MutationObserver(function(muts) {
          muts.forEach(function(mut) {
            mut.addedNodes.forEach(function(n) {
              if (n.nodeType === 1) {
                if (n.tagName === 'LI') { renderPhotoMsg(n); renderLinkPreview(n); }
                else n.querySelectorAll('li').forEach(function(li) { renderPhotoMsg(li); renderLinkPreview(li); });
              }
            });
          });
        }).observe(ul, { childList: true, subtree: true });
      }

      document.querySelectorAll('ul.message-pane, ul[class*="message"]').forEach(observePane);

      // ── Link previews ────────────────────────────────────────────────────────

      var _previewSkipRe = /\\.(?:jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|pdf|zip|tar|gz)(\\?|#|$)/i;
      function renderLinkPreview(li) {
        if (li._litPreviewDone || li._litPhotoRendered) return;
        li._litPreviewDone = true;
        var text = li.textContent || '';
        var m = /(https?:\\/\\/[^\\s<>"']{12,})/.exec(text);
        if (!m) return;
        var url = m[1].replace(/[.,;:!?)]+$/, ''); // strip trailing punctuation
        if (/picpub\\.art/.test(url) || _previewSkipRe.test(url)) return;
        if (!window.litChat || !window.litChat.getLinkPreview) return;
        window.litChat.getLinkPreview(url).then(function(p) {
          if (!p || !li.isConnected) return;
          var card = document.createElement('div');
          card.style.cssText =
            'border-left:3px solid #7c5cbf;border-radius:0 6px 6px 0;background:rgba(0,0,0,0.28);' +
            'padding:7px 10px;margin:5px 0 2px;max-width:420px;cursor:pointer;' +
            'display:flex;gap:10px;align-items:flex-start;box-sizing:border-box';
          card.addEventListener('click', function() { window.open(url); });
          var txt = document.createElement('div');
          txt.style.cssText = 'flex:1;min-width:0;overflow:hidden';
          if (p.siteName) {
            var site = document.createElement('div');
            site.style.cssText = 'font-size:10px;color:#666;margin-bottom:2px;text-transform:uppercase;letter-spacing:.04em';
            site.textContent = p.siteName;
            txt.appendChild(site);
          }
          if (p.title) {
            var title = document.createElement('div');
            title.style.cssText = 'font-size:13px;font-weight:600;color:#ccc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
            title.textContent = p.title;
            txt.appendChild(title);
          }
          if (p.description) {
            var desc = document.createElement('div');
            desc.style.cssText = 'font-size:12px;color:#888;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden';
            desc.textContent = p.description;
            txt.appendChild(desc);
          }
          card.appendChild(txt);
          if (p.image) {
            var thumb = document.createElement('img');
            thumb.src = p.image;
            thumb.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:4px;flex-shrink:0';
            thumb.onerror = function() { thumb.remove(); };
            card.appendChild(thumb);
          }
          li.appendChild(card);
        }).catch(function() {});
      }

      // ── Photo gallery ────────────────────────────────────────────────────────

      function showGallery(partner) {
        var existing = document.querySelector('.lit-gallery');
        if (existing) { existing.remove(); return; }
        // Full-viewport backdrop so the gallery floats above everything
        var backdrop = document.createElement('div');
        backdrop.className = 'lit-gallery';
        backdrop.style.cssText =
          'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;' +
          'background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center';
        backdrop.addEventListener('click', function(e) { if (e.target === backdrop) backdrop.remove(); });
        document.body.appendChild(backdrop);
        // Panel
        var panel = document.createElement('div');
        panel.style.cssText =
          'background:#141420;border-radius:8px;width:640px;max-width:92vw;max-height:80vh;' +
          'display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 40px rgba(0,0,0,0.7)';
        backdrop.appendChild(panel);
        // Header
        var hdr = document.createElement('div');
        hdr.style.cssText =
          'display:flex;align-items:center;justify-content:space-between;flex-shrink:0;' +
          'padding:11px 16px;border-bottom:1px solid rgba(255,255,255,0.08)';
        var htitle = document.createElement('span');
        htitle.style.cssText = 'font-size:13px;font-weight:600;color:#ccc';
        htitle.textContent = 'Photos with ' + partner;
        var closeBtn = document.createElement('button');
        closeBtn.textContent = '\\u00D7';
        closeBtn.style.cssText =
          'background:none;border:none;color:#666;font-size:22px;cursor:pointer;line-height:1;padding:0 4px';
        closeBtn.addEventListener('mouseenter', function() { closeBtn.style.color = '#ccc'; });
        closeBtn.addEventListener('mouseleave', function() { closeBtn.style.color = '#666'; });
        closeBtn.addEventListener('click', function() { backdrop.remove(); });
        hdr.appendChild(htitle); hdr.appendChild(closeBtn);
        panel.appendChild(hdr);
        // Body
        var body = document.createElement('div');
        body.style.cssText = 'flex:1;overflow-y:auto;padding:14px';
        body.innerHTML = '<div style="color:#555;font-size:12px;font-style:italic;text-align:center;padding:40px 0">Loading…</div>';
        panel.appendChild(body);
        // Fetch and render
        window.litChat.dmPhotos(partner).then(function(photos) {
          body.innerHTML = '';
          if (!photos || !photos.length) {
            body.innerHTML = '<div style="color:#555;font-size:12px;text-align:center;padding:40px 0">No photos shared yet</div>';
            return;
          }
          var grid = document.createElement('div');
          grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px';
          photos.forEach(function(photo) {
            var cell = document.createElement('div');
            cell.style.cssText =
              'aspect-ratio:1/1;border-radius:5px;overflow:hidden;background:#1e1e2e;position:relative;' +
              'cursor:' + (photo.viewUrl ? 'pointer' : 'default');
            if (photo.viewUrl) {
              cell.addEventListener('click', function() { window.open(photo.viewUrl); });
              if (photo.ts) {
                var d = new Date(photo.ts);
                cell.title = isNaN(d) ? '' : d.toLocaleDateString();
              }
            }
            if (photo.thumbSrc) {
              var img = document.createElement('img');
              img.src = photo.thumbSrc;
              img.style.cssText = 'width:100%;height:100%;object-fit:cover' + (photo.viewUrl ? '' : ';opacity:0.3');
              cell.appendChild(img);
            } else {
              var ph = document.createElement('div');
              ph.style.cssText =
                'width:100%;height:100%;display:flex;align-items:center;' +
                'justify-content:center;font-size:26px;opacity:' + (photo.isVideo ? '0.5' : '0.15');
              ph.textContent = photo.isVideo ? '\\u{1F4F9}' : '\\u{1F4F7}';
              cell.appendChild(ph);
            }
            if (!photo.viewUrl) {
              var exp = document.createElement('div');
              exp.style.cssText =
                'position:absolute;bottom:0;left:0;right:0;font-size:9px;text-align:center;' +
                'background:rgba(0,0,0,0.65);color:#555;padding:2px 0;letter-spacing:.03em';
              exp.textContent = 'expired';
              cell.appendChild(exp);
            }
            grid.appendChild(cell);
          });
          body.appendChild(grid);
        }).catch(function() {
          body.innerHTML = '<div style="color:#e05050;font-size:12px;text-align:center;padding:40px 0">Failed to load photos</div>';
        });
      }

      // ── Upload logic (shared by button) ─────────────────────────────────────

      async function handlePhotoUpload(jid, file) {
        var pane = document.querySelector('.room-pane[data-roomjid=' + JSON.stringify(jid) + ']');
        var msgPane = pane ? pane.querySelector('ul.message-pane, ul[class*="message"]') : null;
        var indLi;

        if (msgPane) {
          indLi = document.createElement('li');
          indLi.style.cssText = 'list-style:none;padding:2px 8px';
          var ind = document.createElement('span');
          ind.style.cssText = 'color:#7c5cbf;font-size:12px;font-style:italic';
          ind.textContent = 'Uploading image…';
          indLi.appendChild(ind);
          msgPane.appendChild(indLi);
          var indScroller = msgPane.closest('.message-pane-wrapper') || msgPane.parentElement;
          if (indScroller) indScroller.scrollTop = indScroller.scrollHeight;
        }

        try {
          var filePath = file.path;
          if (!filePath) throw new Error('File path not available');
          if (typeof window.litChat === 'undefined')
            throw new Error('preload bridge not loaded — try fully restarting the app');
          if (typeof window.litChat.uploadPhoto !== 'function')
            throw new Error('uploadPhoto missing from bridge (bridge keys: ' + Object.keys(window.litChat).join(', ') + ')');
          var slash = jid.indexOf('/');
          var partner = slash !== -1 ? jid.slice(slash + 1) : jid.split('@')[0];
          var result = await window.litChat.uploadPhoto(partner, filePath, file.type);
          if (indLi) indLi.remove();
          if (!result.ok) throw new Error(result.error || 'upload failed');

          // Show preview immediately using a local blob URL
          if (msgPane) {
            var li = document.createElement('li');
            li._litPhotoRendered = true;
            li.style.cssText = 'list-style:none;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.04)';
            var img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            img.style.cssText = 'max-width:300px;max-height:300px;object-fit:contain;border-radius:8px;cursor:pointer;display:block;margin:4px 0';
            img.title = 'Click to open album';
            img.dataset.lpToken = result.token;
            img.dataset.lpHash = result.hash;
            img.addEventListener('click', function() { openAlbum(result.token, result.hash); });
            img.addEventListener('contextmenu', function(e) {
              e.preventDefault();
              window.litChat.photoContextMenu(result.token, result.hash);
            });
            captureThumb(img, result.hash);
            img.addEventListener('load', function() {
              var s = msgPane.closest('.message-pane-wrapper') || msgPane.parentElement;
              if (s) s.scrollTop = s.scrollHeight;
            }, { once: true });
            li.appendChild(img);
            msgPane.appendChild(li);
            var scroller = msgPane.closest('.message-pane-wrapper') || msgPane.parentElement;
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
          }

          // Send the XMPP DM with album link
          try {
            var conn = Candy.Core.getConnection();
            var viewBase = result.partnerViewUrl || ('https://picpub.art/v/' + result.token);
            var msgBody = '\\u{1F4F7} View photo: ' + viewBase + '#' + result.hash;
            var stanza = $msg({ to: jid, type: 'chat' }).c('body').t(msgBody);
            conn.send(stanza.tree ? stanza.tree() : stanza);
          } catch (sendErr) {
            console.warn('[picpub] send failed:', sendErr.message);
          }
        } catch (err) {
          if (indLi) indLi.remove();
          if (msgPane) {
            var errLi = document.createElement('li');
            errLi.style.cssText = 'list-style:none;padding:4px 8px;color:#e05050;font-size:12px';
            errLi.textContent = 'Upload failed: ' + err.message;
            msgPane.appendChild(errLi);
            setTimeout(function() { errLi.remove(); }, 5000);
          }
        }
      }

      // ── 📷 / 🔗 buttons in each DM message form ────────────────────────────

      async function handlePicpubLink(jid, url, context) {
        var pane = document.querySelector('.room-pane[data-roomjid=' + JSON.stringify(jid) + ']');
        var msgPane = pane ? pane.querySelector('ul.message-pane, ul[class*="message"]') : null;
        var indLi;
        if (msgPane) {
          indLi = document.createElement('li');
          indLi.style.cssText = 'list-style:none;padding:2px 8px';
          var ind = document.createElement('span');
          ind.style.cssText = 'color:#7c5cbf;font-size:12px;font-style:italic';
          ind.textContent = 'Linking image…';
          indLi.appendChild(ind);
          msgPane.appendChild(indLi);
          var indScroller = msgPane.closest('.message-pane-wrapper') || msgPane.parentElement;
          if (indScroller) indScroller.scrollTop = indScroller.scrollHeight;
        }
        try {
          var slash = jid.indexOf('/');
          var partner = slash !== -1 ? jid.slice(slash + 1) : jid.split('@')[0];
          var result = await window.litChat.linkPhoto(partner, url);
          if (indLi) indLi.remove();
          if (!result.ok) throw new Error(result.error || 'link failed');

          if (msgPane) {
            var li = document.createElement('li');
            li._litPhotoRendered = true;
            li.style.cssText = 'list-style:none;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,0.04)';
            if (context) {
              var surroundText = context.replace(url, '').replace(/\\s+/g, ' ').trim();
              if (surroundText) {
                var textEl = document.createElement('span');
                textEl.style.cssText = 'display:block;font-size:13px;margin-bottom:4px';
                textEl.textContent = surroundText;
                li.appendChild(textEl);
              }
            }
            var thumbSrc = result.native_url || ('litpic://' + result.token + '/' + result.hash);
            var thumb = makeThumb(thumbSrc, function() { openAlbum(result.token, result.hash); }, result.token, result.hash);
            thumb.addEventListener('load', function() {
              var s = msgPane.closest('.message-pane-wrapper') || msgPane.parentElement;
              if (s) s.scrollTop = s.scrollHeight;
            }, { once: true });
            li.appendChild(thumb);
            msgPane.appendChild(li);
            var scroller = msgPane.closest('.message-pane-wrapper') || msgPane.parentElement;
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
          }

          try {
            var conn = Candy.Core.getConnection();
            var viewBase = result.partnerViewUrl || ('https://picpub.art/v/' + result.token);
            var photoFmt = '\\u{1F4F7} View photo: ' + viewBase + '#' + result.hash;
            var msgBody = context ? context.replace(url, photoFmt) : photoFmt;
            var stanza = $msg({ to: jid, type: 'chat' }).c('body').t(msgBody);
            conn.send(stanza.tree ? stanza.tree() : stanza);
          } catch (sendErr) {
            console.warn('[picpub] send failed:', sendErr.message);
          }
        } catch (err) {
          if (indLi) indLi.remove();
          if (msgPane) {
            var errLi = document.createElement('li');
            errLi.style.cssText = 'list-style:none;padding:4px 8px;color:#e05050;font-size:12px';
            errLi.textContent = 'Link failed: ' + err.message;
            msgPane.appendChild(errLi);
            setTimeout(function() { errLi.remove(); }, 5000);
          }
        }
      }

      function addPhotoButton(pane) {
        if (pane._litPhotoBtn) return;
        var jid = pane.dataset.roomjid || '';
        // Skip bare conference-room JIDs; allow DMs (including room/partner JIDs with a '/')
        var slash = jid.indexOf('/');
        if (!jid || (slash === -1 && jid.indexOf('@conference.') !== -1)) return;
        var partner = slash !== -1 ? jid.slice(slash + 1) : jid.split('@')[0];
        var form = pane.querySelector('.message-form');
        var submitBtn = form && form.querySelector('input[type="submit"], button[type="submit"]');
        if (!submitBtn) return;
        pane._litPhotoBtn = true;

        var IBTN = 'background:none;border:none;cursor:pointer;font-size:17px;' +
                   'padding:0 4px;opacity:0.55;line-height:1;vertical-align:middle;flex-shrink:0';
        function iconBtn(emoji, title) {
          var b = document.createElement('button');
          b.type = 'button'; b.title = title; b.textContent = emoji; b.style.cssText = IBTN;
          b.addEventListener('mouseenter', function() { b.style.opacity = '1'; });
          b.addEventListener('mouseleave', function() { b.style.opacity = '0.55'; });
          return b;
        }

        // Hidden file input
        var fileInput = document.createElement('input');
        fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.cssText = 'display:none';
        fileInput.addEventListener('change', function() {
          var f = fileInput.files[0]; fileInput.value = '';
          if (f) handlePhotoUpload(jid, f);
        });

        // 📷 — opens file picker
        var photoBtn = iconBtn('\\u{1F4F7}', 'Upload photo');
        photoBtn.addEventListener('click', function() { fileInput.click(); });

        // 🖼 — opens photo gallery for this DM
        var galleryBtn = iconBtn('\\u{1F5BC}\\uFE0F', 'Photo gallery');
        galleryBtn.addEventListener('click', function() { showGallery(partner); });

        form.insertBefore(fileInput, submitBtn);
        form.insertBefore(photoBtn, submitBtn);
        form.insertBefore(galleryBtn, submitBtn);

        // Intercept form submit: if the input contains a picpub.art URL, link it instead of sending
        var textInput = form.querySelector('input[type="text"], textarea');
        if (textInput) {
          form.addEventListener('submit', function(e) {
            var val = textInput.value.trim();
            var urlM = /(https?:\\/\\/picpub\\.art\\/\\S+)/.exec(val);
            if (!urlM) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            textInput.value = '';
            var picpubUrl = urlM[1];
            var context = val === picpubUrl ? null : val;
            handlePicpubLink(jid, picpubUrl, context);
          }, true);
        }

        // Drag-and-drop onto the DM pane
        var dragDepth = 0;
        pane.addEventListener('dragenter', function(e) {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          if (++dragDepth === 1) pane.style.outline = '2px dashed #7c5cbf';
        });
        pane.addEventListener('dragover', function(e) {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
        });
        pane.addEventListener('dragleave', function() {
          if (--dragDepth === 0) pane.style.outline = '';
        });
        pane.addEventListener('drop', function(e) {
          e.preventDefault();
          pane.style.outline = ''; dragDepth = 0;
          var file = Array.from(e.dataTransfer.files).find(function(f) {
            return f.type.startsWith('image/');
          });
          if (file) handlePhotoUpload(jid, file);
        });
      }

      document.querySelectorAll('.room-pane[data-roomjid]').forEach(addPhotoButton);

      // Watch for new panes and message lists
      var chatRooms = document.getElementById('chat-rooms');
      if (chatRooms) {
        new MutationObserver(function(muts) {
          muts.forEach(function(mut) {
            mut.addedNodes.forEach(function(node) {
              if (node.nodeType !== 1) return;
              node.querySelectorAll('ul.message-pane, ul[class*="message"]').forEach(observePane);
              if (node.dataset && node.dataset.roomjid) addPhotoButton(node);
              // Also check descendants (pane may be a wrapper)
              node.querySelectorAll('.room-pane[data-roomjid]').forEach(function(child) {
                child.querySelectorAll('ul.message-pane, ul[class*="message"]').forEach(observePane);
                addPhotoButton(child);
              });
            });
          });
        }).observe(chatRooms, { childList: true, subtree: true });
      }
    })();
  `).catch(() => {});
}

// ── End PicPub photo sharing ─────────────────────────────────────────────────

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
        const sentMsgs = extractMessages(sent, 'sent');
        writeMessages(sentMsgs);
        // Detect our own Literotica username from the local-part of our JID
        if (!myLitUsername) {
          for (const m of sentMsgs) {
            if (m.from) {
              const at = m.from.indexOf('@');
              if (at !== -1) {
                myLitUsername = m.from.slice(0, at);
                if (!settings.prefs) settings.prefs = {};
                settings.prefs.litUsername = myLitUsername;
                saveSettings();
                break;
              }
            }
          }
        }
        // Reset room idle timer for our own sent messages so the server's
        // reflection of them (received stanza) doesn't trigger a notification
        for (const m of sentMsgs) {
          if (m.type === 'groupchat' && m.to)
            roomLastMessage.set(unescapeJid(m.to), Date.now());
        }
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
        notifyRoomMessages(received);
        handlePresence(extractPresence(body));
      } catch (_) {}
    }
  });
}

app.whenReady().then(() => {
  // Proxy litpic://TOKEN/HASH → PicPub API with owner-token auth
  // Must be registered on the partition session, not the default session.
  session.fromPartition(PARTITION).protocol.handle('litpic', async (request) => {
    const qmark = request.url.indexOf('?');
    const base  = qmark === -1 ? request.url : request.url.slice(0, qmark);
    const query = qmark === -1 ? '' : request.url.slice(qmark + 1);
    const after = base.slice('litpic://'.length);
    const slash = after.indexOf('/');
    if (slash === -1) return new Response('Bad URL', { status: 400 });
    const token = after.slice(0, slash);
    const hash  = after.slice(slash + 1);
    const vtCode = new URLSearchParams(query).get('vt');
    const album = settings.picpubAlbums?.[token];
    const authHeader = album?.ownerToken
      ? { 'X-Owner-Token': album.ownerToken }
      : vtCode
        ? { 'X-Viewer-Token': vtCode }
        : myLitUsername
          ? { 'X-Viewer': myLitUsername }
          : null;
    if (!authHeader) return new Response('No auth available', { status: 401 });
    try {
      const fetchHeaders = Object.assign({}, authHeader);
      const rangeHeader = request.headers.get('Range');
      if (rangeHeader) fetchHeaders['Range'] = rangeHeader;
      return await fetch(`https://picpub.art/v/api/albums/${token}/images/${hash}`, {
        headers: fetchHeaders,
      });
    } catch (e) {
      return new Response(e.message, { status: 502 });
    }
  });

  createAppMenu();
  createWindow();
  attachBOSHLogger();
  setupTray();
  setupAutoUpdater();

  const sess = session.fromPartition(PARTITION);

  // Block the site's notification permission — it fires a popup for every room message.
  // Our own DM/presence notifications go through sendNotification() directly and are unaffected.
  sess.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission !== 'notifications');
  });

  // Silence the site's broken favicon requests
  sess.webRequest.onBeforeRequest(
    { urls: ['*://*/favicon.png', '*://*/favicon.ico'] },
    (details, callback) => {
      if (details.url.includes('favicon')) callback({ cancel: true });
      else callback({});
    }
  );
});

app.on('window-all-closed', () => app.quit());
