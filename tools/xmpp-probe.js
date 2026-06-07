#!/usr/bin/env node
/**
 * xmpp-probe.js — minimal BOSH/XMPP test client for chat.literotica.com
 *
 * Usage:
 *   node tools/xmpp-probe.js <username> <password>
 *
 * What it does:
 *   1. Fetches a fresh auth_token JWT by logging in via the literotica API
 *   2. Opens a BOSH session to literotica.com/netchat/http-bind/
 *   3. Authenticates via SASL PLAIN
 *   4. Binds a resource and establishes an XMPP session
 *   5. Stays connected and accepts probe commands from stdin:
 *        rooms           — list joined rooms
 *        create <name>   — create a private temporary MUC room
 *        config <jid>    — send room config IQ (private/hidden/temp)
 *        invite <room> <user> — send mediated invite
 *        msg <jid> <text> — send a chat or groupchat message
 *        raw <xml>       — send raw stanza
 *        quit            — disconnect
 */

'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const readline = require('readline');

// ── Config ───────────────────────────────────────────────────────────────────

// BOSH URL confirmed from network inspection of the Electron app.
// NOTE: the CDN at literotica.com does TLS/JA3 fingerprinting and only routes to
// ejabberd for real browser connections. Direct Node.js BOSH connections get 301 to
// www.literotica.com. This script is useful for auth testing; BOSH itself requires
// a browser context (use Electron renderer injection instead for actual XMPP work).
const BOSH_URL   = 'https://literotica.com/netchat/http-bind/';
const XMPP_HOST  = 'newchat.literotica.com';
const CONF_HOST  = 'conference.newchat.literotica.com';
const LOGIN_PAGE = 'https://www.literotica.com/authenticate/login';
const AUTH_POST  = 'https://auth.literotica.com/login';

// ── Args ─────────────────────────────────────────────────────────────────────

const [,, username, password] = process.argv;
if (!username || !password) {
  console.error('Usage: node tools/xmpp-probe.js <username> <password>');
  process.exit(1);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

// Raw request — no redirect following
function requestNoRedirect(urlStr, opts, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      family: 4,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Simple cookie jar: parse name=value from Set-Cookie lines, merge into existing jar
function mergeSetCookies(jar, setCookieLines) {
  for (const line of setCookieLines) {
    const m = line.match(/^([^=]+)=([^;]*)/);
    if (m) jar[m[1].trim()] = m[2].trim();
  }
  return jar;
}
function cookieJarHeader(jar, extraCookie) {
  const base = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  if (!extraCookie) return base;
  return base ? `${extraCookie}; ${base}` : extraCookie;
}

// Request with redirect following + cookie jar forwarding across hops
function request(urlStr, opts, body, _redirects, _allCookies, _jar) {
  _allCookies = _allCookies || [];
  _jar = _jar || {};
  // Seed jar from initial Cookie header (first call only)
  if (_redirects === undefined) {
    const initCookie = (opts.headers || {})['Cookie'] || '';
    for (const pair of initCookie.split(';')) {
      const eq = pair.indexOf('=');
      if (eq > 0) _jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const cookieStr = Object.entries(_jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const headers = Object.assign({}, opts.headers || {});
    if (cookieStr) headers['Cookie'] = cookieStr;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers,
      family: 4,   // force IPv4 — JWT ip claim binds to IPv4 address
    }, res => {
      const sc = [].concat(res.headers['set-cookie'] || []);
      _allCookies.push(...sc);
      mergeSetCookies(_jar, sc);
      // Follow redirects (up to 8), switching to GET after 303
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && (_redirects||0) < 8) {
        const loc = new URL(res.headers.location, urlStr).href;
        const nextMethod = res.statusCode === 303 ? 'GET' : (opts.method || 'GET');
        const nextBody = nextMethod === 'GET' ? undefined : body;
        res.resume();
        resolve(request(loc, { ...opts, method: nextMethod }, nextBody, (_redirects||0) + 1, _allCookies, _jar));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), _allSetCookies: _allCookies, _jar });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Step 1: get auth token (two-step: form login → JWT exchange) ─────────────

async function getAuthToken(user, pass) {
  // Step 1a: POST login form to auth.literotica.com
  // Fields: login, password, return_to, form_url, select
  const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
  console.log('[auth] Posting credentials to auth.literotica.com…');
  const redirect = encodeURIComponent('https://chat.literotica.com/');
  const errRedir = encodeURIComponent('https://www.literotica.com/authenticate/login');
  const formBody = [
    'login='    + encodeURIComponent(user),
    'password=' + encodeURIComponent(pass),
    'return_to=www.literotica.com',
    'form_url='  + encodeURIComponent('https://www.literotica.com/authenticate/login'),
    'select=1',
  ].join('&');

  const loginUrl = `${AUTH_POST}?redirect=${redirect}&err_redirect=${errRedir}`;
  // Don't follow redirects — we need the Set-Cookie from the 303 response itself
  const r1 = await requestNoRedirect(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formBody),
      'User-Agent': UA,
      'Referer': 'https://www.literotica.com/authenticate/login',
      'Origin': 'https://www.literotica.com',
    },
  }, formBody);

  console.log('[auth] Login response:', r1.status, JSON.stringify(r1.headers['set-cookie']));
  // Extract the sessionid cookie from Set-Cookie
  const cookies1 = [].concat(r1.headers['set-cookie'] || []);
  const sessionM = cookies1.join('; ').match(/sessionid=([^;]+)/);
  if (!sessionM) throw new Error('[auth] No sessionid in login response (status=' + r1.status + ', wrong credentials?)');
  const sessionid = sessionM[1];
  console.log('[auth] Got sessionid, fetching chat page to get auth_token…');

  // Step 1b: GET chat.literotica.com/ (following redirects) with sessionid.
  // auth.literotica.com/check will see the sessionid and issue an auth_token JWT.
  const r2 = await request('https://chat.literotica.com/', {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Cookie': `sessionid=${sessionid}; authenticated=1`,
    },
  });

  // auth_token is set during the redirect chain — collect from all responses
  const allCookies = r2._allSetCookies || [];
  const tokenM = allCookies.join('; ').match(/auth_token=([^;]+)/);
  if (!tokenM) throw new Error('[auth] No auth_token after chat redirect (status=' + r2.status + ')');
  const token = tokenM[1];
  const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/') + '==', 'base64').toString());
  console.log('[auth] Got auth_token JWT — ip=%s ua=%s', payload.ip, payload.useragent);
  return { token, jar: r2._jar || {} };
}

// ── BOSH session ──────────────────────────────────────────────────────────────

class BOSHSession {
  constructor(url, xmppHost, authToken, cookieJar) {
    this.url       = url;
    this.xmppHost  = xmppHost;
    this.authToken = authToken;
    this.cookieJar = cookieJar || {};  // full jar from login redirect chain (may include serverid)
    this.sid       = null;
    this.rid       = Math.floor(Math.random() * 1e9);
    this.jid       = null;
    this.handlers  = [];  // [{re, fn, once}]
  }

  // Register a one-shot or persistent XML response handler
  on(pattern, fn, once = false) {
    this.handlers.push({ re: typeof pattern === 'string' ? new RegExp(pattern) : pattern, fn, once });
  }

  _dispatch(xml) {
    const toRemove = [];
    for (const h of this.handlers) {
      if (h.re.test(xml)) {
        h.fn(xml);
        if (h.once) toRemove.push(h);
      }
    }
    for (const h of toRemove) {
      this.handlers.splice(this.handlers.indexOf(h), 1);
    }
  }

  _headers() {
    // Build cookie string from the full login jar (preserves any serverid= sticky cookie)
    // then ensure auth_token and authenticated are present
    const jar = Object.assign({}, this.cookieJar);
    if (this.authToken) jar['auth_token'] = this.authToken;
    jar['authenticated'] = '1';
    const cookieStr = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    return {
      'Content-Type': 'text/plain;charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
      'Origin': 'https://chat.literotica.com',
      'Referer': 'https://chat.literotica.com/chat/',
      'Cookie': cookieStr,
    };
  }

  async send(body) {
    const xml = typeof body === 'string' ? body : this._wrap(body);
    const res = await requestNoRedirect(this.url, {
      method: 'POST',
      headers: { ...this._headers(), 'Content-Length': Buffer.byteLength(xml) },
    }, xml);
    if (res.status === 301 || res.status === 302) {
      throw new Error(`BOSH redirect to ${res.headers.location} — auth_token may be expired or IP mismatch`);
    }
    if (res.status !== 200) throw new Error(`BOSH ${res.status}: ${res.body.slice(0, 200)}`);
    if (res.body.trim()) {
      console.log('[recv]', res.body.slice(0, 800));
      this._dispatch(res.body);
    }
    return res.body;
  }

  _wrap(innerXml) {
    return `<body rid='${this.rid++}' sid='${this.sid}' xmlns='http://jabber.org/protocol/httpbind'>${innerXml}</body>`;
  }

  // ── Connection setup ────────────────────────────────────────────────────────

  async connect() {
    const initBody = `<body content='text/xml; charset=utf-8' hold='1' rid='${this.rid++}' to='${this.xmppHost}' ver='1.6' wait='60' xml:lang='en' xmpp:version='1.0' xmlns='http://jabber.org/protocol/httpbind' xmlns:xmpp='urn:ietf:params:xml:ns:xmpp-session'/>`;
    const res = await requestNoRedirect(this.url, {
      method: 'POST',
      headers: { ...this._headers(), 'Content-Length': Buffer.byteLength(initBody) },
    }, initBody);
    console.log('[init] status=%d body=%s', res.status, res.body.slice(0, 800));
    if (res.status === 301 || res.status === 302) {
      throw new Error(`BOSH redirected to ${res.headers.location} — auth_token may be expired or IP mismatch`);
    }
    const sidM = /\bsid='([^']+)'/.exec(res.body) || /\bsid="([^"]+)"/.exec(res.body);
    if (!sidM) throw new Error('No sid in init response');
    this.sid = sidM[1];
    return res.body;
  }

  async auth(user, pass) {
    // SASL PLAIN: base64("\0username\0password")
    const plain = Buffer.from(`\0${user}\0${pass}`).toString('base64');
    const xml = `<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>${plain}</auth>`;
    const res = await this.send(xml);
    if (!res.includes('success') && !res.includes('<success')) {
      throw new Error('SASL auth failed: ' + res.slice(0, 300));
    }
    return res;
  }

  async restart() {
    // After SASL success, restart the stream
    const xml = `<body rid='${this.rid++}' sid='${this.sid}' to='${this.xmppHost}' xml:lang='en' xmpp:restart='true' xmlns='http://jabber.org/protocol/httpbind' xmlns:xmpp='urn:ietf:params:xml:ns:xmpp-session'/>`;
    const res = await request(this.url, {
      method: 'POST',
      headers: { ...this._headers(), 'Content-Length': Buffer.byteLength(xml) },
    }, xml);
    console.log('[restart]', res.body.slice(0, 400));
    return res.body;
  }

  async bind(resource) {
    const iq = `<iq type='set' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><resource>${resource}</resource></bind></iq>`;
    const res = await this.send(iq);
    const jidM = /<jid>([^<]+)<\/jid>/.exec(res);
    if (jidM) { this.jid = jidM[1]; console.log('[jid]', this.jid); }
    return res;
  }

  async session() {
    return this.send(`<iq type='set' id='sess1'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>`);
  }

  async presence() {
    return this.send(`<presence><priority>1</priority></presence>`);
  }

  // ── MUC operations ──────────────────────────────────────────────────────────

  /** Join (and create) a room */
  async joinRoom(roomJid) {
    const nick = this.jid ? this.jid.split('@')[0] : username;
    return this.send(`<presence to='${roomJid}/${nick}'><x xmlns='http://jabber.org/protocol/muc'/></presence>`);
  }

  /** Configure room: private, hidden, non-persistent */
  async configRoom(roomJid) {
    const id = `cfg-${Date.now()}`;
    const iq = `<iq type='set' to='${roomJid}' id='${id}'>
  <query xmlns='http://jabber.org/protocol/muc#owner'>
    <x xmlns='jabber:x:data' type='submit'>
      <field var='FORM_TYPE'><value>http://jabber.org/protocol/muc#roomconfig</value></field>
      <field var='muc#roomconfig_publicroom'><value>0</value></field>
      <field var='muc#roomconfig_membersonly'><value>1</value></field>
      <field var='muc#roomconfig_persistentroom'><value>0</value></field>
      <field var='muc#roomconfig_whois'><value>anyone</value></field>
    </x>
  </query>
</iq>`;
    return this.send(iq);
  }

  /** Send mediated MUC invitation */
  async invite(roomJid, inviteeJid, reason) {
    const r = reason ? `<reason>${reason}</reason>` : '';
    return this.send(`<message to='${roomJid}'><x xmlns='http://jabber.org/protocol/muc#user'><invite to='${inviteeJid}'>${r}</invite></x></message>`);
  }

  /** Send direct (jabber:x:conference) invitation */
  async directInvite(roomJid, inviteeJid, reason) {
    const r = reason ? ` reason='${reason}'` : '';
    return this.send(`<message to='${inviteeJid}'><x xmlns='jabber:x:conference' jid='${roomJid}'${r}/></message>`);
  }

  /** Send a message */
  async message(toJid, text, type) {
    const t = type || (toJid.includes('@conference') ? 'groupchat' : 'chat');
    return this.send(`<message to='${toJid}' type='${t}'><body>${text}</body></message>`);
  }

  /** Empty poll — receive any pending stanzas */
  async poll() {
    return this.send('');
  }

  /** Disconnect */
  async disconnect() {
    try {
      await request(this.url, {
        method: 'POST',
        headers: { ...this._headers(), 'Content-Length': 0 },
      }, '');
    } catch {}
  }
}

// ── REPL ─────────────────────────────────────────────────────────────────────

async function repl(sess) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();

  rl.on('line', async line => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];
    try {
      if (!cmd) {
        // empty line → poll
        await sess.poll();
      } else if (cmd === 'quit') {
        await sess.disconnect();
        process.exit(0);
      } else if (cmd === 'create') {
        const name = parts[1] || `test-${Date.now()}`;
        const roomJid = `${name}@conference.${XMPP_HOST}`;
        console.log(`[create] Joining ${roomJid}…`);
        await sess.joinRoom(roomJid);
      } else if (cmd === 'config') {
        const roomJid = parts[1];
        if (!roomJid) { console.log('Usage: config <room-jid>'); }
        else { await sess.configRoom(roomJid); }
      } else if (cmd === 'invite') {
        const [, roomJid, invitee] = parts;
        const reason = parts.slice(3).join(' ');
        if (!roomJid || !invitee) { console.log('Usage: invite <room-jid> <user-jid> [reason]'); }
        else { await sess.invite(roomJid, invitee, reason); }
      } else if (cmd === 'directinvite') {
        const [, roomJid, invitee] = parts;
        const reason = parts.slice(3).join(' ');
        if (!roomJid || !invitee) { console.log('Usage: directinvite <room-jid> <user-jid> [reason]'); }
        else { await sess.directInvite(roomJid, invitee, reason); }
      } else if (cmd === 'msg') {
        const toJid = parts[1];
        const text  = parts.slice(2).join(' ');
        if (!toJid || !text) { console.log('Usage: msg <jid> <text>'); }
        else { await sess.message(toJid, text); }
      } else if (cmd === 'raw') {
        await sess.send(parts.slice(1).join(' '));
      } else if (cmd === 'jid') {
        console.log('JID:', sess.jid);
      } else if (cmd === 'help') {
        console.log('Commands: create [name], config <jid>, invite <room> <user> [reason],');
        console.log('          directinvite <room> <user> [reason], msg <jid> <text>,');
        console.log('          raw <xml>, jid, quit');
        console.log('(empty line polls for incoming stanzas)');
      } else {
        console.log('Unknown command. Type "help".');
      }
    } catch (e) {
      console.error('[error]', e.message);
    }
    rl.prompt();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const { token, jar } = await getAuthToken(username, password);
    console.log('[auth] Cookie jar after login:', Object.keys(jar).join(', '));

    const sess = new BOSHSession(BOSH_URL, XMPP_HOST, token, jar);

    console.log('[bosh] Opening session…');
    await sess.connect();

    console.log('[bosh] Authenticating…');
    await sess.auth(username, password);

    console.log('[bosh] Restarting stream…');
    await sess.restart();

    console.log('[bosh] Binding resource…');
    await sess.bind('probe');

    console.log('[bosh] Establishing session…');
    await sess.session();

    console.log('[bosh] Sending presence…');
    await sess.presence();

    console.log('\nConnected as', sess.jid || username);
    console.log('Type "help" for commands.\n');

    await repl(sess);
  } catch (e) {
    console.error('[fatal]', e.message);
    process.exit(1);
  }
})();
