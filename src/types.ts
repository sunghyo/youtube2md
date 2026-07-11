/**
 * A single segment from any transcript source, normalized to seconds.
 * youtube-transcript returns offset/duration in ms; Whisper returns seconds.
 * All normalization happens at the source in youtube.ts.
 */
export interface TranscriptSegment {
  text: string;
  /** Start time in SECONDS */
  startSeconds: number;
  /** Duration in SECONDS */
  durationSeconds: number;
}

/**
 * A detected chapter with display timestamp and seconds for URL generation.
 */
export interface Chapter {
  /** Display label e.g. "2:30" */
  timestamp: string;
  /** Integer seconds for ?t= URL parameter */
  seconds: number;
  /** GPT-generated chapter title */
  title: string;
  /** GPT-generated description points for this chapter */
  descriptions: string[];
}

/**
 * Metadata fetched from ytdl-core.
 */
export interface VideoMetadata {
  videoId: string;
  title: string;
  /** Formatted as "M:SS" or "H:MM:SS" */
  duration: string;
  /** ISO date string e.g. "2024-01-15" */
  publishDate: string;
  /** Video description text (may be empty); used as cross-chunk context. */
  description: string;
  /** Native YouTube chapter markers if any */
  nativeChapters: NativeChapter[];
}

/**
 * Native YouTube chapter marker from ytdl-core.
 */
export interface NativeChapter {
  title: string;
  /** Start time in seconds */
  start_time: number;
}

/**
 * Structured JSON response from GPT. Must match the prompt schema exactly.
 */
export interface GptSummaryResponse {
  summary: string;
  chapters: Chapter[];
  takeaways: string[];
}

/**
 * All data needed to render the final Markdown file.
 */
export interface SummaryData {
  metadata: VideoMetadata;
  summary: string;
  chapters: Chapter[];
  takeaways: string[];
}

/**
 * Structured error codes for machine-readable output.
 */
export type ErrorCode =
  | 'E_TRANSCRIPT_UNAVAILABLE'
  | 'E_OPENAI_AUTH'
  | 'E_OPENAI_RATE_LIMIT'
  | 'E_WHISPER_FAILED'
  | 'E_NETWORK'
  | 'E_WRITE_FAILED';

/**
 * Thrown internally to carry a structured error code through the pipeline.
 * Caught at the top level and emitted as JSON when --json is active.
 */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * JSON output from --extract-only mode.
 */
export interface ExtractOutput {
  ok: true;
  videoId: string;
  metadata: VideoMetadata;
  segments: TranscriptSegment[];
}

/**
 * Parsed CLI arguments.
 */
export interface CliOptions {
  url: string;
  out?: string;
  outDir?: string;
  lang?: string;
  model?: string;
  /** Skip summarization; output raw transcript data only */
  extractOnly: boolean;
  /** Emit JSON to stdout instead of human-readable text */
  json: boolean;
  /** Write results to stdout instead of a file */
  stdout: boolean;
}
