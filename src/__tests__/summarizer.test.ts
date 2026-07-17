import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveChunkTargets,
  deriveOutputTargets,
  normalizeChapters,
  parseTimestampToSeconds,
  stripTimeMarkers,
  summarizeWithProvider,
} from '../summarizer.js';
import type { ChunkTargets, TranscriptChunk } from '../summarizer.js';
import type { SummaryProvider, StructuredSummaryRequest } from '../summary-provider.js';
import type { Chapter, TranscriptSegment, VideoMetadata } from '../types.js';

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

// ─── Output scaling ───────────────────────────────────────────────────────────

function parseRange(range: string): { lo: number; hi: number } {
  const [lo, hi] = range.split('-').map(Number);
  return { lo, hi: hi ?? lo };
}

test('global output targets scale with video length instead of hitting a flat cap', () => {
  // ~30-minute video (3 chunks, ~15k tokens) vs ~3-hour video (19 chunks, ~95k tokens).
  const short = deriveOutputTargets(30 * 60, 3, 15_000);
  const long = deriveOutputTargets(180 * 60, 19, 95_000);

  assert.ok(
    long.summaryParagraphs >= short.summaryParagraphs + 4,
    `3-hour summary must span many more paragraphs (got ${long.summaryParagraphs} vs ${short.summaryParagraphs})`
  );
  assert.ok(
    parseRange(long.summarySentences).lo >= parseRange(short.summarySentences).lo * 4,
    `3-hour summary sentence floor must be several times the 30-minute one ` +
      `(got ${long.summarySentences} vs ${short.summarySentences})`
  );
  assert.ok(
    parseRange(long.takeawayCount).hi > parseRange(short.takeawayCount).hi * 2,
    `3-hour takeaway ceiling must scale (got ${long.takeawayCount} vs ${short.takeawayCount})`
  );
  // The description band floor is proportional to transcript volume: 6x tokens → ~6x floor.
  assert.ok(long.minDescriptions >= short.minDescriptions * 5);
});

test('output targets never fall below the pre-scaling fixed buckets at any length', () => {
  // The old implementation used these fixed buckets; the continuous scaling may
  // only ask for more at every duration, never less (no shorter-video regression).
  const legacyBuckets = (durationSeconds: number, chunkCount: number) => {
    if (durationSeconds >= 45 * 60 || chunkCount >= 6) {
      return { summary: [9, 14], chapters: [8, 18], takeaways: [8, 14] };
    }
    if (durationSeconds >= 15 * 60 || chunkCount >= 3) {
      return { summary: [6, 10], chapters: [6, 12], takeaways: [6, 10] };
    }
    return { summary: [4, 7], chapters: [4, 8], takeaways: [4, 7] };
  };

  const cases: Array<[number, number, number]> = [
    [5 * 60, 1, 1_500],
    [14 * 60, 1, 4_500],
    [20 * 60, 2, 8_000],
    [30 * 60, 4, 11_500],
    [44 * 60, 5, 17_000],
    [45 * 60, 5, 18_000],
    [60 * 60, 6, 29_000],
    [90 * 60, 10, 46_000],
  ];

  for (const [durationSeconds, chunkCount, tokens] of cases) {
    const targets = deriveOutputTargets(durationSeconds, chunkCount, tokens);
    const legacy = legacyBuckets(durationSeconds, chunkCount);
    const checks: Array<[string, string, number[]]> = [
      ['summary', targets.summarySentences, legacy.summary],
      ['chapters', targets.chapterCount, legacy.chapters],
      ['takeaways', targets.takeawayCount, legacy.takeaways],
    ];
    for (const [label, range, [legacyLo, legacyHi]] of checks) {
      const { lo, hi } = parseRange(range);
      assert.ok(
        lo >= legacyLo && hi >= legacyHi,
        `${durationSeconds / 60}min ${label}: ${range} must not fall below legacy ${legacyLo}-${legacyHi}`
      );
    }
  }
});

function makeChunk(overrides: Partial<TranscriptChunk> = {}): TranscriptChunk {
  return {
    index: 0,
    segments: [],
    text: '',
    tokenLength: 5000,
    startSeconds: 0,
    endSeconds: 600,
    contextText: '',
    ...overrides,
  };
}

test('chunk description band is a variable range proportional to chunk content', () => {
  const targets = deriveChunkTargets(makeChunk());
  const { lo, hi } = parseRange(targets.descriptionCount);

  // The count is a band, not a fixed number: the ceiling must exceed the floor.
  assert.ok(hi > lo, `descriptionCount must be a range, got ${targets.descriptionCount}`);
  assert.equal(targets.minDescriptions, lo, 'minDescriptions is the low end of the band');
  assert.ok(lo >= 8, `10-min 5000-token chunk should ask for a substantial floor, got ${lo}`);
  assert.ok(parseRange(targets.chapterCount).lo >= 3);

  // A sparse chunk (few words over a long span) keeps a modest band.
  const sparse = deriveChunkTargets(makeChunk({ tokenLength: 900, endSeconds: 3600 }));
  assert.ok(parseRange(sparse.descriptionCount).lo <= 8);
});

test('detail level shifts the description band up or down for the same chunk', () => {
  const chunk = makeChunk();
  const concise = deriveChunkTargets(chunk, 'concise');
  const balanced = deriveChunkTargets(chunk, 'balanced');
  const exhaustive = deriveChunkTargets(chunk, 'exhaustive');

  const lo = (t: ChunkTargets) => parseRange(t.descriptionCount).lo;

  assert.ok(
    lo(exhaustive) > lo(balanced) && lo(balanced) > lo(concise),
    `expected exhaustive > balanced > concise, got ` +
      `${lo(exhaustive)} / ${lo(balanced)} / ${lo(concise)}`
  );
  // The default level is balanced, and exhaustive is meaningfully denser than concise.
  assert.deepEqual(
    deriveChunkTargets(chunk).descriptionCount,
    balanced.descriptionCount,
    'default detail level must be balanced'
  );
  assert.ok(lo(exhaustive) >= lo(concise) * 2, 'exhaustive should roughly double concise density');

  // Each level carries a distinct tone rule for the prompt.
  assert.notEqual(concise.toneRule, exhaustive.toneRule);
});

test('detail level shifts the global (single-pass) description band too', () => {
  const args: [number, number, number] = [20 * 60, 2, 9_000];
  const concise = deriveOutputTargets(...args, 'concise');
  const exhaustive = deriveOutputTargets(...args, 'exhaustive');

  assert.ok(
    parseRange(exhaustive.descriptionCount).lo > parseRange(concise.descriptionCount).lo,
    `exhaustive floor ${exhaustive.descriptionCount} must exceed concise ${concise.descriptionCount}`
  );
});

// ─── Detail-escalation retry ──────────────────────────────────────────────────

function makeSegments(): TranscriptSegment[] {
  return Array.from({ length: 12 }, (_, i) => ({
    text: `Point number ${i} about the topic with some concrete detail ${i * 7}.`,
    startSeconds: i * 5,
    durationSeconds: 5,
  }));
}

function makeMetadata(): VideoMetadata {
  return {
    videoId: 'test123',
    title: 'Test video',
    duration: '1:00',
    publishDate: '2026-01-01',
    description: '',
    nativeChapters: [],
  };
}

function summaryJson(descriptionCount: number): string {
  return JSON.stringify({
    summary: 'A summary of the test video.',
    chapters: [
      {
        timestamp: '0:00',
        seconds: 0,
        title: 'Test chapter',
        descriptions: Array.from(
          { length: descriptionCount },
          (_, i) => `Distinct fact ${i} from the transcript.`
        ),
      },
    ],
    takeaways: ['A takeaway.'],
  });
}

function makeProvider(responses: string[]): {
  provider: SummaryProvider;
  requests: StructuredSummaryRequest[];
} {
  const requests: StructuredSummaryRequest[] = [];
  return {
    requests,
    provider: {
      kind: 'openai',
      name: 'Fake provider',
      async generate(request) {
        requests.push(request);
        const response = responses[Math.min(requests.length - 1, responses.length - 1)];
        return response;
      },
    },
  };
}

test('a too-sparse response triggers one escalated retry demanding the description floor', async () => {
  const { provider, requests } = makeProvider([summaryJson(2), summaryJson(12)]);

  const result = await summarizeWithProvider(
    provider,
    makeSegments(),
    makeMetadata(),
    'test-model'
  );

  assert.equal(requests.length, 2, 'sparse first response must trigger exactly one retry');
  assert.match(requests[1].instructions, /DETAIL ESCALATION/);
  assert.match(requests[1].instructions, /at least \d+ description entries/);
  assert.equal(result.chapters[0].descriptions.length, 12, 'richer retry result must win');
});

test('a sufficiently detailed response does not trigger a detail retry', async () => {
  const { provider, requests } = makeProvider([summaryJson(11)]);

  await summarizeWithProvider(provider, makeSegments(), makeMetadata(), 'test-model');

  assert.equal(requests.length, 1);
});

test('a failed escalation retry keeps the first valid response', async () => {
  let calls = 0;
  const provider: SummaryProvider = {
    kind: 'openai',
    name: 'Fake provider',
    async generate() {
      calls += 1;
      if (calls === 1) {
        return summaryJson(2);
      }
      throw Object.assign(new Error('boom'), { status: 400 });
    },
  };

  const result = await summarizeWithProvider(
    provider,
    makeSegments(),
    makeMetadata(),
    'test-model'
  );

  assert.equal(result.chapters[0].descriptions.length, 2);
});
