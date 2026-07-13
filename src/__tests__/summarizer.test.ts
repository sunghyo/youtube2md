import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeChapters,
  parseTimestampToSeconds,
  stripTimeMarkers,
} from '../summarizer.js';
import type { Chapter } from '../types.js';

function chapter(overrides: Partial<Chapter> & Pick<Chapter, 'seconds'>): Chapter {
  return {
    title: 'Chapter title',
    descriptions: ['A description.'],
    ...overrides,
    timestamp: overrides.timestamp ?? formatSecondsForTest(overrides.seconds),
  };
}

function formatSecondsForTest(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

test('relocates overlap-leaked descriptions across chunks in the global pass', () => {
  // Chunk-level normalization (keepTimeMarkers = true) must preserve the inline
  // time marker so the later global pass can move the description to the chunk
  // that actually covers that time.
  const chunk1 = normalizeChapters(
    [
      chapter({ seconds: 0, title: 'Intro topic', descriptions: ['Point about the intro.'] }),
      chapter({ seconds: 180, title: 'Second topic', descriptions: ['Second point.'] }),
    ],
    { minSeconds: 0, maxSeconds: 300 },
    true
  );
  const chunk2 = normalizeChapters(
    [
      chapter({
        seconds: 300,
        title: 'Third topic',
        descriptions: ['Real third point.', '(0:30) leaked description belonging to the intro'],
      }),
    ],
    { minSeconds: 300, maxSeconds: 600 },
    true
  );

  const leaked = chunk2[0].descriptions.find((d) => d.includes('leaked'));
  assert.ok(leaked?.includes('0:30'), 'chunk-level pass must keep the time marker');

  const finalChapters = normalizeChapters([...chunk1, ...chunk2]);

  assert.equal(finalChapters.length, 3);
  assert.deepEqual(
    finalChapters[0].descriptions,
    ['Point about the intro.', 'leaked description belonging to the intro'],
    'leaked description moves to the chapter covering 0:30 with its marker stripped'
  );
  assert.deepEqual(finalChapters[2].descriptions, ['Real third point.']);
});

test('final pass strips time markers from descriptions', () => {
  const chapters = normalizeChapters([
    chapter({ seconds: 0, descriptions: ['[0:10] bracketed point', 'plain point'] }),
  ]);

  assert.deepEqual(chapters[0].descriptions, ['bracketed point', 'plain point']);
});

test('merges chapters at the same boundary and unions descriptions', () => {
  const chapters = normalizeChapters([
    chapter({ seconds: 100, title: 'Short', descriptions: ['First point.'] }),
    chapter({ seconds: 108, title: 'Longer chapter title', descriptions: ['Second point.'] }),
  ]);

  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, 'Longer chapter title');
  assert.deepEqual(chapters[0].descriptions, ['First point.', 'Second point.']);
});

test('keeps nearby chapters separate when titles differ', () => {
  const chapters = normalizeChapters([
    chapter({ seconds: 100, title: 'Pricing deep dive', descriptions: ['Costs.'] }),
    chapter({ seconds: 130, title: 'Battery test results', descriptions: ['Runtime.'] }),
  ]);

  assert.equal(chapters.length, 2);
});

test('clamps chapter seconds into the provided window and regenerates timestamps', () => {
  const chapters = normalizeChapters(
    [chapter({ timestamp: '0:10', seconds: 10, title: 'Out of window' })],
    { minSeconds: 120, maxSeconds: 300 }
  );

  assert.equal(chapters[0].seconds, 120);
  assert.equal(chapters[0].timestamp, '2:00');
});

test('trusts the display timestamp over a mismatched seconds field', () => {
  const chapters = normalizeChapters([
    chapter({ timestamp: '2:30', seconds: 999, title: 'Mismatch' }),
  ]);

  assert.equal(chapters[0].seconds, 150);
});

test('parses well-formed display timestamps', () => {
  assert.equal(parseTimestampToSeconds('2:30'), 150);
  assert.equal(parseTimestampToSeconds('1:04:30'), 3870);
  assert.equal(parseTimestampToSeconds('0:00'), 0);
});

test('rejects malformed display timestamps', () => {
  assert.equal(parseTimestampToSeconds('3:2'), undefined);
  assert.equal(parseTimestampToSeconds('3:75'), undefined);
  assert.equal(parseTimestampToSeconds('abc'), undefined);
  assert.equal(parseTimestampToSeconds('1:2:3:4'), undefined);
  assert.equal(parseTimestampToSeconds('12'), undefined);
});

test('strips bracketed, parenthesized, and leading bare time markers', () => {
  assert.equal(stripTimeMarkers('[12:34] the point'), 'the point');
  assert.equal(stripTimeMarkers('설명 (1:00~1:20) 이어짐'), '설명 이어짐');
  assert.equal(stripTimeMarkers('26:58에서 설명한 내용'), '설명한 내용');
  assert.equal(stripTimeMarkers('no markers here'), 'no markers here');
});
