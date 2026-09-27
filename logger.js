const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.env.LIT_USERDATA || __dirname, 'logs');

function logFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `chat-${date}.jsonl`);
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g,  '&'); // must be last
}

// Delayed-delivery stamp: XEP-0203 <delay stamp="..."/> (offline-message replay,
// MAM catch-up, carbons) marks a stanza as a replay of something sent earlier —
// the legacy XEP-0091 <x xmlns='jabber:x:delay' stamp="..."/> form is the same
// idea with an older, non-ISO stamp format. Without reading this, a replayed
// stanza gets logged with "now" as its ts, which can land it far later in the
// log than when it was actually sent (e.g. right at the end of the most recent
// conversation instead of wherever it actually happened).
function extractDelayStamp(inner) {
  const modern = inner.match(/<delay\b[^>]*\bstamp=["']([^"']+)["']/);
  if (modern) {
    const d = Date.parse(modern[1]);
    if (!isNaN(d)) return new Date(d).toISOString();
  }
  const legacy = inner.match(/<x\b[^>]*\bxmlns=["']jabber:x:delay["'][^>]*\bstamp=["']([^"']+)["']/) ||
                 inner.match(/<x\b[^>]*\bstamp=["']([^"']+)["'][^>]*\bxmlns=["']jabber:x:delay["']/);
  if (legacy) {
    // CCYYMMDDThh:mm:ss (UTC, no separators in the date part)
    const s = legacy[1];
    const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const d = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
      if (!isNaN(d)) return new Date(d).toISOString();
    }
  }
  return null;
}

// Minimal XMPP <message> extractor — handles standard chat and groupchat stanzas.
// Not a full XML parser; ignores stanzas without a <body> (e.g. read receipts, typing).
//
// `fallbackTs`, if given, is used for stanzas with no delay stamp instead of
// `new Date().toISOString()` — callers that only get to log a batch after an
// async delay (e.g. waiting on a network response body) should pass the time
// the batch actually arrived, so an undelayed stanza doesn't get stamped with
// whenever the async work happened to finish instead of when it truly arrived.
function extractMessages(xml, direction, fallbackTs) {
  const out = [];
  // The opening tag must not end in "/>": a childless <message …/> used to match
  // here and run on into the next stanza, logging that one under its attributes.
  const msgRe = /<message\b([^>]*[^\/>])?>([\s\S]*?)<\/message>/g;
  let m;
  while ((m = msgRe.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const inner = m[2];
    // Attribute values arrive XML-escaped (a nick like o'neil is o&apos;neil).
    const attr  = name => {
      const v = (attrs.match(new RegExp(`\\b${name}=["']([^"']+)["']`)) || [])[1];
      return v && unescapeXml(v);
    };
    const from  = attr('from');
    const to    = attr('to');
    const type  = (attrs.match(/\btype=["']([^"']+)["']/) || [])[1] || 'normal';
    const bodyM = inner.match(/<body[^>]*>([\s\S]*?)<\/body>/);
    if (bodyM) {
      const stamp = extractDelayStamp(inner);
      const msg = {
        ts: stamp || fallbackTs || new Date().toISOString(),
        direction,
        type,   // 'chat' = DM, 'groupchat' = room
        from,
        to,
        body: unescapeXml(bodyM[1]),
      };
      // A replay (room history on join, offline delivery): notifications skip these.
      if (stamp) msg.delayed = true;
      out.push(msg);
    }
  }
  return out;
}

function writeMessages(messages) {
  if (!messages.length) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  fs.appendFileSync(logFile(), lines);
}

module.exports = { extractMessages, writeMessages, unescapeXml };
