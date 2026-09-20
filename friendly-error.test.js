import { test, expect } from 'bun:test';

const { friendlyFetchError } = require('./friendly-error');

const HINT = 'allow Lit Chat to connect to picpub.art';

test('a timeout keeps its own wording', () => {
  const e = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  expect(friendlyFetchError(e)).toBe('PicPub did not respond in time — check your connection and try again');
});

test("Node's bare 'fetch failed' now carries the real reason from e.cause", () => {
  const e = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND picpub.art'), { code: 'ENOTFOUND' }) });
  const out = friendlyFetchError(e);
  expect(out).toContain('fetch failed: ENOTFOUND');
  expect(out).toContain(HINT);
});

test("a cause with only a message (no code) is still shown", () => {
  const e = new TypeError('fetch failed', { cause: new Error('bad port') });
  expect(friendlyFetchError(e)).toContain('fetch failed: bad port');
});

test("Chromium's net:: errors are kept verbatim and explained as a network problem", () => {
  const out = friendlyFetchError(new Error('net::ERR_NAME_NOT_RESOLVED'));
  expect(out).toContain('(net::ERR_NAME_NOT_RESOLVED)');
  expect(out).toContain('Could not reach PicPub');
  expect(out).toContain(HINT);
});

test('the reason is not repeated when the message already contains it', () => {
  const e = new TypeError('fetch failed ENOTFOUND', { cause: { code: 'ENOTFOUND' } });
  expect(friendlyFetchError(e).match(/ENOTFOUND/g).length).toBe(1);
});

test('server-side failures are passed through unchanged, with no firewall advice', () => {
  const out = friendlyFetchError(new Error('Upload failed: 413 Payload Too Large'));
  expect(out).toBe('Upload failed: 413 Payload Too Large');
  expect(out).not.toContain(HINT);
});

test('non-Error values do not throw', () => {
  expect(friendlyFetchError('boom')).toBe('boom');
  expect(friendlyFetchError(undefined)).toBe('undefined');
  expect(friendlyFetchError(null)).toBe('null');
});
