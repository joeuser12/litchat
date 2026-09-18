const { test, expect } = require('bun:test');
const { parsePhotoBody } = require('./media-parse');

test('Format A: native picpub link, whole body', () => {
  expect(parsePhotoBody('📷 https://picpub.art/abc123.jpg')).toEqual({
    kind: 'native', url: 'https://picpub.art/abc123.jpg', whole: true,
  });
});

test('Format A inside other text is not "whole"', () => {
  const p = parsePhotoBody('12:01 Nick 📷 https://picpub.art/abc123.png');
  expect(p.kind).toBe('native');
  expect(p.url).toBe('https://picpub.art/abc123.png');
  expect(p.whole).toBe(false);
});

test('Format B: uploaded album photo', () => {
  expect(parsePhotoBody('📷 View photo: https://picpub.art/v/deadbeef01#a1b2c3.jpg')).toEqual({
    kind: 'album',
    base: 'https://picpub.art/v/deadbeef01',
    token: 'deadbeef01',
    hash: 'a1b2c3.jpg',
    vt: null,
    fullUrl: 'https://picpub.art/v/deadbeef01#a1b2c3.jpg',
    litpicSrc: 'litpic://deadbeef01/a1b2c3.jpg',
    isVideo: false,
  });
});

test('Format B with ?vt= viewer code carries it into litpic://', () => {
  const p = parsePhotoBody('📷 View photo: https://picpub.art/v/deadbeef01?vt=AbCdEf1234#a1b2c3.jpg');
  expect(p.base).toBe('https://picpub.art/v/deadbeef01?vt=AbCdEf1234');
  expect(p.vt).toBe('AbCdEf1234');
  expect(p.litpicSrc).toBe('litpic://deadbeef01/a1b2c3.jpg?vt=AbCdEf1234');
  expect(p.fullUrl).toBe('https://picpub.art/v/deadbeef01?vt=AbCdEf1234#a1b2c3.jpg');
});

test('Format B video', () => {
  expect(parsePhotoBody('📷 View photo: https://picpub.art/v/deadbeef01#clip.mp4').isVideo).toBe(true);
});

test('Format C: direct image URL from any host', () => {
  expect(parsePhotoBody('look https://example.com/a/b.PNG?x=1 wow')).toEqual({
    kind: 'image', url: 'https://example.com/a/b.PNG?x=1',
  });
});

test('non-photo text', () => {
  expect(parsePhotoBody('hello there')).toBeNull();
  expect(parsePhotoBody('see https://example.com/page')).toBeNull();
  expect(parsePhotoBody('📷 (photo expired)')).toBeNull();
  expect(parsePhotoBody('')).toBeNull();
  expect(parsePhotoBody(null)).toBeNull();
  expect(parsePhotoBody(undefined)).toBeNull();
});

test('only the first photo of a multi-photo string is reported', () => {
  const p = parsePhotoBody(
    '📷 View photo: https://picpub.art/v/aaaa#old.jpg … 📷 View photo: https://picpub.art/v/bbbb#new.jpg'
  );
  expect(p.token).toBe('aaaa');
});

// The function is shipped to the page via toString(); it must survive that
// round trip with no references to anything outside its own body.
test('is self-contained when re-evaluated from source', () => {
  const fn = new Function('return (' + parsePhotoBody.toString() + ')')();
  expect(fn('📷 View photo: https://picpub.art/v/deadbeef01?vt=Zz9#h.webm')).toEqual(
    parsePhotoBody('📷 View photo: https://picpub.art/v/deadbeef01?vt=Zz9#h.webm')
  );
  expect(fn('📷 https://picpub.art/abc.gif').whole).toBe(true);
});
