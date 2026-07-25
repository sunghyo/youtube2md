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

test('relocates a mis-filed description to the chapter covering its time marker', () => {
  const chapters = normalizeChapters([
    chapter({ seconds: 0, title: 'Intro topic', descriptions: ['Point about the intro.'] }),
    chapter({
      seconds: 300,
      title: 'Third topic',
      descriptions: ['Real third point.', '(0:30) point belonging to the intro'],
    }),
  ]);

  assert.equal(chapters.length, 2);
  assert.deepEqual(
    chapters[0].descriptions,
    ['Point about the intro.', 'point belonging to the intro'],
    'mis-filed description moves to the chapter covering 0:30 with its marker stripped'
  );
  assert.deepEqual(chapters[1].descriptions, ['Real third point.']);
});

test('leaves a bare mid-sentence time in place instead of treating it as a marker', () => {
  // "3:16" here is prose, not a marker. Reading it as a time relocated the
  // bullet from the 1:00:00 chapter to 0:00 and left the digits in the text.
  const chapters = normalizeChapters([
    chapter({ seconds: 0, title: 'Opening', descriptions: ['Point about the intro.'] }),
    chapter({
      seconds: 3600,
      title: 'Scripture segment',
      descriptions: ['John 3:16 was quoted as the key verse', 'A 4:30 win/loss ratio was cited'],
    }),
  ]);

  assert.equal(chapters.length, 2);
  assert.deepEqual(chapters[0].descriptions, ['Point about the intro.']);
  assert.deepEqual(chapters[1].descriptions, [
    'John 3:16 was quoted as the key verse',
    'A 4:30 win/loss ratio was cited',
  ]);
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
  // A bare time inside a sentence is prose, not a marker, and stays untouched.
  assert.equal(
    stripTimeMarkers('John 3:16 was quoted as the key verse'),
    'John 3:16 was quoted as the key verse'
  );
});

// ─── Output scaling ───────────────────────────────────────────────────────────

test('global output targets scale with video length instead of hitting a flat cap', () => {
  // ~30-minute video (3 chunks, ~15k tokens) vs ~3-hour video (19 chunks, ~95k tokens).
  const short = deriveOutputTargets(30 * 60, 3, 15_000);
  const long = deriveOutputTargets(180 * 60, 19, 95_000);

  assert.ok(
    long.summaryParagraphs > short.summaryParagraphs,
    `3-hour summary must span more paragraphs (got ${long.summaryParagraphs} vs ${short.summaryParagraphs})`
  );
  assert.ok(
    long.summarySentences >= short.summarySentences * 4,
    `3-hour summary sentence target must be several times the 30-minute one ` +
      `(got ${long.summarySentences} vs ${short.summarySentences})`
  );
  assert.ok(
    long.takeawayCount > short.takeawayCount * 2,
    `3-hour takeaway target must scale (got ${long.takeawayCount} vs ${short.takeawayCount})`
  );
  // The description target is proportional to transcript volume: 6x tokens → ~6x target.
  assert.ok(long.descriptionCount >= short.descriptionCount * 5);
});

test('output targets never fall below the minimum floors at any length', () => {
  // Mirror of the duration-bucketed floors in deriveOutputTargets: continuous
  // scaling may only ask for more at every duration, never less.
  const floorsFor = (durationSeconds: number, chunkCount: number) => {
    if (durationSeconds >= 45 * 60 || chunkCount >= 6) {
      return { summary: 3, chapters: 8, takeaways: 7 };
    }
    if (durationSeconds >= 15 * 60 || chunkCount >= 3) {
      return { summary: 2, chapters: 6, takeaways: 5 };
    }
    return { summary: 2, chapters: 4, takeaways: 4 };
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
    const floors = floorsFor(durationSeconds, chunkCount);
    const checks: Array<[string, number, number]> = [
      ['summary', targets.summarySentences, floors.summary],
      ['chapters', targets.chapterCount, floors.chapters],
      ['takeaways', targets.takeawayCount, floors.takeaways],
    ];
    for (const [label, target, floor] of checks) {
      assert.ok(
        target >= floor,
        `${durationSeconds / 60}min ${label}: ${target} must not fall below floor ${floor}`
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
    ...overrides,
  };
}

test('chunk description target is proportional to chunk content', () => {
  const targets = deriveChunkTargets(makeChunk());

  assert.ok(
    targets.descriptionCount >= 8,
    `10-min 5000-token chunk should ask for a substantial target, got ${targets.descriptionCount}`
  );
  assert.ok(targets.chapterCount >= 2);

  // A sparse chunk (few words over a long span) keeps a modest target.
  const sparse = deriveChunkTargets(makeChunk({ tokenLength: 900, endSeconds: 3600 }));
  assert.ok(sparse.descriptionCount <= 8);
});

test('chunk targets survive broken timestamps by falling back to token volume', () => {
  // Every target cross-checks against wall-clock duration, so a chunk whose
  // segments all carry the same (or a bogus) time must not collapse to minimums.
  const healthy = deriveChunkTargets(makeChunk({ tokenLength: 13_000, endSeconds: 2340 }));
  const broken = deriveChunkTargets(makeChunk({ tokenLength: 13_000, endSeconds: 0 }));

  assert.ok(
    broken.descriptionCount >= healthy.descriptionCount * 0.9,
    `broken-timestamp chunk must keep its description target ` +
      `(got ${broken.descriptionCount} vs ${healthy.descriptionCount})`
  );
  // The token-derived duration is a conservative lower bound (it assumes maximum
  // speech density), so the duration-driven targets land lower than the healthy
  // chunk's — but well clear of the 2-chapter / 2-takeaway floors they used to hit.
  assert.ok(
    broken.chapterCount >= healthy.chapterCount * 0.6,
    `broken-timestamp chunk must keep a real chapter target ` +
      `(got ${broken.chapterCount} vs ${healthy.chapterCount})`
  );
  assert.ok(broken.takeawayCount > 2, `expected a real takeaway target, got ${broken.takeawayCount}`);
});

test('detail level shifts the description target up or down for the same chunk', () => {
  const chunk = makeChunk();
  const concise = deriveChunkTargets(chunk, 'concise');
  const balanced = deriveChunkTargets(chunk, 'balanced');
  const exhaustive = deriveChunkTargets(chunk, 'exhaustive');

  const target = (t: ChunkTargets) => t.descriptionCount;

  assert.ok(
    target(exhaustive) > target(balanced) && target(balanced) > target(concise),
    `expected exhaustive > balanced > concise, got ` +
      `${target(exhaustive)} / ${target(balanced)} / ${target(concise)}`
  );
  // The default level is balanced, and exhaustive is meaningfully denser than concise.
  assert.equal(
    deriveChunkTargets(chunk).descriptionCount,
    balanced.descriptionCount,
    'default detail level must be balanced'
  );
  assert.ok(
    target(exhaustive) >= target(concise) * 2,
    'exhaustive should roughly double concise density'
  );

  // Each level carries a distinct tone rule for the prompt.
  assert.notEqual(concise.toneRule, exhaustive.toneRule);
});

test('detail level shifts the global (single-pass) description target too', () => {
  const args: [number, number, number] = [20 * 60, 2, 9_000];
  const concise = deriveOutputTargets(...args, 'concise');
  const exhaustive = deriveOutputTargets(...args, 'exhaustive');

  assert.ok(
    exhaustive.descriptionCount > concise.descriptionCount,
    `exhaustive target ${exhaustive.descriptionCount} must exceed concise ${concise.descriptionCount}`
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

test('a transcript that splits into one chunk uses single-pass instead of chunk+synthesis', async () => {
  // 1100 segments ≈ 22.7k tokens: over SINGLE_PASS_TOKEN_LIMIT, but the short
  // trailing chunk folds back into its predecessor, so the split yields one
  // chunk. That used to run the chunked path — two requests, and chapters
  // capped by CHUNK_CHAPTER_CAP instead of the global target.
  const segments: TranscriptSegment[] = Array.from({ length: 1100 }, (_, i) => ({
    text: `Point number ${i} about the topic with some concrete detail ${i * 7}.`,
    startSeconds: i * 5,
    durationSeconds: 5,
  }));
  const { provider, requests } = makeProvider([summaryJson(60)]);

  await summarizeWithProvider(provider, segments, makeMetadata(), 'test-model');

  assert.equal(requests.length, 1, 'a single-chunk transcript must not pay for a synthesis pass');
  assert.equal(requests[0].schemaName, 'video_summary');
  assert.doesNotMatch(
    requests[0].instructions,
    /chunk/i,
    'the request must use the single-pass prompt, not the per-chunk prompt'
  );
});

test('the summary budget stays a short orientation even for a very long video', () => {
  // The Summary section frames the notes; the chapter descriptions carry the
  // detail. Budgets that let it run 20+ sentences turned it into a second copy
  // of the chapters, so the ceiling is deliberately low at every length.
  const hour = deriveOutputTargets(60 * 60, 1, 23_000);
  assert.ok(
    hour.summarySentences <= 4,
    `a 1-hour video must ask for a handful of sentences, got ${hour.summarySentences}`
  );

  const threeHours = deriveOutputTargets(180 * 60, 19, 95_000);
  assert.ok(
    threeHours.summarySentences <= 8,
    `even a 3-hour video must stay under the ceiling, got ${threeHours.summarySentences}`
  );
  assert.ok(
    threeHours.summarySentences >= hour.summarySentences,
    'the budget must still grow with length, just within a tight ceiling'
  );
});

test('prompts tell the model to size each chapter by its own content, not evenly', async () => {
  // A bare total target gets spent evenly: every chapter comes back with the
  // same three or four bullets whether its section is dense or filler.
  const { provider: singleProvider, requests: singleRequests } = makeProvider([summaryJson(12)]);
  await summarizeWithProvider(singleProvider, makeSegments(), makeMetadata(), 'test-model');
  assert.match(singleRequests[0].instructions, /Size every chapter independently/);

  // 4000 segments ≈ 80k tokens, well past SINGLE_PASS_TOKEN_LIMIT, so this takes
  // the chunked path and the first request is a per-chunk prompt.
  const segments: TranscriptSegment[] = Array.from({ length: 4000 }, (_, i) => ({
    text: `Point number ${i} about the topic with some concrete detail ${i * 7}.`,
    startSeconds: i * 5,
    durationSeconds: 5,
  }));
  // Answer by schema rather than by call index: the chunk count is a function of
  // the split, so a fixed response list would break if it ever shifts.
  const chunkRequests: StructuredSummaryRequest[] = [];
  const chunkProvider: SummaryProvider = {
    kind: 'openai',
    name: 'Fake provider',
    async generate(request) {
      chunkRequests.push(request);
      return request.schemaName === 'video_summary'
        ? summaryJson(20)
        : JSON.stringify({ summary: 'Global summary.', takeaways: ['A takeaway.'] });
    },
  };
  await summarizeWithProvider(chunkProvider, segments, makeMetadata(), 'test-model');

  assert.ok(chunkRequests.length > 1, 'this transcript must take the chunked path');
  assert.match(chunkRequests[0].instructions, /Size every chapter independently/);
});

test('prompts require the summary to answer a question posed by the video title', async () => {
  // A title written as a question is the one thing a reader opens the summary
  // for; a brevity rule alone produces "the video explores whether X", which
  // restates the question instead of answering it.
  const { provider, requests } = makeProvider([summaryJson(12)]);
  await summarizeWithProvider(provider, makeSegments(), makeMetadata(), 'test-model');

  assert.match(requests[0].instructions, /If the title poses a question/);
  assert.match(requests[0].instructions, /Restating or rephrasing the question is not an answer/);
  // The rule is useless unless the title actually reaches the model.
  assert.match(requests[0].input, /Title: Test video/);
});
