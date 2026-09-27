import { test, expect, beforeAll, afterAll } from "bun:test";
const fs = require('fs');
const os = require('os');
const path = require('path');

// logstore reads LIT_USERDATA when it is first required.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logstore-test-'));
process.env.LIT_USERDATA = dir;
const { LOG_DIR, msgSig, rewriteLogs, readAllMessages } = require('./logstore');

const dm = (ts, from, body) => ({ ts, direction: 'received', type: 'chat', from, to: 'me@x', body });
const a1 = dm('2026-09-01T10:00:00.000Z', 'lobby@conf/alice', 'hi "there"');
const a2 = dm('2026-09-01T10:01:00.000Z', 'lobby@conf/alice', 'second');
const b1 = dm('2026-09-02T09:00:00.000Z', 'lobby@conf/bob', 'from bob');

const file = name => path.join(LOG_DIR, name);
beforeAll(() => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(file('chat-2026-09-01.jsonl'), [a1, a2].map(m => JSON.stringify(m)).join('\n') + '\nnot json\n');
  fs.writeFileSync(file('chat-2026-09-02.jsonl'), JSON.stringify(b1) + '\n');
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test("deletes only the matching message and keeps malformed lines", () => {
  const untouched = fs.statSync(file('chat-2026-09-02.jsonl')).mtimeMs;
  const sig = msgSig(a1);
  rewriteLogs(m => msgSig(m) !== sig);

  expect(readAllMessages().map(m => m.body)).toEqual(['second', 'from bob']);
  expect(fs.readFileSync(file('chat-2026-09-01.jsonl'), 'utf8')).toContain('not json');
  // A file with nothing to delete is not rewritten.
  expect(fs.statSync(file('chat-2026-09-02.jsonl')).mtimeMs).toBe(untouched);
  expect(fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.tmp'))).toEqual([]);
});

test("msgSig survives quotes in the body", () => {
  expect(msgSig(a1)).toBe('2026-09-01T10:00:00.000Z|received|hi "there"');
});

test("replayed room history already in the log is dropped; new replays and live messages stay", () => {
  const { withoutLoggedReplays } = require('./logstore');
  const room = 'lobby@conf';
  const live = { ts: '2026-09-03T10:00:04.000Z', direction: 'received', type: 'groupchat', from: room + '/carol', body: 'morning all' };
  fs.writeFileSync(file('chat-2026-09-03.jsonl'), JSON.stringify(live) + '\n');

  // The server's stamp differs from our logged arrival time by a few seconds.
  const replay    = { ...live, ts: '2026-09-03T10:00:01.000Z', delayed: true };
  const unseen    = { ...live, body: 'from before we joined', delayed: true };
  const farLater  = { ...live, ts: '2026-09-03T11:00:00.000Z', delayed: true };   // same text, an hour on
  const liveAgain = { ...live, ts: '2026-09-03T10:01:00.000Z' };                  // not a replay
  expect(withoutLoggedReplays([replay, unseen, farLater, liveAgain])).toEqual([unseen, farLater, liveAgain]);
});

test("old lines with XML-escaped nicks are found by the real nick", () => {
  const { messagesWithPeer } = require('./logstore');
  const old = { ts: '2026-09-04T09:00:00.000Z', direction: 'received', type: 'chat', from: 'lobby@conf/o&apos;neil', to: 'me@x', body: 'hi' };
  fs.writeFileSync(file('chat-2026-09-04.jsonl'), JSON.stringify(old) + '\n');
  const found = messagesWithPeer("o'neil");
  expect(found.map(m => m.body)).toEqual(['hi']);
  expect(found[0].from).toBe("lobby@conf/o'neil");
});

test("a room's subject announcement is logged once, not on every join", () => {
  const { withoutLoggedReplays } = require('./logstore');
  const subject = { ts: '2026-09-05T08:00:00.000Z', direction: 'received', type: 'groupchat', from: 'nudist@conf', body: 'Bob has set the subject to: hi' };
  fs.writeFileSync(file('chat-2026-09-05.jsonl'), JSON.stringify(subject) + '\n');
  const nextJoin = { ...subject, ts: '2026-09-05T20:00:00.000Z' };
  const changed  = { ...nextJoin, body: 'Bob has set the subject to: new topic' };
  expect(withoutLoggedReplays([nextJoin, changed])).toEqual([changed]);
});

test("room names are fully XEP-0106 unescaped", () => {
  const { roomOf } = require('./logstore');
  const room = local => roomOf({ type: 'groupchat', direction: 'received', from: local + '@conf/x' });
  expect(room('m\\2ff\\20roleplay')).toBe('m/f roleplay');
  expect(room('a\\3cb\\3e')).toBe('a<b>');
  expect(room('back\\5c20slash')).toBe('back\\20slash');   // an escaped backslash is not read as \20
});
