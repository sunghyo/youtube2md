import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeHtmlEntities, parseCaptionJson3, parseTimedTextXml } from '../youtube.js';

test('parses json3 caption payloads with millisecond normalization', () => {
  const payload = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 2500, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
      { tStartMs: 3000, segs: [{ utf8: '\n' }] },
      { tStartMs: 4500, dDurationMs: 1500, segs: [{ utf8: 'Second line' }] },
    ],
  });

  assert.deepEqual(parseCaptionJson3(payload), [
    { text: 'Hello world', startSeconds: 0, durationSeconds: 2.5 },
    { text: 'Second line', startSeconds: 4.5, durationSeconds: 1.5 },
  ]);
});

test('returns no segments for malformed json3 payloads', () => {
  assert.deepEqual(parseCaptionJson3('not json'), []);
  assert.deepEqual(parseCaptionJson3('{"events": "nope"}'), []);
});

test('parses srv3 timedtext XML with word-level segments', () => {
  const xml =
    '<timedtext><body>' +
    '<p t="1000" d="2000"><s>Hello</s><s> world</s></p>' +
    '<p t="4000" d="1000">Plain &amp; simple</p>' +
    '</body></timedtext>';

  assert.deepEqual(parseTimedTextXml(xml), [
    { text: 'Hello world', startSeconds: 1, durationSeconds: 2 },
    { text: 'Plain & simple', startSeconds: 4, durationSeconds: 1 },
  ]);
});

test('parses legacy timedtext XML with second-based attributes', () => {
  const xml =
    '<transcript>' +
    '<text start="1.5" dur="2.25">First</text>' +
    '<text start="4" dur="2">Second</text>' +
    '</transcript>';

  assert.deepEqual(parseTimedTextXml(xml), [
    { text: 'First', startSeconds: 1.5, durationSeconds: 2.25 },
    { text: 'Second', startSeconds: 4, durationSeconds: 2 },
  ]);
});

test('does not read attribute values from other attributes with similar names', () => {
  // "at" ends with "t"; without a name boundary the start time would read as 99ms.
  const xml = '<x><p at="99" t="5000" d="1000">Hi</p></x>';

  assert.deepEqual(parseTimedTextXml(xml), [
    { text: 'Hi', startSeconds: 5, durationSeconds: 1 },
  ]);
});

test('decodes named, decimal, and hex HTML entities', () => {
  assert.equal(decodeHtmlEntities('a &amp; b'), 'a & b');
  assert.equal(decodeHtmlEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeHtmlEntities('it&#39;s &quot;fine&quot;'), 'it\'s "fine"');
  assert.equal(decodeHtmlEntities('&#x1F600; smile'), '😀 smile');
  assert.equal(decodeHtmlEntities('keep &unknown; as-is'), 'keep &unknown; as-is');
});
