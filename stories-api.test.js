import { test, expect } from 'bun:test';

const { buildSearchUrl, normalizeStory, normalizeResponse, parseRoomMap, storyOptsForRoom } = require('./stories-api');

const params = (url) => Object.fromEntries(new URL(url).searchParams);

test('buildSearchUrl sends a trimmed query and category', () => {
  expect(params(buildSearchUrl({ q: '  vampire romance ', category: 'Romance' })))
    .toEqual({ search: '1', source: 'both', q: 'vampire romance', category: 'Romance' });
});

test('buildSearchUrl drops unknown options and caps the query', () => {
  const p = params(buildSearchUrl({ q: 'x'.repeat(500), sort_by: 'views', author: 'bob' }));
  expect(p.q.length).toBe(300);
  expect(p.sort_by).toBeUndefined();
  expect(p.author).toBeUndefined();
});

test('buildSearchUrl: random wins over q, morelike needs a slug', () => {
  expect(params(buildSearchUrl({ random: true, q: 'ignored' }))).toEqual({ search: '1', source: 'both', random: '1' });
  expect(params(buildSearchUrl({ morelike: 'woodsman-ch-05' })).morelike).toBe('woodsman-ch-05');
  expect(params(buildSearchUrl({ morelike: 'bad slug&x=1', q: 'fallback' }))).toEqual({ search: '1', source: 'both', q: 'fallback' });
});

test('buildSearchUrl coerces offset to a positive integer', () => {
  expect(params(buildSearchUrl({ q: 'a', offset: '50.7' })).offset).toBe('50');
  expect(params(buildSearchUrl({ q: 'a', offset: -5 })).offset).toBeUndefined();
  expect(params(buildSearchUrl({ q: 'a', offset: 'abc' })).offset).toBeUndefined();
});

test('normalizeStory: a series uses series title, words and chapter count', () => {
  const s = normalizeStory({
    slug: 'woodsman-ch-05', title: 'Woodsman Ch. 05', series_title: 'Woodsman', author: 'A',
    category: 'Romance', tags: ['a', 'b', '', 3, 'c', 'd', 'e', 'f', 'g'], rating: 4.5, rating_count: 90,
    word_count: 4000, series_word_count: 40000, date_published: '2012-03-04',
    url: 'https://www.literotica.com/s/woodsman-ch-01', summary: 'S', chapter_count: 9,
  });
  expect(s).toMatchObject({ title: 'Woodsman', words: 40000, chapters: 9, year: '2012', source: 'lit', rating: 4.5, votes: 90 });
  expect(s.tags).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
});

test('normalizeStory: a single story has no chapter badge', () => {
  const s = normalizeStory({ slug: 'one', title: 'One', word_count: 3000, url: 'https://www.literotica.com/s/one', chapter_count: null });
  expect(s).toMatchObject({ title: 'One', words: 3000, chapters: null, tags: [], rating: null });
});

test('normalizeStory: AO3 is detected by slug', () => {
  expect(normalizeStory({ slug: 'ao3-123', url: 'https://archiveofourown.org/works/123' }).source).toBe('ao3');
});

test('normalizeStory drops results without an http(s) url', () => {
  expect(normalizeStory({ slug: 'x', url: 'javascript:alert(1)' })).toBeNull();
  expect(normalizeStory({ slug: 'x' })).toBeNull();
  expect(normalizeStory(null)).toBeNull();
});

test('normalizeResponse computes the next page offset', () => {
  const r = normalizeResponse({
    results: [{ slug: 'a', url: 'https://www.literotica.com/s/a' }, { slug: 'b', url: 'nope' }],
    query_info: { has_more: true, offset: 50, page_size: 50 },
  });
  expect(r.results.length).toBe(1);
  expect(r.hasMore).toBe(true);
  expect(r.nextOffset).toBe(100);
  expect(normalizeResponse({}).results).toEqual([]);
});

test('parseRoomMap reads "room = category" lines and skips comments and blanks', () => {
  const map = parseRoomMap(`# comment
Taboo Roleplay        = Taboo/Incest
huge tits             =
aliens, demons and monsters = NonHuman

no equals sign here
`);
  expect([...map]).toEqual([['taboo roleplay', 'Taboo/Incest'], ['aliens, demons and monsters', 'NonHuman']]);
});

test('storyOptsForRoom: mapped room, unmapped room, lobby and private chat', () => {
  const map = parseRoomMap('taboo roleplay = Taboo/Incest');
  expect(storyOptsForRoom('Taboo Roleplay', map)).toEqual({ random: true, category: 'Taboo/Incest' });
  expect(storyOptsForRoom('huge tits', map)).toEqual({ q: 'huge tits' });
  expect(storyOptsForRoom('literotica lobby', map)).toEqual({ random: true });
  expect(storyOptsForRoom('', map)).toEqual({ random: true });
});
