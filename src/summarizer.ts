import type OpenAI from 'openai';
import type {
  TranscriptSegment,
  VideoMetadata,
  GptSummaryResponse,
  Chapter,
} from './types.js';
import { secondsToTimestamp } from './youtube.js';

// ─── Prompt Construction ──────────────────────────────────────────────────────

function buildTranscriptText(segments: TranscriptSegment[]): string {
  return segments
    .map((seg) => `[${secondsToTimestamp(seg.startSeconds)}] ${seg.text.trim()}`)
    .join('\n');
}

function buildSystemPrompt(): string {
  return `You are an expert video content analyst. Your job is to read YouTube video transcripts and produce structured, accurate notes.

You will receive a transcript with timestamps in [MM:SS] format, optional native chapter markers, and video metadata.

You MUST respond with ONLY a valid JSON object — no markdown code blocks, no explanation text, no preamble.
The JSON must conform exactly to this schema:

{
  "summary": "string — one dense paragraph (4–6 sentences) summarizing the entire video",
  "chapters": [
    {
      "timestamp": "string — display time like '0:00' or '14:32'",
      "seconds": number — the integer seconds value matching the timestamp,
      "title": "string — concise descriptive chapter title (3–8 words)",
      "description": "string — one sentence describing this section's content"
    }
  ],
  "takeaways": [
    "string — one actionable or insightful bullet point"
  ]
}

Rules:
- Detect between 3 and 10 meaningful chapter boundaries based on topic shifts
- If native YouTube chapters are provided, treat them as strong hints but you may add or refine them
- timestamps must be actual times from the transcript (do not invent times)
- Produce between 3 and 7 takeaways
- Write all text fields (summary, chapter titles, descriptions, takeaways) in the same language as the transcript
- Do not include any text outside the JSON object`;
}

function buildUserPrompt(metadata: VideoMetadata, transcriptText: string): string {
  const nativeChaptersSection =
    metadata.nativeChapters.length > 0
      ? `NATIVE YOUTUBE CHAPTERS (use as hints):\n${metadata.nativeChapters
          .map((c) => `- ${secondsToTimestamp(c.start_time)} ${c.title}`)
          .join('\n')}`
      : 'NATIVE YOUTUBE CHAPTERS: None (detect chapters from transcript content)';

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

// ─── GPT Summarization ────────────────────────────────────────────────────────

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
  const transcriptText = buildTranscriptText(segments);

  // Truncate to stay within token limits (50k chars ≈ 37.5k tokens)
  const MAX_CHARS = 50_000;
  const truncated =
    transcriptText.length > MAX_CHARS
      ? transcriptText.slice(0, MAX_CHARS) + '\n[Transcript truncated due to length]'
      : transcriptText;

  console.log(
    `Sending to GPT (${model}) — transcript: ${transcriptText.length} chars` +
      (transcriptText.length > MAX_CHARS ? ` (truncated to ${MAX_CHARS})` : '') +
      '...'
  );

  let rawContent: string;
  try {
    const response = await openai.responses.create({
      model,
      instructions: buildSystemPrompt(),
      input: buildUserPrompt(metadata, truncated),
      text: { format: { type: 'json_object' } },
    });

    rawContent = response.output_text ?? '';
  } catch (err) {
    throw new Error(
      `GPT API call failed.\n` +
        `Check that OPENAI_API_KEY is valid and has sufficient quota.\n` +
        `Details: ${String(err)}`
    );
  }

  return parseGptResponse(rawContent);
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
    if (typeof ch['description'] !== 'string') throw new Error(`Chapter ${i} missing "description".`);
    return {
      timestamp: ch['timestamp'] as string,
      seconds: ch['seconds'] as number,
      title: ch['title'] as string,
      description: ch['description'] as string,
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
