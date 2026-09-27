// Which link previews the main process may fetch. A chat partner controls these
// URLs, so a preview must never reach loopback, the LAN or other non-public
// addresses. Checking the hostname text alone is not enough: "localhost." and
// names like 127.0.0.1.nip.io resolve to loopback, and a public page can redirect
// to a private one. So every hop is resolved and each address checked here.
const dns = require('dns');
const { BlockList, isIP } = require('net');

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(net, bits, 'ipv6');
// IPv4-mapped IPv6 (::ffff:127.0.0.1) is matched against the IPv4 rules by BlockList.

function isPublicAddress(ip) {
  const v = isIP(ip);
  if (!v) return false;
  // NAT64 (64:ff9b::/96) reaches the embedded IPv4 address, written either
  // dotted (64:ff9b::10.0.0.1) or, as the URL parser normalises it, in hex (::a00:1).
  const nat64 = v === 6 && /^64:ff9b::(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?)$/i.exec(ip);
  if (nat64) {
    if (nat64[1]) return isPublicAddress(nat64[1]);
    const n = nat64[3] === undefined ? parseInt(nat64[2], 16) : parseInt(nat64[2], 16) * 65536 + parseInt(nat64[3], 16);
    return isPublicAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  return !blocked.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

// Cheap checks on the URL text, before any lookup.
function isPreviewableUrl(u) {
  let x;
  try { x = new URL(u); } catch { return false; }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return false;
  const h = x.hostname.toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  return true;
}

// True if every address the URL's host resolves to is public.
async function resolvesToPublic(u, lookup = dns.promises.lookup) {
  const host = new URL(u).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host)) return isPublicAddress(host);
  let addrs;
  try { addrs = await lookup(host, { all: true, verbatim: true }); } catch { return false; }
  return addrs.length > 0 && addrs.every(a => isPublicAddress(a.address));
}

module.exports = { isPublicAddress, isPreviewableUrl, resolvesToPublic };
