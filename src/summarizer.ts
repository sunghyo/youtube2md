import { createHash } from 'node:crypto';
import { encoding_for_model, get_encoding, type Tiktoken, type TiktokenModel } from 'tiktoken';
import type { SummaryProvider } from './summary-provider.js';
import type {
  TranscriptSegment,
  VideoMetadata,
  GptSummaryResponse,
  Chapter,
  NativeChapter,
  DetailLevel,
} from './types.js';
import { secondsToTimestamp } from './youtube.js';

// ─── Constants & Types ────────────────────────────────────────────────────────

// If full transcript token count is at or below this limit, summarize in one pass.
const SINGLE_PASS_TOKEN_LIMIT = 5_000;
// Target maximum tokens per chunk in chunked mode (kept below single-pass limit for prompt overhead headroom).
const CHUNK_TOKEN_LIMIT = 5_000;
// If the final chunk is smaller than this ratio of CHUNK_TOKEN_LIMIT, merge it into the previous chunk.
const MIN_LAST_CHUNK_RATIO = 0.25;
// Maximum number of concurrent GPT jobs when summarizing transcript chunks.
const MAX_CHUNK_SUMMARY_JOBS = 4;
// Once a chunk holds at least this fraction of the budget, close it at the next natural
// boundary (native chapter start or speech pause) instead of running to the hard limit.
const CHUNK_SOFT_FILL_RATIO = 0.6;
// A silent gap of at least this many seconds between segments is treated as a topic break.
const SPEECH_GAP_BREAK_SECONDS = 2.5;
// Leading overlap carried into each chunk (context only, no chapters), as a fraction of the budget.
const CHUNK_OVERLAP_RATIO = 0.12;
// Cap the leading overlap window so short, dense chunks don't pull in a huge preamble.
const MAX_OVERLAP_SECONDS = 60;
// Chapters within this many seconds are treated as the same boundary and merged unconditionally.
const CHAPTER_NEAR_SECONDS = 15;
// Chapters within this window are merged only if their titles are also similar.
const CHAPTER_MERGE_WINDOW_SECONDS = 45;
// A description whose inline time marker falls outside its chapter's window by more
// than this margin is relocated to the chapter that actually covers that time.
const DESCRIPTION_REASSIGN_TOLERANCE_SECONDS = 20;
// Total attempts (1 initial + retries) for each GPT request before giving up.
const MAX_API_ATTEMPTS = 3;
// Base delay for exponential backoff between retries.
const RETRY_BASE_DELAY_MS = 800;
// If a response carries fewer than this fraction of the requested description
// floor (the low end of the target band), re-request once with an escalated
// prompt so a drastically under-detailed response still gets corrected.
const DETAIL_RETRY_THRESHOLD = 0.7;

/**
 * Per-detail-level tuning. `tokensPerDescription` sets the center density of the
 * description band (lower = denser = more bullets); `tokensPerChapter` does the
 * same for chapter boundaries. `toneRule` tells the model how aggressively to
 * split vs. merge points, so the count band and the writing style stay
 * consistent. Counts still scale with transcript volume at every level — the
 * level only shifts where the band sits.
 */
interface DetailProfile {
  tokensPerDescription: number;
  tokensPerChapter: number;
  toneRule: string;
}

const DETAIL_PROFILES: Record<DetailLevel, DetailProfile> = {
  concise: {
    tokensPerDescription: 360,
    tokensPerChapter: 950,
    toneRule:
      'Keep only the most important points. Aggressively merge related facts into a single entry and omit minor asides, tangents, repetition, and small talk. Favor a compact overview over completeness.',
  },
  balanced: {
    tokensPerDescription: 210,
    tokensPerChapter: 650,
    toneRule:
      'Capture the substantive facts and specifics, but merge trivial or repetitive points and skip filler, greetings, and small talk. Do not drop concrete data (numbers, names, prices, dates, steps); do drop conversational padding.',
  },
  exhaustive: {
    tokensPerDescription: 120,
    tokensPerChapter: 480,
    toneRule:
      'Capture every distinct fact, claim, example, and step. Do not drop any concrete detail to keep the list short; prefer many precise entries over a few broad ones — the notes should let a reader skip the video entirely.',
  },
};

export interface TranscriptChunk {
  index: number;
  /** Core segments — the authoritative content for this chunk's chapters. */
  segments: TranscriptSegment[];
  /** Rendered core transcript text. */
  text: string;
  /** Token length of the core text (drives per-chunk output targets). */
  tokenLength: number;
  /** Core window start (used for display, native-chapter filtering, and validation). */
  startSeconds: number;
  /** Core window end. */
  endSeconds: number;
  /** Leading overlap text from the previous chunk, for context only ('' if none). */
  contextText: string;
}

interface ChunkSummary {
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  result: GptSummaryResponse;
}

export interface OutputTargets {
  /** Number of paragraphs the global summary should be structured into. */
  summaryParagraphs: number;
  summarySentences: string;
  chapterCount: string;
  takeawayCount: string;
  /** Target band (e.g. "18-34") for total description entries — variable, not fixed. */
  descriptionCount: string;
  /** Low end of the description band; drives the escalation-retry threshold. */
  minDescriptions: number;
  /** Detail-level tone rule steering how aggressively to split vs. merge points. */
  toneRule: string;
}

export interface ChunkTargets {
  summarySentences: string;
  chapterCount: string;
  takeawayCount: string;
  /** Target band for this chunk's total description entries — variable, not fixed. */
  descriptionCount: string;
  /** Low end of the description band; drives the escalation-retry threshold. */
  minDescriptions: number;
  /** Detail-level tone rule steering how aggressively to split vs. merge points. */
  toneRule: string;
}

/** Enforced detail floor for a structured summary request. */
interface DetailRequirement {
  minDescriptions: number;
}

type TokenCountCache = Map<string, number>;

interface SecondsBounds {
  minSeconds: number;
  maxSeconds: number;
}

// ─── Transcript Helpers ───────────────────────────────────────────────────────

function segmentLine(seg: TranscriptSegment): string {
  return `[${secondsToTimestamp(seg.startSeconds)}] ${seg.text.trim()}`;
}

function buildTranscriptText(segments: TranscriptSegment[]): string {
  return segments.map(segmentLine).join('\n');
}

function buildChunkFromText(
  index: number,
  segments: TranscriptSegment[],
  text: string,
  tokenLength: number,
  contextText: string = ''
): TranscriptChunk {
  const first = segments[0];
  const last = segments[segments.length - 1];

  return {
    index,
    segments,
    text,
    tokenLength,
    startSeconds: Math.max(0, Math.floor(first.startSeconds)),
    endSeconds: Math.max(0, Math.ceil(last.startSeconds + last.durationSeconds)),
    contextText,
  };
}

function buildTokenCacheKey(model: string, text: string): string {
  const hash = createHash('sha1').update(text).digest('hex');
  return `${model}:${hash}`;
}

const tokenizerByModel = new Map<string, Tiktoken>();

function getTokenizer(model: string): Tiktoken {
  const cached = tokenizerByModel.get(model);
  if (cached) {
    return cached;
  }

  let tokenizer: Tiktoken;
  try {
    tokenizer = encoding_for_model(model as TiktokenModel);
  } catch {
    tokenizer = get_encoding('o200k_base');
  }

  tokenizerByModel.set(model, tokenizer);
  return tokenizer;
}

function countTokens(
  model: string,
  text: string,
  tokenCache: TokenCountCache
): number {
  const cacheKey = buildTokenCacheKey(model, text);
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const tokenizer = getTokenizer(model);
  const tokenCount = tokenizer.encode(text).length;
  tokenCache.set(cacheKey, tokenCount);
  return tokenCount;
}

/**
 * Marks segment indices that are natural places to start a new chunk: the first
 * segment after a long silent gap, or the first segment at/after a native
 * YouTube chapter start. Index 0 is never a break (there is nothing before it).
 */
function computePreferredBreaks(
  segments: TranscriptSegment[],
  nativeChapters: NativeChapter[]
): boolean[] {
  const breaks = new Array<boolean>(segments.length).fill(false);

  for (let i = 1; i < segments.length; i++) {
    const prevEnd = segments[i - 1].startSeconds + segments[i - 1].durationSeconds;
    if (segments[i].startSeconds - prevEnd >= SPEECH_GAP_BREAK_SECONDS) {
      breaks[i] = true;
    }
  }

  for (const chapter of nativeChapters) {
    const idx = segments.findIndex((seg) => seg.startSeconds >= chapter.start_time - 0.5);
    if (idx > 0) {
      breaks[idx] = true;
    }
  }

  return breaks;
}

/**
 * Collects trailing segments immediately before `coreStartIndex` to serve as
 * read-only context (overlap) for the chunk starting there. Bounded by both a
 * token budget and a wall-clock window so we never pull in a large preamble.
 */
function collectLeadingContext(
  model: string,
  segments: TranscriptSegment[],
  coreStartIndex: number,
  tokenBudget: number,
  tokenCache: TokenCountCache
): TranscriptSegment[] {
  const newlineTokens = countTokens(model, '\n', tokenCache);
  const coreStartSeconds = segments[coreStartIndex].startSeconds;
  const picked: TranscriptSegment[] = [];
  let tokens = 0;

  for (let i = coreStartIndex - 1; i >= 0; i--) {
    const seg = segments[i];
    if (coreStartSeconds - seg.startSeconds > MAX_OVERLAP_SECONDS) {
      break;
    }
    const segTokens = countTokens(model, segmentLine(seg), tokenCache) + newlineTokens;
    if (picked.length > 0 && tokens + segTokens > tokenBudget) {
      break;
    }
    picked.push(seg);
    tokens += segTokens;
  }

  return picked.reverse();
}

/**
 * Splits the transcript into token-bounded chunks. Chunk boundaries are snapped
 * to natural break points (native chapters / speech pauses) once a chunk is
 * "soft-filled", and each chunk after the first carries a short leading overlap
 * from the previous section as read-only context. This avoids cutting a topic in
 * half and gives every chunk enough surrounding context to stay coherent.
 */
function splitTranscriptIntoChunks(
  model: string,
  segments: TranscriptSegment[],
  tokenCache: TokenCountCache,
  nativeChapters: NativeChapter[],
  maxChunkTokens: number = CHUNK_TOKEN_LIMIT
): TranscriptChunk[] {
  if (segments.length === 0) {
    return [];
  }

  const newlineTokens = countTokens(model, '\n', tokenCache);
  const preferredBreaks = computePreferredBreaks(segments, nativeChapters);
  const softLimit = maxChunkTokens * CHUNK_SOFT_FILL_RATIO;
  const lineTokens = segments.map((seg) => countTokens(model, segmentLine(seg), tokenCache));

  // 1. Partition segments into contiguous core groups.
  const groups: TranscriptSegment[][] = [];
  let currentGroup: TranscriptSegment[] = [];
  let currentTokens = 0;

  for (let i = 0; i < segments.length; i++) {
    // Force-close before exceeding the hard budget.
    if (currentGroup.length > 0 && currentTokens + newlineTokens + lineTokens[i] > maxChunkTokens) {
      groups.push(currentGroup);
      currentGroup = [];
      currentTokens = 0;
    }

    // Close early at a natural boundary once the chunk holds enough content.
    if (currentGroup.length > 0 && preferredBreaks[i] && currentTokens >= softLimit) {
      groups.push(currentGroup);
      currentGroup = [];
      currentTokens = 0;
    }

    currentTokens += lineTokens[i] + (currentGroup.length > 0 ? newlineTokens : 0);
    currentGroup.push(segments[i]);
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  // 2. Fold a tiny trailing group into its predecessor.
  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    const lastTokens = countTokens(model, buildTranscriptText(last), tokenCache);
    if (lastTokens < maxChunkTokens * MIN_LAST_CHUNK_RATIO) {
      const prev = groups[groups.length - 2];
      groups.splice(groups.length - 2, 2, [...prev, ...last]);
    }
  }

  // 3. Build chunks, attaching leading overlap as read-only context.
  const overlapTokenBudget = maxChunkTokens * CHUNK_OVERLAP_RATIO;
  const chunks: TranscriptChunk[] = [];
  let globalStart = 0;

  for (const group of groups) {
    const coreText = buildTranscriptText(group);
    const coreTokens = countTokens(model, coreText, tokenCache);

    let contextText = '';
    if (globalStart > 0) {
      const contextSegs = collectLeadingContext(
        model,
        segments,
        globalStart,
        overlapTokenBudget,
        tokenCache
      );
      if (contextSegs.length > 0) {
        contextText = buildTranscriptText(contextSegs);
      }
    }

    chunks.push(buildChunkFromText(chunks.length, group, coreText, coreTokens, contextText));
    globalStart += group.length;
  }

  return chunks;
}

function estimateTranscriptDurationSeconds(segments: TranscriptSegment[]): number {
  if (segments.length === 0) return 0;
  const last = segments[segments.length - 1];
  return Math.max(0, Math.round(last.startSeconds + last.durationSeconds));
}

/**
 * Derives global output targets that scale continuously with video length, so a
 * 3-hour video is asked for roughly 6x the overview/takeaway volume of a
 * 30-minute one instead of hitting a flat bucket cap. `chunkCount` cross-checks
 * duration: each ~5k-token chunk represents several minutes of real speech, so
 * a transcript with broken timestamps still scales with its actual volume.
 * Exported for tests.
 */
export function deriveOutputTargets(
  durationSeconds: number,
  chunkCount: number,
  transcriptTokens: number,
  detail: DetailLevel = 'balanced'
): OutputTargets {
  const profile = DETAIL_PROFILES[detail];
  // Duration is cross-checked against token volume so a sparse transcript
  // (music, long silences) isn't asked for more content than it holds;
  // ~120 tokens/min is a conservative speech-density lower bound.
  const minutes = Math.max(
    Math.min(durationSeconds / 60, transcriptTokens / 120),
    chunkCount * 7,
    1
  );

  // The pre-scaling fixed buckets act as a lower bound: continuous scaling may
  // only ever ask for MORE than the old version did at any duration, never less.
  const isLong = durationSeconds >= 45 * 60 || chunkCount >= 6;
  const isMid = durationSeconds >= 15 * 60 || chunkCount >= 3;
  const floors = isLong
    ? { summary: [9, 14], chapters: [8, 18], takeaways: [8, 14] }
    : isMid
      ? { summary: [6, 10], chapters: [6, 12], takeaways: [6, 10] }
      : { summary: [4, 7], chapters: [4, 8], takeaways: [4, 7] };

  // One overview paragraph per ~22 minutes; sentences track total length so the
  // Summary section itself grows with the video instead of staying one paragraph.
  const summaryParagraphs = Math.max(1, Math.min(9, Math.round(minutes / 22)));
  const summaryMin = Math.max(floors.summary[0], Math.min(70, Math.round(minutes / 2.5)));
  const summaryMax = Math.max(
    floors.summary[1],
    Math.min(90, Math.max(summaryMin + 2, Math.round(minutes / 1.6)))
  );

  // Chapter targets are only used in single-pass mode (short videos); chunked
  // mode derives chapters per chunk instead. Detail level shifts the density.
  const chapterBase = Math.max(minutes / 2.5, transcriptTokens / profile.tokensPerChapter);
  const chapterMin = Math.max(floors.chapters[0], Math.round(chapterBase * 0.8));
  const chapterMax = Math.max(
    floors.chapters[1],
    chapterMin + 2,
    Math.round(chapterBase * 1.3)
  );

  const takeawayMin = Math.max(floors.takeaways[0], Math.min(18, Math.round(minutes / 7)));
  const takeawayMax = Math.max(
    floors.takeaways[1],
    Math.min(28, Math.max(takeawayMin + 2, Math.round(minutes / 4.5)))
  );

  // Description band scales with transcript volume; detail level sets the density.
  const descBase = Math.max(8, transcriptTokens / profile.tokensPerDescription);
  const descMin = Math.max(6, Math.round(descBase * 0.7));
  const descMax = Math.max(descMin + 3, Math.round(descBase * 1.35));

  return {
    summaryParagraphs,
    summarySentences: formatRange(summaryMin, summaryMax),
    chapterCount: formatRange(chapterMin, chapterMax),
    takeawayCount: formatRange(takeawayMin, takeawayMax),
    descriptionCount: formatRange(descMin, descMax),
    minDescriptions: descMin,
    toneRule: profile.toneRule,
  };
}

function formatRange(min: number, max: number): string {
  const lo = Math.max(1, Math.round(min));
  const hi = Math.max(lo, Math.round(max));
  return lo === hi ? `${lo}` : `${lo}-${hi}`;
}

/**
 * Derives per-chunk output targets that scale with the amount of content in the
 * chunk, so denser sections produce proportionally more chapters and takeaways
 * instead of being squeezed into a fixed cap. Uses both wall-clock duration and
 * token count and takes the smaller estimate, so sparse chunks (e.g. music with
 * few words over a long span) don't get over-asked. The description band is the
 * main detail lever: it is stated in the prompt as a variable target range (not
 * a fixed count) and its low end is enforced by a detail-escalation retry, so
 * the model can't collapse every chunk to a similar size. The `detail` level
 * shifts where that band sits. Exported for tests.
 */
export function deriveChunkTargets(
  chunk: TranscriptChunk,
  detail: DetailLevel = 'balanced'
): ChunkTargets {
  const profile = DETAIL_PROFILES[detail];
  const durationMinutes = Math.max(0, (chunk.endSeconds - chunk.startSeconds) / 60);

  // ~1 chapter boundary per 2 minutes of talk, cross-checked against the detail-
  // level token density; the smaller estimate wins so sparse chunks aren't over-asked.
  const chaptersByDuration = durationMinutes / 2;
  const chaptersByTokens = chunk.tokenLength / profile.tokensPerChapter;
  const chapterBase = Math.min(chaptersByDuration, chaptersByTokens);
  const chapterMin = Math.min(10, Math.max(2, Math.floor(chapterBase * 0.8)));
  const chapterMax = Math.min(14, Math.max(chapterMin + 1, Math.ceil(chapterBase * 1.25)));

  // Description band: ~1 distinct point per profile.tokensPerDescription tokens,
  // cross-checked against a per-minute cap so a very dense chunk isn't over-asked.
  const descriptionBase = Math.min(
    chunk.tokenLength / profile.tokensPerDescription,
    durationMinutes * 4.5
  );
  const descMin = Math.max(4, Math.round(descriptionBase * 0.75));
  const descMax = Math.max(descMin + 2, Math.round(descriptionBase * 1.3));

  // Takeaways track content volume but stay a bit sparser than chapters.
  const takeawayBase = Math.min(durationMinutes / 3, chunk.tokenLength / 800);
  const takeawayMin = Math.max(2, Math.floor(takeawayBase * 0.7));
  const takeawayMax = Math.max(takeawayMin + 1, Math.ceil(takeawayBase * 1.15));

  const summaryMin = Math.max(3, Math.round(durationMinutes / 3));
  const summaryMax = Math.max(summaryMin + 1, Math.round(durationMinutes / 1.8));

  return {
    chapterCount: formatRange(chapterMin, chapterMax),
    takeawayCount: formatRange(takeawayMin, takeawayMax),
    summarySentences: formatRange(summaryMin, summaryMax),
    descriptionCount: formatRange(descMin, descMax),
    minDescriptions: descMin,
    toneRule: profile.toneRule,
  };
}

// ─── Prompt Construction ──────────────────────────────────────────────────────

function formatNativeChaptersSection(
  nativeChapters: NativeChapter[],
  startSeconds?: number,
  endSeconds?: number
): string {
  let filtered: NativeChapter[];

  if (startSeconds === undefined || endSeconds === undefined) {
    filtered = nativeChapters;
  } else {
    const sorted = [...nativeChapters].sort((a, b) => a.start_time - b.start_time);
    filtered = sorted.filter(
      (chapter) => chapter.start_time >= startSeconds && chapter.start_time <= endSeconds
    );
    // Include the chapter already in progress at the window start — it started
    // before this range but still covers its opening seconds.
    const ongoing = [...sorted].reverse().find((chapter) => chapter.start_time < startSeconds);
    if (ongoing && !filtered.some((chapter) => chapter.start_time === ongoing.start_time)) {
      filtered = [ongoing, ...filtered];
    }
  }

  if (filtered.length === 0) {
    return 'NATIVE YOUTUBE CHAPTERS: None available for this range';
  }

  return `NATIVE YOUTUBE CHAPTERS:\n${filtered
    .map((c) => `- ${secondsToTimestamp(c.start_time)} ${c.title}`)
    .join('\n')}`;
}

/**
 * Renders the full native-chapter outline of the video (unfiltered), so a chunk
 * prompt can see the overall structure it sits within, not just its own window.
 */
function formatVideoOutlineSection(nativeChapters: NativeChapter[]): string {
  if (nativeChapters.length === 0) {
    return '';
  }

  const sorted = [...nativeChapters].sort((a, b) => a.start_time - b.start_time);
  return `FULL VIDEO OUTLINE (native YouTube chapters across the whole video, for context):\n${sorted
    .map((c) => `- ${secondsToTimestamp(c.start_time)} ${c.title}`)
    .join('\n')}\n\n`;
}

const MAX_DESCRIPTION_CHARS = 800;

/**
 * Renders a bounded slice of the video description as shared context. Truncated
 * so a long description can't dominate the prompt token budget.
 */
function formatDescriptionSection(description: string): string {
  const trimmed = description.trim();
  if (trimmed === '') {
    return '';
  }

  const clipped =
    trimmed.length > MAX_DESCRIPTION_CHARS
      ? `${trimmed.slice(0, MAX_DESCRIPTION_CHARS)}…`
      : trimmed;
  return `VIDEO DESCRIPTION (context, may be promotional — do not treat as transcript):\n${clipped}\n\n`;
}

/**
 * Renders the summary sizing rules for global (single-pass / synthesis) prompts.
 * Long videos get a multi-paragraph chronological overview; the explicit
 * paragraph and sentence targets keep the Summary section proportional to the
 * video instead of collapsing to one paragraph regardless of length.
 */
function buildSummaryStructureRules(targets: OutputTargets): string {
  const structure =
    targets.summaryParagraphs <= 1
      ? '- Write the summary as one dense paragraph'
      : `- Structure the summary as ${targets.summaryParagraphs} paragraphs separated by blank lines, covering the video in chronological order`;
  return `${structure}\n- Summary length target: ${targets.summarySentences} sentences in total`;
}

function buildOutputLanguageRules(summaryLanguage?: string): string {
  if (!summaryLanguage) {
    return '- Write all text fields (summary, chapter titles, chapter descriptions, takeaways) in the same language as the transcript';
  }

  return (
    `- Write all text fields (summary, chapter titles, chapter descriptions, takeaways) in ${summaryLanguage}\n` +
    `- If the transcript is in another language, translate faithfully into ${summaryLanguage}`
  );
}

function buildSinglePassSystemPrompt(
  targets: OutputTargets,
  summaryLanguage?: string
): string {
  return `You are an expert video content analyst. Your job is to read YouTube video transcripts and produce structured, accurate notes.

You will receive a transcript with timestamps in [MM:SS] format (or [H:MM:SS] for videos an hour or longer), optional native chapter markers, and video metadata.

You MUST respond with ONLY a valid JSON object — no markdown code blocks, no explanation text, no preamble.
The JSON must conform exactly to this schema:

{
  "summary": "string — a dense chronological overview of the entire video (see summary structure rules)",
  "chapters": [
    {
      "timestamp": "string — display time like '0:00', '14:32', or '1:04:30'",
      "seconds": number — the integer seconds value matching the timestamp,
      "title": "string — descriptive chapter title (3–8 words)",
      "descriptions": [
        "string — a specific point made in this section, preserving concrete details"
      ]
    }
  ],
  "takeaways": [
    "string — one actionable or insightful bullet point"
  ]
}

Rules:
- Detect between ${targets.chapterCount} meaningful chapter boundaries based on topic shifts
- If native YouTube chapters are provided, treat them as strong hints but you may add or refine them
- timestamps must be actual times from the transcript (do not invent times); copy the [H:MM:SS] value exactly and set "seconds" to its integer equivalent
- Aim for roughly ${targets.descriptionCount} description entries in total across all chapters. Treat this as a variable target band, not a fixed quota: scale within it by how much distinct content the video holds — an information-dense video lands near the top, a thin or repetitive one near the bottom. Do not pad with duplicates or filler to reach the top, and do not compress real content to stay low.
- ${targets.toneRule}
- Each description you do include must preserve concrete specifics from the transcript: numbers, prices, measurements, names, product/model names, dates, examples, and comparisons. Do not generalize away figures or proper nouns.
- Write descriptions as plain prose. Do NOT put any timestamp, time range, or bracketed time (e.g. "[12:34]", "(1:00~1:20)") inside description text — the chapter's "timestamp"/"seconds" fields already mark the time
- If the transcript contains obvious speech-to-text errors (misheard names, wrong homophones, garbled proper nouns), silently correct them to the most likely intended term from context; do not quote or flag the garbled version
- Produce between ${targets.takeawayCount} takeaways
${buildSummaryStructureRules(targets)}
${buildOutputLanguageRules(summaryLanguage)}
- Do not include any text outside the JSON object`;
}

function buildSinglePassUserPrompt(metadata: VideoMetadata, transcriptText: string): string {
  const nativeChaptersSection = formatNativeChaptersSection(metadata.nativeChapters);
  const descriptionSection = formatDescriptionSection(metadata.description);

  return `VIDEO METADATA:
Title: ${metadata.title}
Duration: ${metadata.duration}
Published: ${metadata.publishDate}
Video ID: ${metadata.videoId}

${descriptionSection}${nativeChaptersSection}

TRANSCRIPT (format: [MM:SS] or [H:MM:SS] text):
${transcriptText}

Analyze the above transcript and produce the JSON summary.`;
}

function buildChunkSystemPrompt(
  targets: ChunkTargets,
  summaryLanguage?: string
): string {
  return `You are an expert video content analyst. You are producing structured notes on one chunk from a longer YouTube transcript. Capture the specifics that matter, at the level of detail requested below.

You MUST respond with ONLY a valid JSON object — no markdown code blocks, no explanation text, no preamble.
The JSON must conform exactly to this schema:

{
  "summary": "string — paragraph summarizing only this chunk",
  "chapters": [
    {
      "timestamp": "string — display time like '0:00', '14:32', or '1:04:30'",
      "seconds": number — the integer seconds value matching the timestamp,
      "title": "string — descriptive chapter title (3–8 words)",
      "descriptions": [
        "string — a specific point made in this section, preserving concrete details"
      ]
    }
  ],
  "takeaways": [
    "string — one actionable or insightful bullet point from this chunk"
  ]
}

Rules:
- Use only information present in this chunk
- Detect between ${targets.chapterCount} meaningful chapter boundaries inside this chunk
- Aim for roughly ${targets.descriptionCount} description entries in total across this chunk's chapters. Treat this as a variable target band, not a fixed quota: scale within it by how much distinct content this chunk actually holds — a dense section lands near the top, a thin or repetitive one near the bottom. Do not pad with duplicates or filler to reach the top, and do not compress real content to stay low.
- ${targets.toneRule}
- Each description you do include must preserve concrete specifics from the transcript: numbers, prices, measurements, names, product/model names, dates, examples, comparisons, and step-by-step details. Do not generalize away figures or proper nouns.
- Base every chapter, description, and takeaway ONLY on the TRANSCRIPT CHUNK section; never draw content from the PRECEDING CONTEXT lines (they exist only so you understand what came before)
- Write descriptions as plain prose. Do NOT put any timestamp, time range, or bracketed time (e.g. "[12:34]", "(1:00~1:20)") inside description text — the chapter's "timestamp"/"seconds" fields already mark the time
- If the transcript contains obvious speech-to-text errors (misheard names, wrong homophones, garbled proper nouns), silently correct them to the most likely intended term from context; do not quote or flag the garbled version
- Produce between ${targets.takeawayCount} takeaways
- Summary length target: ${targets.summarySentences} sentences
- timestamps must be actual times from this chunk (do not invent times); copy the [H:MM:SS] value exactly and set "seconds" to its integer equivalent
${buildOutputLanguageRules(summaryLanguage)}
- Do not include any text outside the JSON object`;
}

function buildChunkUserPrompt(
  metadata: VideoMetadata,
  chunk: TranscriptChunk,
  totalChunks: number
): string {
  const nativeChaptersSection = formatNativeChaptersSection(
    metadata.nativeChapters,
    chunk.startSeconds,
    chunk.endSeconds
  );
  const descriptionSection = formatDescriptionSection(metadata.description);
  const outlineSection = formatVideoOutlineSection(metadata.nativeChapters);

  const precedingContextSection = chunk.contextText
    ? `PRECEDING CONTEXT (from the previous section — for understanding only; do NOT create chapters, descriptions, or takeaways from these lines):
${chunk.contextText}

`
    : '';

  return `VIDEO METADATA:
Title: ${metadata.title}
Duration: ${metadata.duration}
Published: ${metadata.publishDate}
Video ID: ${metadata.videoId}

${descriptionSection}${outlineSection}CHUNK INFO:
Chunk: ${chunk.index + 1} of ${totalChunks}
Time window: ${secondsToTimestamp(chunk.startSeconds)} to ${secondsToTimestamp(chunk.endSeconds)}

${nativeChaptersSection}

${precedingContextSection}TRANSCRIPT CHUNK (format: [MM:SS] or [H:MM:SS] text) — this is the section to analyze:
${chunk.text}

Analyze ONLY the TRANSCRIPT CHUNK above (times ${secondsToTimestamp(chunk.startSeconds)} to ${secondsToTimestamp(chunk.endSeconds)}) and produce the JSON summary. All chapters and their timestamps must fall within this chunk's time window.`;
}

function buildFinalSynthesisSystemPrompt(
  targets: OutputTargets,
  summaryLanguage?: string
): string {
  return `You are an expert editor synthesizing chunk-level transcript summaries of one YouTube video into a final global summary and key takeaways.

You MUST respond with ONLY a valid JSON object — no markdown code blocks, no explanation text, no preamble.
The JSON must conform exactly to this schema:

{
  "summary": "string — a dense chronological overview of the full video (see summary structure rules)",
  "takeaways": [
    "string — one actionable or insightful bullet point for the full video"
  ]
}

Rules:
- Use only the provided chunk summaries and chunk chapters as source material
- Remove duplicates and near-duplicates
- Cover the main ideas across the full timeline of the video — every chunk's content must be represented, not just the early ones
- Write a global full-video summary, not per-chunk summaries
${buildSummaryStructureRules(targets)}
- Preserve concrete specifics (numbers, names, products, dates, examples) in both the summary and the takeaways; do not generalize them away
- Produce between ${targets.takeawayCount} takeaways
${buildOutputLanguageRules(summaryLanguage)}
- Do not include any text outside the JSON object`;
}

function buildFinalSynthesisUserPrompt(
  metadata: VideoMetadata,
  chunkSummaries: ChunkSummary[]
): string {
  const nativeChaptersSection = formatNativeChaptersSection(metadata.nativeChapters);
  const descriptionSection = formatDescriptionSection(metadata.description);
  const chunkPayload = chunkSummaries.map((chunk) => ({
    chunk: chunk.chunkIndex + 1,
    startTimestamp: secondsToTimestamp(chunk.startSeconds),
    endTimestamp: secondsToTimestamp(chunk.endSeconds),
    summary: chunk.result.summary,
    chapters: chunk.result.chapters,
    takeaways: chunk.result.takeaways,
  }));

  return `VIDEO METADATA:
Title: ${metadata.title}
Duration: ${metadata.duration}
Published: ${metadata.publishDate}
Video ID: ${metadata.videoId}

${descriptionSection}${nativeChaptersSection}

CHUNK SUMMARIES (JSON):
${JSON.stringify(chunkPayload, null, 2)}

Generate a final full-video summary and key takeaways as JSON.`;
}

async function summarizeChunksWithConcurrency(
  provider: SummaryProvider,
  model: string,
  metadata: VideoMetadata,
  chunks: TranscriptChunk[],
  detail: DetailLevel,
  summaryLanguage?: string
): Promise<ChunkSummary[]> {
  if (chunks.length === 0) {
    return [];
  }

  const concurrency = Math.min(MAX_CHUNK_SUMMARY_JOBS, chunks.length);
  const results: Array<ChunkSummary | undefined> = new Array(chunks.length);
  let nextChunkIndex = 0;
  let completedCount = 0;

  console.log(`Chunk summarization parallelism: up to ${concurrency} concurrent job(s).`);

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextChunkIndex;
      if (currentIndex >= chunks.length) {
        return;
      }
      nextChunkIndex += 1;

      const chunk = chunks[currentIndex];
      console.log(
        `Summarizing chunk ${chunk.index + 1}/${chunks.length} ` +
          `(${chunk.tokenLength} tokens, ` +
          `${secondsToTimestamp(chunk.startSeconds)}-${secondsToTimestamp(chunk.endSeconds)})...`
      );

      const chunkTargets = deriveChunkTargets(chunk, detail);
      // keepTimeMarkers: cross-chunk relocation happens in the final global
      // normalization pass, which needs the markers intact to work.
      const chunkResult = await requestStructuredSummary(
        provider,
        model,
        `chunk ${chunk.index + 1}/${chunks.length}`,
        buildChunkSystemPrompt(chunkTargets, summaryLanguage),
        buildChunkUserPrompt(metadata, chunk, chunks.length),
        { minSeconds: chunk.startSeconds, maxSeconds: chunk.endSeconds },
        true,
        { minDescriptions: chunkTargets.minDescriptions }
      );

      results[currentIndex] = {
        chunkIndex: chunk.index,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        result: chunkResult,
      };

      completedCount += 1;
      console.log(`Completed chunk ${chunk.index + 1}/${chunks.length} (${completedCount}/${chunks.length}).`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return results.map((item, idx) => {
    if (!item) {
      throw new Error(`Missing chunk summary result for chunk index ${idx}.`);
    }
    return item;
  });
}

// ─── Structured Output Schemas ─────────────────────────────────────────────────

// JSON Schemas passed to the Responses API in strict mode. Strict Structured
// Outputs guarantee the model returns valid JSON matching this shape, so runtime
// parsing only needs to guard against refusals (empty output), not malformed data.
// Note: strict mode does not support count constraints (min/maxItems); the number
// of chapters/takeaways is steered by the prompt targets instead.

const SUMMARY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'chapters', 'takeaways'],
  properties: {
    summary: { type: 'string' },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['timestamp', 'seconds', 'title', 'descriptions'],
        properties: {
          timestamp: { type: 'string' },
          seconds: { type: 'integer' },
          title: { type: 'string' },
          descriptions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    takeaways: { type: 'array', items: { type: 'string' } },
  },
};

const SYNTHESIS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'takeaways'],
  properties: {
    summary: { type: 'string' },
    takeaways: { type: 'array', items: { type: 'string' } },
  },
};

// ─── GPT Summarization ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classifies whether an error is worth retrying. Transient conditions (network
 * failures, timeouts, rate limits, 5xx, and malformed/empty model output which
 * has no HTTP status) retry; deterministic client errors (400/401/403/404) do not.
 */
function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return true;
}

/**
 * Runs `fn`, retrying transient failures with exponential backoff. Non-retryable
 * errors and the final attempt's error are rethrown unchanged so callers keep the
 * original status/message.
 */
async function withRetries<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_API_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= MAX_API_ATTEMPTS || !isRetryableError(err)) {
        throw err;
      }
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `${stage}: attempt ${attempt}/${MAX_API_ATTEMPTS} failed (${String(err)}). ` +
          `Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

function countDescriptionEntries(result: GptSummaryResponse): number {
  return result.chapters.reduce((sum, chapter) => sum + chapter.descriptions.length, 0);
}

/**
 * Escalation appended to the instructions when a response came back with far
 * fewer description entries than the transcript volume warrants. Each provider
 * call is stateless, so the previous (rejected) attempt is described inline.
 */
function buildDetailEscalation(minDescriptions: number, gotCount: number): string {
  return (
    `\n\nDETAIL ESCALATION: A previous attempt at these notes produced only ${gotCount} ` +
    `description entries in total, which is below the requested range for this much transcript. ` +
    `This time produce at least ${minDescriptions} description entries in total ` +
    `across all chapters. Work through the transcript and record each distinct ` +
    `fact, number, name, example, comparison, and step as its own description entry. ` +
    `Do not pad with duplicates or filler; split real content instead.`
  );
}

async function requestStructuredSummary(
  provider: SummaryProvider,
  model: string,
  stage: string,
  instructions: string,
  input: string,
  bounds?: SecondsBounds,
  keepTimeMarkers = false,
  detail?: DetailRequirement
): Promise<GptSummaryResponse> {
  const runAttempt = async (
    attemptStage: string,
    attemptInstructions: string
  ): Promise<GptSummaryResponse> => {
    const parsed = await withRetries(attemptStage, async () => {
      const output = await provider.generate({
        model,
        instructions: attemptInstructions,
        input,
        schemaName: 'video_summary',
        schema: SUMMARY_JSON_SCHEMA,
      });
      return parseGptResponse(output);
    });
    return normalizeSummary(parsed, bounds, keepTimeMarkers);
  };

  let result: GptSummaryResponse;
  try {
    result = await runAttempt(stage, instructions);
  } catch (err) {
    throw new Error(
      `${provider.name} request failed during ${stage} ` +
        `(after up to ${MAX_API_ATTEMPTS} attempts).\n` +
        `Check the provider login, model access, and available quota.\n` +
        `Details: ${String(err)}`
    );
  }

  // Guard the low end of the detail band: models tend to compress every request
  // to a similar output size, which is what makes long videos summarize like
  // short ones. A response that falls clearly below the requested band's floor
  // gets one escalated rewrite; keep whichever attempt carries more entries. The
  // band's ceiling is left to the prompt, so this never forces extra verbosity
  // beyond the requested floor.
  if (detail) {
    const gotCount = countDescriptionEntries(result);
    const retryFloor = Math.ceil(detail.minDescriptions * DETAIL_RETRY_THRESHOLD);
    if (gotCount < retryFloor) {
      console.warn(
        `${stage}: response has ${gotCount} description entries ` +
          `(target floor: ${detail.minDescriptions}). Requesting a more detailed pass...`
      );
      try {
        const escalated = await runAttempt(
          `${stage} (detail escalation)`,
          instructions + buildDetailEscalation(detail.minDescriptions, gotCount)
        );
        if (countDescriptionEntries(escalated) > gotCount) {
          result = escalated;
        }
      } catch (err) {
        console.warn(
          `${stage}: detail escalation failed (${String(err)}); keeping the first response.`
        );
      }
    }
  }

  return result;
}

async function requestFinalSynthesis(
  provider: SummaryProvider,
  model: string,
  stage: string,
  instructions: string,
  input: string
): Promise<Pick<GptSummaryResponse, 'summary' | 'takeaways'>> {
  try {
    return await withRetries(stage, async () => {
      const output = await provider.generate({
        model,
        instructions,
        input,
        schemaName: 'video_synthesis',
        schema: SYNTHESIS_JSON_SCHEMA,
      });
      return parseFinalSynthesisResponse(output);
    });
  } catch (err) {
    throw new Error(
      `${provider.name} request failed during ${stage} ` +
        `(after up to ${MAX_API_ATTEMPTS} attempts).\n` +
        `Check the provider login, model access, and available quota.\n` +
        `Details: ${String(err)}`
    );
  }
}

/**
 * Sends the transcript and metadata to GPT for structured summarization.
 *
 * @param provider - Structured summary provider (Codex SDK or OpenAI API)
 * @param segments - Normalized transcript segments
 * @param metadata - Video metadata including native chapters
 * @param model    - GPT model ID (resolved per provider by resolveSummaryModel)
 * @param summaryLanguage - Optional output language override
 * @param detail   - Detail density level (default 'balanced')
 */
export async function summarizeWithProvider(
  provider: SummaryProvider,
  segments: TranscriptSegment[],
  metadata: VideoMetadata,
  model: string,
  summaryLanguage?: string,
  detail: DetailLevel = 'balanced'
): Promise<GptSummaryResponse> {
  if (segments.length === 0) {
    throw new Error('Cannot summarize an empty transcript.');
  }

  const normalizedSummaryLanguage = summaryLanguage?.trim() || undefined;

  const tokenCache: TokenCountCache = new Map();
  const transcriptText = buildTranscriptText(segments);
  const transcriptTokenCount = countTokens(model, transcriptText, tokenCache);
  const durationSeconds = estimateTranscriptDurationSeconds(segments);

  console.log(
    `Preparing summarization with ${provider.name} (${model}) — ` +
      `transcript: ${transcriptTokenCount} tokens, ` +
      `${transcriptText.length} chars, ` +
      `${segments.length} segments`
  );

  if (transcriptTokenCount <= SINGLE_PASS_TOKEN_LIMIT) {
    const targets = deriveOutputTargets(durationSeconds, 1, transcriptTokenCount, detail);
    console.log(
      `Transcript fits single-pass mode (<= ${SINGLE_PASS_TOKEN_LIMIT} tokens). ` +
        `Detail: ${detail} (~${targets.descriptionCount} descriptions).`
    );
    return requestStructuredSummary(
      provider,
      model,
      'single-pass summarization',
      buildSinglePassSystemPrompt(targets, normalizedSummaryLanguage),
      buildSinglePassUserPrompt(metadata, transcriptText),
      { minSeconds: 0, maxSeconds: durationSeconds },
      false,
      { minDescriptions: targets.minDescriptions }
    );
  }

  const chunks = splitTranscriptIntoChunks(
    model,
    segments,
    tokenCache,
    metadata.nativeChapters,
    CHUNK_TOKEN_LIMIT
  );
  const targets = deriveOutputTargets(durationSeconds, chunks.length, transcriptTokenCount, detail);

  console.log(
    `Long transcript detected. Running chunked summarization in ${chunks.length} chunk(s) ` +
      `(~${CHUNK_TOKEN_LIMIT} tokens each). Detail: ${detail}.`
  );

  const chunkSummaries = await summarizeChunksWithConcurrency(
    provider,
    model,
    metadata,
    chunks,
    detail,
    normalizedSummaryLanguage
  );

  console.log(`Combining and merging chapters from ${chunkSummaries.length} chunk(s)...`);
  // Raw concatenation only; the final normalizeSummary below runs the single
  // global pass that merges duplicate boundaries, relocates leaked descriptions
  // across chunks, and strips the inline time markers.
  const combinedChapters = chunkSummaries.flatMap((chunk) => chunk.result.chapters);

  console.log('Generating final summary and takeaways from chunk summaries...');
  const finalSynthesis = await requestFinalSynthesis(
    provider,
    model,
    'chunk-final synthesis',
    buildFinalSynthesisSystemPrompt(targets, normalizedSummaryLanguage),
    buildFinalSynthesisUserPrompt(metadata, chunkSummaries)
  );

  return normalizeSummary({
    summary: finalSynthesis.summary,
    chapters: combinedChapters,
    takeaways: finalSynthesis.takeaways,
  });
}

// ─── Response Parsing ─────────────────────────────────────────────────────────

function parseGptResponse(raw: string): GptSummaryResponse {
  if (!raw || raw.trim() === '') {
    throw new Error('GPT returned an empty response. This may indicate a content policy refusal.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `GPT response was not valid JSON.\n` +
        `Raw response:\n${raw.slice(0, 500)}\n` +
        `Parse error: ${String(err)}`
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`GPT response was not a JSON object. Got: ${typeof parsed}`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['summary'] !== 'string' || obj['summary'].trim() === '') {
    throw new Error('GPT response missing or empty "summary" field.');
  }

  if (!Array.isArray(obj['chapters']) || obj['chapters'].length === 0) {
    throw new Error('GPT response missing or empty "chapters" array.');
  }

  if (!Array.isArray(obj['takeaways']) || obj['takeaways'].length === 0) {
    throw new Error('GPT response missing or empty "takeaways" array.');
  }

  const chapters: Chapter[] = (obj['chapters'] as unknown[]).map((c, i) => {
    if (typeof c !== 'object' || c === null) {
      throw new Error(`Chapter at index ${i} is not an object.`);
    }
    const ch = c as Record<string, unknown>;
    if (typeof ch['timestamp'] !== 'string') throw new Error(`Chapter ${i} missing "timestamp".`);
    if (typeof ch['seconds'] !== 'number') throw new Error(`Chapter ${i} missing "seconds".`);
    if (typeof ch['title'] !== 'string') throw new Error(`Chapter ${i} missing "title".`);
    let descriptions: string[];
    if (Array.isArray(ch['descriptions'])) {
      descriptions = (ch['descriptions'] as unknown[]).filter(
        (item): item is string => typeof item === 'string'
      );
    } else if (typeof ch['description'] === 'string') {
      descriptions = [ch['description']];
    } else {
      throw new Error(`Chapter ${i} missing "descriptions".`);
    }
    if (descriptions.length === 0) {
      throw new Error(`Chapter ${i} has empty "descriptions".`);
    }
    return {
      timestamp: ch['timestamp'] as string,
      seconds: ch['seconds'] as number,
      title: ch['title'] as string,
      descriptions,
    };
  });

  const takeaways = (obj['takeaways'] as unknown[]).filter(
    (t): t is string => typeof t === 'string'
  );

  return {
    summary: obj['summary'] as string,
    chapters,
    takeaways,
  };
}

function parseFinalSynthesisResponse(
  raw: string
): Pick<GptSummaryResponse, 'summary' | 'takeaways'> {
  if (!raw || raw.trim() === '') {
    throw new Error('GPT returned an empty response.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `GPT response was not valid JSON.\n` +
        `Raw response:\n${raw.slice(0, 500)}\n` +
        `Parse error: ${String(err)}`
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`GPT response was not a JSON object. Got: ${typeof parsed}`);
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj['summary'] !== 'string' || obj['summary'].trim() === '') {
    throw new Error('GPT response missing or empty "summary" field.');
  }
  if (!Array.isArray(obj['takeaways']) || obj['takeaways'].length === 0) {
    throw new Error('GPT response missing or empty "takeaways" array.');
  }

  const takeaways = (obj['takeaways'] as unknown[]).filter(
    (item): item is string => typeof item === 'string'
  );

  return {
    summary: (obj['summary'] as string).trim(),
    takeaways: normalizeTakeaways(takeaways),
  };
}

function normalizeTakeaways(items: string[]): string[] {
  const takeaways = Array.from(
    new Set(items.map((item) => item.trim()).filter((item) => item !== ''))
  );

  if (takeaways.length === 0) {
    throw new Error('GPT response has no valid takeaways after normalization.');
  }

  return takeaways;
}

/**
 * Parses a display timestamp ("M:SS" or "H:MM:SS") back to seconds. Returns
 * undefined for anything that isn't a well-formed 2- or 3-part time (trailing
 * parts must be two digits, 00-59), so the caller can fall back to the
 * model-provided numeric `seconds` instead of misreading e.g. a "3:2" ratio.
 * Exported for tests.
 */
export function parseTimestampToSeconds(timestamp: string): number | undefined {
  const parts = timestamp.trim().split(':');
  if (parts.length < 2 || parts.length > 3) {
    return undefined;
  }
  if (!/^\d{1,2}$/.test(parts[0]) || !parts.slice(1).every((part) => /^[0-5]\d$/.test(part))) {
    return undefined;
  }

  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + Number(part);
  }
  return seconds;
}

/**
 * Resolves a chapter's authoritative second value. The transcript shows the model
 * display timestamps, so a parsed timestamp is trusted over the model's `seconds`
 * field (which the model often miscomputes, especially past the 1-hour mark). The
 * result is clamped into the provided window so hallucinated times can't point the
 * ?t= link outside the chapter's actual section.
 */
function resolveChapterSeconds(chapter: Chapter, bounds?: SecondsBounds): number {
  const fromTimestamp = parseTimestampToSeconds(chapter.timestamp);
  const raw = fromTimestamp ?? Math.max(0, Math.round(chapter.seconds));
  if (!bounds) {
    return raw;
  }
  return Math.min(Math.max(raw, bounds.minSeconds), bounds.maxSeconds);
}

// Matches a display time token ("M:SS" or "H:MM:SS"). Seconds are constrained to
// 00-59 so ratios like "3:2" (single trailing digit) don't register as times.
const TIME_TOKEN_SOURCE = '\\d{1,2}:[0-5]\\d(?::[0-5]\\d)?';

/**
 * Extracts the first display time token in a description and returns it as
 * seconds — the model's own claim of when this point occurs. Used to relocate a
 * description that was filed under the wrong chapter. Returns undefined if the
 * text has no timestamp.
 */
function firstTimeMarkerSeconds(text: string): number | undefined {
  const match = text.match(new RegExp(`(\\d{1,2}):([0-5]\\d)(?::([0-5]\\d))?`));
  if (!match) {
    return undefined;
  }
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = match[3] !== undefined ? Number(match[3]) : undefined;
  return third !== undefined ? first * 3600 + second * 60 + third : first * 60 + second;
}

/**
 * Removes inline time markers from a description so bullets read as plain prose
 * and their formatting is consistent regardless of which chunk produced them.
 * Handles bracketed ("[12:34]"), parenthesized single/range ("(1:00~1:20)"), and
 * leading bare markers, including a trailing Korean particle ("26:58에서 …").
 * Exported for tests.
 */
export function stripTimeMarkers(text: string): string {
  const bracketed = new RegExp(`\\[\\s*${TIME_TOKEN_SOURCE}\\s*\\]`, 'g');
  const parenthesized = new RegExp(
    `\\(\\s*${TIME_TOKEN_SOURCE}(?:\\s*[~\\-–]\\s*${TIME_TOKEN_SOURCE})?\\s*\\)`,
    'g'
  );
  const leadingBare = new RegExp(
    `^\\s*${TIME_TOKEN_SOURCE}(?:\\s*[~\\-–]\\s*${TIME_TOKEN_SOURCE})?` +
      `(?:에서는|에서|에는|엔|에|께|경|쯤|부터|까지|의)?[\\s,:\\-–]*`
  );

  return text
    .replace(bracketed, ' ')
    .replace(parenthesized, ' ')
    .replace(leadingBare, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Relocates descriptions filed under the wrong chapter (overlap leakage, or a
 * point whose time belongs to a later chapter) to the chapter that actually
 * covers their time marker, then strips the markers. Preserves every description
 * — nothing is dropped for being mis-timed, only moved. Chapters must be sorted
 * by seconds ascending.
 *
 * `keepTimeMarkers` skips the stripping step. Chunk-level normalization must
 * keep markers: a description leaked from the overlap context points at a time
 * before the chunk's own window, and only the later global pass (which sees all
 * chunks' chapters) can move it to the chapter that actually covers that time.
 * Stripping here would erase the only evidence the global pass relies on.
 */
function redistributeDescriptions(chapters: Chapter[], keepTimeMarkers = false): void {
  if (chapters.length === 0) {
    return;
  }

  const starts = chapters.map((chapter) => chapter.seconds);
  const chapterIndexForTime = (time: number): number => {
    let idx = 0;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] <= time) {
        idx = i;
      } else {
        break;
      }
    }
    return idx;
  };

  const incoming: string[][] = chapters.map(() => []);

  for (let i = 0; i < chapters.length; i++) {
    const windowStart = starts[i];
    const windowEnd = i + 1 < starts.length ? starts[i + 1] : Number.POSITIVE_INFINITY;
    const kept: string[] = [];

    for (const description of chapters[i].descriptions) {
      const marker = firstTimeMarkerSeconds(description);
      const clearlyEarlier =
        marker !== undefined && marker < windowStart - DESCRIPTION_REASSIGN_TOLERANCE_SECONDS;
      const clearlyLater =
        marker !== undefined && marker >= windowEnd + DESCRIPTION_REASSIGN_TOLERANCE_SECONDS;

      if (marker !== undefined && (clearlyEarlier || clearlyLater)) {
        const target = chapterIndexForTime(marker);
        if (target !== i) {
          incoming[target].push(description);
          continue;
        }
      }
      kept.push(description);
    }

    chapters[i].descriptions = kept;
  }

  for (let i = 0; i < chapters.length; i++) {
    if (incoming[i].length > 0) {
      chapters[i].descriptions.push(...incoming[i]);
    }
    chapters[i].descriptions = Array.from(
      new Set(
        chapters[i].descriptions
          .map((text) => (keepTimeMarkers ? text.trim() : stripTimeMarkers(text)))
          .filter((text) => text !== '')
      )
    );
  }
}

/** Exported for tests. See `redistributeDescriptions` for `keepTimeMarkers`. */
export function normalizeChapters(
  chapters: Chapter[],
  bounds?: SecondsBounds,
  keepTimeMarkers = false
): Chapter[] {
  const sortedChapters = chapters
    .map((chapter) => {
      // Derive seconds from the (transcript-copied) timestamp, clamp to the window,
      // then regenerate the display timestamp so it always agrees with the ?t= URL.
      const seconds = resolveChapterSeconds(chapter, bounds);
      return {
        ...chapter,
        seconds,
        timestamp: secondsToTimestamp(seconds),
        title: chapter.title.trim(),
        descriptions: Array.from(
          new Set(
            chapter.descriptions
              .map((description) => description.trim())
              .filter((description) => description !== '')
          )
        ),
      };
    })
    .filter((chapter) => chapter.title !== '' && chapter.descriptions.length > 0)
    .sort((a, b) => a.seconds - b.seconds);

  // Merge chapters that describe the same boundary. Because adjacent chunks share
  // overlapping context, two chunks often emit the same section a few seconds apart
  // under slightly different titles; collapse those into one, unioning descriptions.
  const mergedChapters: Chapter[] = [];
  for (const chapter of sortedChapters) {
    const last = mergedChapters[mergedChapters.length - 1];
    if (last) {
      const gap = chapter.seconds - last.seconds;
      const sameBoundary =
        gap <= CHAPTER_NEAR_SECONDS ||
        (gap <= CHAPTER_MERGE_WINDOW_SECONDS && titlesSimilar(last.title, chapter.title));
      if (sameBoundary) {
        last.descriptions = Array.from(new Set([...last.descriptions, ...chapter.descriptions]));
        // Keep the more descriptive of the two titles.
        if (chapter.title.length > last.title.length) {
          last.title = chapter.title;
        }
        continue;
      }
    }
    mergedChapters.push({ ...chapter });
  }

  // Relocate mis-timed descriptions to the chapter that covers their time, then
  // strip inline markers so every bullet reads as plain, consistently-formatted prose.
  redistributeDescriptions(mergedChapters, keepTimeMarkers);

  const finalChapters = mergedChapters.filter((chapter) => chapter.descriptions.length > 0);

  if (finalChapters.length === 0) {
    throw new Error('GPT response has no valid chapters after normalization.');
  }

  return finalChapters;
}

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 0)
  );
}

/**
 * Loose title-similarity check (token Jaccard ≥ 0.5) used to decide whether two
 * near-in-time chapters are really the same boundary seen from adjacent chunks.
 */
function titlesSimilar(a: string, b: string): boolean {
  const tokensA = titleTokens(a);
  const tokensB = titleTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) {
    return false;
  }

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union >= 0.5;
}

function normalizeSummary(
  result: GptSummaryResponse,
  bounds?: SecondsBounds,
  keepTimeMarkers = false
): GptSummaryResponse {
  const summary = result.summary.trim();
  const dedupedChapters = normalizeChapters(result.chapters, bounds, keepTimeMarkers);

  const takeaways = normalizeTakeaways(result.takeaways);

  if (summary === '') {
    throw new Error('GPT response summary is empty after normalization.');
  }

  return {
    summary,
    chapters: dedupedChapters,
    takeaways,
  };
}
