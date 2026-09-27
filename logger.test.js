import { test, expect } from "bun:test";
const { extractMessages } = require('./logger');

test("a childless <message/> does not swallow the next stanza", () => {
  const xml = "<body><message to='a@b' type='chat'/>" +
              "<message from='room@conf/Bob' type='groupchat'><body>hi</body></message></body>";
  const out = extractMessages(xml, 'received', 'T');
  expect(out.length).toBe(1);
  expect(out[0]).toMatchObject({ from: 'room@conf/Bob', type: 'groupchat', body: 'hi' });
});

test("from and to are XML-unescaped like the body", () => {
  const xml = "<message from='room@conf/o&apos;neil' to='me@x/Candy' type='chat'><body>a &amp; b</body></message>";
  expect(extractMessages(xml, 'received', 'T')[0]).toMatchObject({ from: "room@conf/o'neil", body: 'a & b' });
});

test("delay-stamped messages are marked as replays and keep their stamp", () => {
  const xml = "<message from='room@conf/Bob' type='groupchat'><body>old</body>" +
              "<delay xmlns='urn:xmpp:delay' stamp='2026-09-01T10:00:00Z'/></message>" +
              "<message from='room@conf/Bob' type='groupchat'><body>new</body></message>";
  const [old, now] = extractMessages(xml, 'received', '2026-09-27T00:00:00.000Z');
  expect(old).toMatchObject({ ts: '2026-09-01T10:00:00.000Z', delayed: true });
  expect(now.delayed).toBeUndefined();
  expect(now.ts).toBe('2026-09-27T00:00:00.000Z');
});
