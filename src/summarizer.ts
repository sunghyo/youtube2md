import type OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { encoding_for_model, get_encoding, type Tiktoken, type TiktokenModel } from 'tiktoken';
import type {
  TranscriptSegment,
  VideoMetadata,
  GptSummaryResponse,
  Chapter,
  NativeChapter,
} from './types.js';
import { secondsToTimestamp } from './youtube.js';

// ─── Constants & Types ────────────────────────────────────────────────────────

// If full transcript token count is at or below this limit, summarize in one pass.
const SINGLE_PASS_TOKEN_LIMIT = 5_000;
// Target maximum tokens per chunk in chunked mode (kept below single-pass limit for prompt overhead headroom).
const CHUNK_TOKEN_LIMIT = 5_000;
// If the final chunk is smaller than this ratio of CHUNK_TOKEN_LIMIT, merge it into the previous chunk.
const MIN_LAST_CHUNK_RATIO = 0.25;

interface TranscriptChunk {
  index: number;
  segments: TranscriptSegment[];
  text: string;
  tokenLength: number;
  startSeconds: number;
  endSeconds: number;
}

interface ChunkSummary {
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  result: GptSummaryResponse;
}

interface OutputTargets {
  summarySentences: string;
  chapterCount: string;
  takeawayCount: string;
}

type TokenCountCache = Map<string, number>;

// ─── Transcript Helpers ───────────────────────────────────────────────────────

function buildTranscriptText(segments: TranscriptSegment[]): string {
  return segments
    .map((seg) => `[${secondsToTimestamp(seg.startSeconds)}] ${seg.text.trim()}`)
    .join('\n');
}

function buildChunkFromText(
  index: number,
  segments: TranscriptSegment[],
  text: string,
  tokenLength: number
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

function splitTranscriptIntoChunks(
  model: string,
  segments: TranscriptSegment[],
  tokenCache: TokenCountCache,
  maxChunkTokens: number = CHUNK_TOKEN_LIMIT
): TranscriptChunk[] {
  if (segments.length === 0) {
    return [];
  }

  const groups: TranscriptSegment[][] = [];
  let currentGroup: TranscriptSegment[] = [];
  let currentTokens = 0;
  const newlineTokens = countTokens(model, '\n', tokenCache);

  for (const seg of segments) {
    const line = `[${secondsToTimestamp(seg.startSeconds)}] ${seg.text.trim()}`;
    const lineTokens = countTokens(model, line, tokenCache) + (currentGroup.length > 0 ? newlineTokens : 0);

    if (currentGroup.length > 0 && currentTokens + lineTokens > maxChunkTokens) {
      groups.push(currentGroup);
      currentGroup = [];
      currentTokens = 0;
    }

    currentGroup.push(seg);
    currentTokens += lineTokens;
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  const chunks = groups.map((group, idx) => {
    const text = buildTranscriptText(group);
    const tokenLength = countTokens(model, text, tokenCache);
    return buildChunkFromText(idx, group, text, tokenLength);
  });

  if (chunks.length > 1) {
    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk.tokenLength < maxChunkTokens * MIN_LAST_CHUNK_RATIO) {
      const prevChunk = chunks[chunks.length - 2];
      const mergedSegments = [...prevChunk.segments, ...lastChunk.segments];
      const mergedText = `${prevChunk.text}\n${lastChunk.text}`;
      const mergedTokens = countTokens(model, mergedText, tokenCache);

      chunks.splice(
        chunks.length - 2,
        2,
        buildChunkFromText(chunks.length - 2, mergedSegments, mergedText, mergedTokens)
      );
    }
  }

  return chunks.map((chunk, idx) => ({ ...chunk, index: idx }));
}

function estimateTranscriptDurationSeconds(segments: TranscriptSegment[]): number {
  if (segments.length === 0) return 0;
  const last = segments[segments.length - 1];
  return Math.max(0, Math.round(last.startSeconds + last.durationSeconds));
}

function deriveOutputTargets(durationSeconds: number, chunkCount: number): OutputTargets {
  if (durationSeconds >= 45 * 60 || chunkCount >= 6) {
    return {
      summarySentences: '9-14',
      chapterCount: '8-18',
      takeawayCount: '8-14',
    };
  }

  if (durationSeconds >= 15 * 60 || chunkCount >= 3) {
    return {
      summarySentences: '6-10',
      chapterCount: '6-12',
      takeawayCount: '6-10',
    };
  }

  return {
    summarySentences: '4-7',
    chapterCount: '4-8',
    takeawayCount: '4-7',
  };
}

// ─── Prompt Construction ──────────────────────────────────────────────────────

function formatNativeChaptersSection(
  nativeChapters: NativeChapter[],
  startSeconds?: number,
  endSeconds?: number
): string {
  const filtered = nativeChapters.filter((chapter) => {
    if (startSeconds === undefined || endSeconds === undefined) {
      return true;
    }
    return chapter.start_time >= startSeconds && chapter.start_time <= endSeconds;
  });

  if (filtered.length === 0) {
    return 'NATIVE YOUTUBE CHAPTERS: None available for this range';
  }

  return `NATIVE YOUTUBE CHAPTERS:\n${filtered
    .map((c) => `- ${secondsToTimestamp(c.start_time)} ${c.title}`)
    .join('\n')}`;
}

function buildSinglePassSystemPrompt(targets: OutputTargets): string {
  return `You are an expert video content analyst. Your job is to read YouTube video transcripts and produce structured, accurate notes.

You will receive a transcript with timestamps in [MM:SS] format, optional native chapter markers, and video metadata.

You MUST respond with ONLY a valid JSON object — no markdown code blocks, no explanation text, no preamble.
The JSON must conform exactly to this schema:

{
  "summary": "string — one dense paragraph summarizing the entire video",
  "chapters": [
    {
      "timestamp": "string — display time like '0:00' or '14:32'",
      "seconds": number — the integer seconds value matching the timestamp,
      "title": "string — concise descriptive chapter title (3–8 words)",
      "descriptions": [
        "string — concise sentence describing one key point in this section"
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
- timestamps must be actual times from the transcript (do not invent times)
- Each chapter must include 2 to 4 entries in "descriptions"
- Produce between ${targets.takeawayCount} takeaways
- Summary length target: ${targets.summarySentences} sentences
- Write all text fields (summary, chapter titles, chapter descriptions, takeaways) in the same language as the transcript
- Do not include any text outside the JSON object`;
}

function buildSinglePassUserPrompt(metadata: VideoMetadata, transcriptText: string): string {
  const nativeChaptersSection = formatNativeChaptersSection(metadata.nativeChapters);

  return `VIDEO METADATA:
Title: ${metadata.title}
Duration: ${metadata.duration}
Published: ${metadata.publishDate}
Video ID: ${metadata.videoId}

${nativeChaptersSection}

TRANSCRIPT (format: [MM:SS] text):
${transcriptText}

Analyze the above transcript and produce the JSON summary.`;
}

function buildChunkSystemPrompt(): string {
  return `You are an expert video content analyst. You are summarizing one chunk from a longer YouTube transcript.

You MUST respond with ONLY a valid JSON object — no markdown code blocks, no explanation text, no preamble.
The JSON must conform exactly to this schema:

{
  "summary": "string — concise paragraph summarizing only this chunk",
  "chapters": [
    {
      "timestamp": "string — display time like '0:00' or '14:32'",
      "seconds": number — the integer seconds value matching the timestamp,
      "title": "string — concise descriptive chapter title (3–8 words)",
      "descriptions": [
        "string — concise sentence describing one key point in this section"
      ]
    }
  ],
  "takeaways": [
    "string — one actionable or insightful bullet point from this chunk"
  ]
}

Rules:
- Use only information present in this chunk
- Detect between 2 and 5 meaningful chapter boundaries inside this chunk
- Each chapter must include 2 to 4 entries in "descriptions"
- Produce between 2 and 5 takeaways
- Summary length target: 3-5 sentences
- timestamps must be actual times from the transcript (do not invent times)
- Write all text fields in the same language as the transcript
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

  return `VIDEO METADATA:
Title: ${metadata.title}
Duration: ${metadata.duration}
Published: ${metadata.publishDate}
Video ID: ${metadata.videoId}

CHUNK INFO:
Chunk: ${chunk.index + 1} of ${totalChunks}
Time window: ${secondsToTimestamp(chunk.startSeconds)} to ${secondsToTimestamp(chunk.endSeconds)}

${nativeChaptersSection}

TRANSCRIPT CHUNK (format: [MM:SS] text):
${chunk.text}

Analyze ONLY this chunk and produce the JSON summary.`;
}

function buildFinalSynthesisSystemPrompt(targets: OutputTargets): string {
  return `You are an expert editor synthesizing chunk-level transcript summaries of one YouTube video into a final global summary and key takeaways.

You MUST respond with ONLY a valid JSON object — no markdown code blocks, no explanation text, no preamble.
The JSON must conform exactly to this schema:

{
  "summary": "string — one dense paragraph summarizing the full video",
  "takeaways": [
    "string — one actionable or insightful bullet point for the full video"
  ]
}

Rules:
- Use only the provided chunk summaries and chunk chapters as source material
- Remove duplicates and near-duplicates
- Cover the main ideas across the full timeline of the video
- Write a global full-video summary, not per-chunk summaries
- Summary length target: ${targets.summarySentences} sentences
- Produce between ${targets.takeawayCount} takeaways
- Write summary and takeaways in the same language as the transcript
- Do not include any text outside the JSON object`;
}

function buildFinalSynthesisUserPrompt(
  metadata: VideoMetadata,
  chunkSummaries: ChunkSummary[]
): string {
  const nativeChaptersSection = formatNativeChaptersSection(metadata.nativeChapters);
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

${nativeChaptersSection}

CHUNK SUMMARIES (JSON):
${JSON.stringify(chunkPayload, null, 2)}

Generate a final full-video summary and key takeaways as JSON.`;
}

function combineChunkChapters(chunkSummaries: ChunkSummary[]): Chapter[] {
  const combinedChapters = chunkSummaries.flatMap((chunk) => chunk.result.chapters);
  return normalizeChapters(combinedChapters);
}

// ─── GPT Summarization ────────────────────────────────────────────────────────

async function requestStructuredSummary(
  openai: OpenAI,
  model: string,
  stage: string,
  instructions: string,
  input: string
): Promise<GptSummaryResponse> {
  let rawContent: string;
  try {
    const response = await openai.responses.create({
      model,
      instructions,
      input,
      text: { format: { type: 'json_object' } },
    });

    rawContent = response.output_text ?? '';
  } catch (err) {
    throw new Error(
      `GPT API call failed during ${stage}.\n` +
        `Check that OPENAI_API_KEY is valid and has sufficient quota.\n` +
        `Details: ${String(err)}`
    );
  }

  let parsed: GptSummaryResponse;
  try {
    parsed = parseGptResponse(rawContent);
  } catch (err) {
    throw new Error(`Failed to parse GPT response during ${stage}: ${String(err)}`);
  }

  return normalizeSummary(parsed);
}

async function requestFinalSynthesis(
  openai: OpenAI,
  model: string,
  stage: string,
  instructions: string,
  input: string
): Promise<Pick<GptSummaryResponse, 'summary' | 'takeaways'>> {
  let rawContent: string;
  try {
    const response = await openai.responses.create({
      model,
      instructions,
      input,
      text: { format: { type: 'json_object' } },
    });

    rawContent = response.output_text ?? '';
  } catch (err) {
    throw new Error(
      `GPT API call failed during ${stage}.\n` +
        `Check that OPENAI_API_KEY is valid and has sufficient quota.\n` +
        `Details: ${String(err)}`
    );
  }

  try {
    return parseFinalSynthesisResponse(rawContent);
  } catch (err) {
    throw new Error(`Failed to parse GPT response during ${stage}: ${String(err)}`);
  }
}

/**
 * Sends the transcript and metadata to GPT for structured summarization.
 *
 * @param openai   - Initialized OpenAI client
 * @param segments - Normalized transcript segments
 * @param metadata - Video metadata including native chapters
 * @param model    - GPT model ID (default: gpt-4o-mini)
 */
export async function summarizeWithGpt(
  openai: OpenAI,
  segments: TranscriptSegment[],
  metadata: VideoMetadata,
  model: string = 'gpt-5-mini'
): Promise<GptSummaryResponse> {
  if (segments.length === 0) {
    throw new Error('Cannot summarize an empty transcript.');
  }

  const tokenCache: TokenCountCache = new Map();
  const transcriptText = buildTranscriptText(segments);
  const transcriptTokenCount = countTokens(model, transcriptText, tokenCache);
  const durationSeconds = estimateTranscriptDurationSeconds(segments);

  console.log(
    `Preparing GPT summarization (${model}) — transcript: ${transcriptTokenCount} tokens, ` +
      `${transcriptText.length} chars, ` +
      `${segments.length} segments`
  );

  if (transcriptTokenCount <= SINGLE_PASS_TOKEN_LIMIT) {
    const targets = deriveOutputTargets(durationSeconds, 1);
    console.log(`Transcript fits single-pass mode (<= ${SINGLE_PASS_TOKEN_LIMIT} tokens).`);
    return requestStructuredSummary(
      openai,
      model,
      'single-pass summarization',
      buildSinglePassSystemPrompt(targets),
      buildSinglePassUserPrompt(metadata, transcriptText)
    );
  }

  const chunks = splitTranscriptIntoChunks(model, segments, tokenCache, CHUNK_TOKEN_LIMIT);
  const targets = deriveOutputTargets(durationSeconds, chunks.length);

  console.log(
    `Long transcript detected. Running chunked summarization in ${chunks.length} chunk(s) ` +
      `(~${CHUNK_TOKEN_LIMIT} tokens each).`
  );

  const chunkSummaries: ChunkSummary[] = [];

  for (const chunk of chunks) {
    console.log(
      `Summarizing chunk ${chunk.index + 1}/${chunks.length} ` +
        `(${chunk.tokenLength} tokens, ` +
        `${secondsToTimestamp(chunk.startSeconds)}-${secondsToTimestamp(chunk.endSeconds)})...`
    );

    const chunkResult = await requestStructuredSummary(
      openai,
      model,
      `chunk ${chunk.index + 1}/${chunks.length}`,
      buildChunkSystemPrompt(),
      buildChunkUserPrompt(metadata, chunk, chunks.length)
    );

    chunkSummaries.push({
      chunkIndex: chunk.index,
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      result: chunkResult,
    });
  }

  console.log(`Combining ${chunkSummaries.length} chunk chapters without merge stage...`);
  const combinedChapters = combineChunkChapters(chunkSummaries);

  console.log('Generating final summary and takeaways from chunk summaries...');
  const finalSynthesis = await requestFinalSynthesis(
    openai,
    model,
    'chunk-final synthesis',
    buildFinalSynthesisSystemPrompt(targets),
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

function normalizeChapters(chapters: Chapter[]): Chapter[] {
  const sortedChapters = chapters
    .map((chapter) => {
      const seconds = Math.max(0, Math.round(chapter.seconds));
      const timestamp = chapter.timestamp.trim() || secondsToTimestamp(seconds);
      return {
        ...chapter,
        seconds,
        timestamp,
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

  const dedupedChapters: Chapter[] = [];
  const seenChapterKeys = new Set<string>();
  for (const chapter of sortedChapters) {
    const key = `${chapter.seconds}:${chapter.title.toLowerCase()}`;
    if (seenChapterKeys.has(key)) continue;
    seenChapterKeys.add(key);
    dedupedChapters.push(chapter);
  }

  if (dedupedChapters.length === 0) {
    throw new Error('GPT response has no valid chapters after normalization.');
  }

  return dedupedChapters;
}

function normalizeSummary(result: GptSummaryResponse): GptSummaryResponse {
  const summary = result.summary.trim();
  const dedupedChapters = normalizeChapters(result.chapters);

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
