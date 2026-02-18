import ytdl from '@distube/ytdl-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type OpenAI from 'openai';
import type { VideoMetadata, TranscriptSegment, NativeChapter } from './types.js';

// ─── URL Parsing ──────────────────────────────────────────────────────────────

/**
 * Extracts the YouTube video ID from any standard YouTube URL format.
 * Handles youtube.com/watch?v=, youtu.be/, and mobile m.youtube.com.
 */
export function extractVideoId(url: string): string {
  const parsed = new URL(url);

  if (parsed.hostname === 'youtu.be') {
    const id = parsed.pathname.slice(1).split('/')[0];
    if (id) return id;
  }

  if (
    parsed.hostname.endsWith('youtube.com') &&
    parsed.pathname === '/watch'
  ) {
    const id = parsed.searchParams.get('v');
    if (id) return id;
  }

  throw new Error(
    `Cannot extract video ID from URL: ${url}\n` +
      `Supported formats:\n` +
      `  https://www.youtube.com/watch?v=VIDEO_ID\n` +
      `  https://youtu.be/VIDEO_ID`
  );
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

/**
 * Fetches video title, duration, publish date, and native chapters from YouTube.
 */
export async function fetchVideoMetadata(videoId: string): Promise<VideoMetadata> {
  let info: ytdl.videoInfo;

  try {
    info = await ytdl.getBasicInfo(`https://www.youtube.com/watch?v=${videoId}`);
  } catch (err) {
    throw new Error(
      `Failed to fetch video metadata for "${videoId}".\n` +
        `The video may be private, deleted, or age-restricted.\n` +
        `Details: ${String(err)}`
    );
  }

  const details = info.videoDetails;
  const totalSeconds = parseInt(details.lengthSeconds, 10);

  // chapters is on the top-level info object, not videoDetails
  const rawChapters = (info as unknown as { chapters?: Array<{ title: string; start_time: number }> }).chapters ?? [];
  const nativeChapters: NativeChapter[] = rawChapters.map((c) => ({
    title: c.title,
    start_time: c.start_time,
  }));

  return {
    videoId,
    title: details.title,
    duration: formatSeconds(totalSeconds),
    publishDate: (details.publishDate ?? details.uploadDate ?? 'Unknown').slice(0, 10),
    nativeChapters,
  };
}

// ─── Transcript Fetching ───────────────────────────────────────────────────────

/**
 * Fetches a transcript using two strategies in order:
 * 1. Android Innertube client → caption XML (works for all languages including auto-generated)
 * 2. ytdl audio download → OpenAI Whisper STT (fallback when no captions exist)
 */
export async function fetchTranscript(
  videoId: string,
  openai: OpenAI
): Promise<TranscriptSegment[]> {
  try {
    console.log('Fetching transcript via YouTube captions (Android client)...');
    const segments = await fetchTranscriptViaInnertube(videoId);
    if (segments.length > 0) {
      return segments;
    }
    throw new Error('Caption fetch returned empty transcript.');
  } catch (captionErr) {
    console.warn(`YouTube captions unavailable: ${String(captionErr)}`);
  }

  console.warn('Falling back to Whisper STT (this may take a while)...');
  return fetchTranscriptViaWhisper(videoId, openai);
}

/**
 * Fetches captions using YouTube's Android Innertube client.
 * The Android context returns working caption URLs unlike the web page scraping approach.
 * Parses the timedtext XML format (format="3") with <p t="ms" d="ms"> elements.
 */
async function fetchTranscriptViaInnertube(videoId: string): Promise<TranscriptSegment[]> {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36';

  // Get the InnerTube API key from the video page
  const html = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { 'User-Agent': UA },
  }).then((r) => r.text());

  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (!apiKeyMatch) {
    throw new Error('Could not extract InnerTube API key from video page.');
  }
  const apiKey = apiKeyMatch[1];

  // Call the player endpoint with Android client — returns working caption URLs
  const playerRes = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '19.09.37',
          androidSdkVersion: 30,
        },
      },
      videoId,
    }),
  });

  const player = await playerRes.json() as {
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{ baseUrl: string; languageCode: string }>;
      };
    };
  };

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) {
    throw new Error('No caption tracks found.');
  }

  console.log(`Found caption tracks: ${tracks.map((t) => t.languageCode).join(', ')}`);

  const captionRes = await fetch(tracks[0].baseUrl, { headers: { 'User-Agent': UA } });
  if (!captionRes.ok) {
    throw new Error(`Caption fetch failed: HTTP ${captionRes.status}`);
  }
  const xml = await captionRes.text();

  return parseTimedTextXml(xml);
}

/**
 * Parses YouTube's timedtext XML format (format="3").
 * Each <p t="START_MS" d="DURATION_MS"> contains <s> word elements.
 * Groups consecutive <s> words into a single segment per <p>.
 */
function parseTimedTextXml(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const paragraphRegex = /<p t="(\d+)" d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  const wordRegex = /<s[^>]*>([^<]*)<\/s>/g;

  let match: RegExpExecArray | null;
  while ((match = paragraphRegex.exec(xml)) !== null) {
    const startMs = parseInt(match[1], 10);
    const durationMs = parseInt(match[2], 10);
    const inner = match[3];

    // Concatenate all <s> word segments within this paragraph
    const words: string[] = [];
    let wordMatch: RegExpExecArray | null;
    while ((wordMatch = wordRegex.exec(inner)) !== null) {
      words.push(wordMatch[1]);
    }
    const text = words.join('').trim();

    if (text.length > 0) {
      segments.push({
        text,
        startSeconds: startMs / 1000,
        durationSeconds: durationMs / 1000,
      });
    }
  }

  return segments;
}

/**
 * Downloads audio to a temp file and sends it to OpenAI Whisper for transcription.
 * Uses verbose_json to get per-segment timestamps.
 * Temp file is always cleaned up in finally block.
 */
async function fetchTranscriptViaWhisper(
  videoId: string,
  openai: OpenAI
): Promise<TranscriptSegment[]> {
  const tmpFile = path.join(os.tmpdir(), `youtube2md-${videoId}-${Date.now()}.mp4`);

  try {
    console.log('Downloading audio for Whisper transcription...');
    await downloadAudioToFile(videoId, tmpFile);

    // Check file size — Whisper rejects files larger than 25MB
    const stats = fs.statSync(tmpFile);
    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > 24) {
      throw new Error(
        `Audio file is ${sizeMB.toFixed(1)}MB, exceeding Whisper's 25MB limit.\n` +
          `Consider using a YouTube video with captions enabled.`
      );
    }

    console.log(`Transcribing with Whisper (${sizeMB.toFixed(1)}MB)...`);
    const fileStream = fs.createReadStream(tmpFile);

    const transcription = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    } as unknown as Parameters<typeof openai.audio.transcriptions.create>[0]);

    // verbose_json includes segments — TypeScript types don't reflect this
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const segments = (transcription as any).segments as Array<{
      start: number;
      end: number;
      text: string;
    }>;

    if (!segments || segments.length === 0) {
      throw new Error('Whisper returned no transcript segments.');
    }

    return segments.map((seg) => ({
      text: seg.text.trim(),
      startSeconds: seg.start,
      durationSeconds: seg.end - seg.start,
    }));
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Downloads the audio-only stream from a YouTube video to a local file.
 * Uses stream/promises pipeline for proper backpressure and error propagation.
 */
async function downloadAudioToFile(videoId: string, filePath: string): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const audioStream = ytdl(url, { filter: 'audioonly' });
  const writeStream = fs.createWriteStream(filePath);
  await pipeline(audioStream, writeStream);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Converts total seconds to a display string: 90 → "1:30", 3661 → "1:01:01"
 */
export function formatSeconds(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Converts seconds to a chapter timestamp string: 150 → "2:30"
 */
export function secondsToTimestamp(seconds: number): string {
  return formatSeconds(Math.floor(seconds));
}
