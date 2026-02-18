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
 * Parsed CLI arguments.
 */
export interface CliOptions {
  url: string;
  out?: string;
}
