import { test, expect } from "bun:test";
const { isPublicAddress, isPreviewableUrl, resolvesToPublic } = require('./preview-guard');

test("private, loopback and special addresses are not public", () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254',
                    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
                    '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1',
                    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.0.1', '64:ff9b::10.0.0.1']) {
    expect(isPublicAddress(ip)).toBe(false);
  }
});

test("ordinary public addresses are allowed", () => {
  for (const ip of ['8.8.8.8', '140.82.112.3', '172.32.0.1', '2606:4700::6810:84e5', '64:ff9b::8.8.8.8']) {
    expect(isPublicAddress(ip)).toBe(true);
  }
});

test("URL text checks reject non-web schemes and local names", () => {
  expect(isPreviewableUrl('https://example.com/a')).toBe(true);
  for (const u of ['file:///etc/passwd', 'ftp://x.com/', 'http://localhost/', 'http://localhost./',
                   'http://printer.local/', 'http://a.localhost:8080/', 'not a url']) {
    expect(isPreviewableUrl(u)).toBe(false);
  }
});

const fakeLookup = table => async host => {
  if (!(host in table)) throw new Error('ENOTFOUND');
  return table[host].map(address => ({ address }));
};

test("hosts are judged by what they resolve to", async () => {
  const lookup = fakeLookup({
    'example.com': ['93.184.215.14'],
    '127.0.0.1.nip.io': ['127.0.0.1'],
    'mixed.example': ['93.184.215.14', '10.0.0.5'],
  });
  expect(await resolvesToPublic('https://example.com/', lookup)).toBe(true);
  expect(await resolvesToPublic('https://example.com./', lookup)).toBe(true);
  expect(await resolvesToPublic('http://127.0.0.1.nip.io/', lookup)).toBe(false);
  expect(await resolvesToPublic('http://mixed.example/', lookup)).toBe(false);
  expect(await resolvesToPublic('http://nowhere.example/', lookup)).toBe(false);
});

test("IP literals are checked without a lookup", async () => {
  const lookup = () => { throw new Error('should not look up'); };
  expect(await resolvesToPublic('http://[::ffff:127.0.0.1]/', lookup)).toBe(false);
  expect(await resolvesToPublic('http://192.168.0.1:8080/', lookup)).toBe(false);
  expect(await resolvesToPublic('http://8.8.8.8/', lookup)).toBe(true);
  // The URL parser rewrites these to hex form (::ffff:7f00:1, 64:ff9b::a00:1).
  expect(await resolvesToPublic('http://[64:ff9b::10.0.0.1]/', lookup)).toBe(false);
  expect(await resolvesToPublic('http://[64:ff9b::8.8.8.8]/', lookup)).toBe(true);
});
