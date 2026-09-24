// Wording for a failed PicPub request, shown under the message box as
// "Upload failed: <this>", and for a failed story search (service 'Story search').
// Kept out of main.js so it can be tested on its own.
//
// Node's fetch reports every network failure as just "fetch failed"; the reason
// (ENOTFOUND, ECONNREFUSED, a certificate error) is on e.cause. Chromium's net.fetch,
// which picpubFetch uses, puts it in the message instead ("net::ERR_NAME_NOT_RESOLVED").
// Both are covered so the reason is never thrown away, and a network-level failure is
// explained as one, because "fetch failed" alone gave the user nothing to act on.
function friendlyFetchError(e, service = 'PicPub') {
  if (e && e.name === 'TimeoutError') return `${service} did not respond in time — check your connection and try again`;
  const msg = (e && e.message) || String(e);
  const cause = e && e.cause && (e.cause.code || e.cause.message);
  const detail = cause && !msg.includes(cause) ? `${msg}: ${cause}` : msg;
  const networkFailure = /^net::ERR_/.test(msg) || msg === 'fetch failed';
  return networkFailure
    ? `Could not reach ${service} (${detail}) — check your connection, and if you use a firewall, VPN or proxy, allow Lit Chat to connect to picpub.art`
    : detail;
}

module.exports = { friendlyFetchError };
