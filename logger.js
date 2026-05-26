const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.env.LIT_USERDATA || __dirname, 'logs');

function logFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `chat-${date}.jsonl`);
}

// Minimal XMPP <message> extractor — handles standard chat and groupchat stanzas.
// Not a full XML parser; ignores stanzas without a <body> (e.g. read receipts, typing).
function extractMessages(xml, direction) {
  const out = [];
  const msgRe = /<message\b([^>]*)>([\s\S]*?)<\/message>/g;
  let m;
  while ((m = msgRe.exec(xml)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const from  = (attrs.match(/\bfrom=["']([^"']+)["']/) || [])[1];
    const to    = (attrs.match(/\bto=["']([^"']+)["']/)   || [])[1];
    const type  = (attrs.match(/\btype=["']([^"']+)["']/) || [])[1] || 'normal';
    const bodyM = inner.match(/<body[^>]*>([\s\S]*?)<\/body>/);
    if (bodyM) {
      out.push({
        ts: new Date().toISOString(),
        direction,
        type,   // 'chat' = DM, 'groupchat' = room
        from,
        to,
        body: bodyM[1],
      });
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

module.exports = { extractMessages, writeMessages };
