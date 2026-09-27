import { test, expect } from "bun:test";
const { parseLinkMeta } = require('./link-meta');

test("reads og tags in either attribute order", () => {
  const r = parseLinkMeta(`<head>
    <meta property="og:title" content="Hello">
    <meta content="A page" property="og:description" />
    <meta property='og:image' content='https://x.com/a.jpg'>
    <meta property="og:site_name" content="X">
  </head>`);
  expect(r).toEqual({ title: 'Hello', description: 'A page', image: 'https://x.com/a.jpg', siteName: 'X' });
});

test("falls back to <title> and name=description", () => {
  const r = parseLinkMeta(`<TITLE lang="en"> Plain title </TITLE><meta name="Description" content="desc">`);
  expect(r.title).toBe('Plain title');
  expect(r.description).toBe('desc');
  expect(r.image).toBeNull();
});

test("keeps apostrophes inside double-quoted content", () => {
  expect(parseLinkMeta(`<meta property="og:title" content="Don't miss this">`).title).toBe("Don't miss this");
});

test("ignores tags that only start with 'meta' or 'title'", () => {
  const r = parseLinkMeta(`<metadata property="og:title" content="no"><titles>no</titles>`);
  expect(r.title).toBeNull();
});

test("returns nulls for empty or tagless input", () => {
  expect(parseLinkMeta('')).toEqual({ title: null, description: null, image: null, siteName: null });
});

test("stays fast on crafted input that froze the old regexes", () => {
  const cases = [
    '<meta property="og:title" '.repeat(10_000),   // unclosed meta tags (the original freeze)
    '<meta ' + 'a'.repeat(256 * 1024) + '>',        // one huge attribute-name run
    '<title'.repeat(40_000),                         // unclosed titles
    '<meta ' + 'a='.repeat(100_000) + '>',           // many empty assignments
  ];
  for (const html of cases) {
    const t = performance.now();
    parseLinkMeta(html);
    expect(performance.now() - t).toBeLessThan(200);
  }
});

test("HTML entities are decoded in content and <title>", () => {
  const r = parseLinkMeta(`<title>Tom &amp; Jerry &#8211; Episode&nbsp;1</title>
    <meta property="og:description" content="It&#39;s &quot;great&quot; &hellip;">
    <meta property="og:image" content="https://img.example/a.png?w=1&amp;h=2">`);
  expect(r.title).toBe('Tom & Jerry \u2013 Episode\u00a01');
  expect(r.description).toBe('It\'s "great" \u2026');
  expect(r.image).toBe('https://img.example/a.png?w=1&h=2');
});

test("unknown or out-of-range entities are left as written", () => {
  const { decodeEntities } = require('./link-meta');
  expect(decodeEntities('&bogus; &#x110000; &#0; a&b')).toBe('&bogus; &#x110000; &#0; a&b');
});
