import ytdl from '@distube/ytdl-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type OpenAI from 'openai';
import { YoutubeTranscript } from 'youtube-transcript';
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

const YOUTUBE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36';

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

/**
 * Fetches a transcript using three strategies in order:
 * 1. Android Innertube client captions (supports JSON3 + XML timedtext formats)
 * 2. youtube-transcript library fallback
 * 3. ytdl audio download → OpenAI Whisper STT (fallback when captions are unavailable)
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

  try {
    console.log('Retrying transcript via youtube-transcript fallback...');
    const segments = await fetchTranscriptViaYoutubeTranscript(videoId);
    if (segments.length > 0) {
      return segments;
    }
    throw new Error('youtube-transcript fallback returned an empty transcript.');
  } catch (fallbackErr) {
    console.warn(`youtube-transcript fallback unavailable: ${String(fallbackErr)}`);
  }

  console.warn('Falling back to Whisper STT (this may take a while)...');
  return fetchTranscriptViaWhisper(videoId, openai);
}

/**
 * Fetches captions using YouTube's Android Innertube client.
 * The Android context returns working caption URLs unlike the web page scraping approach.
 * Supports multiple timedtext payloads (json3, srv3 XML with <p>, and XML with <text>).
 */
async function fetchTranscriptViaInnertube(videoId: string): Promise<TranscriptSegment[]> {
  // Get the InnerTube API key from the video page
  const html = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { 'User-Agent': YOUTUBE_UA },
  }).then((r) => r.text());

  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (!apiKeyMatch) {
    throw new Error('Could not extract InnerTube API key from video page.');
  }
  const apiKey = apiKeyMatch[1];

  // Call the player endpoint with Android client — returns working caption URLs
  const playerRes = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': YOUTUBE_UA },
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

  if (!playerRes.ok) {
    throw new Error(`InnerTube player request failed: HTTP ${playerRes.status}`);
  }

  const player = await playerRes.json() as {
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: CaptionTrack[];
      };
    };
  };

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) {
    throw new Error('No caption tracks found.');
  }

  console.log(`Found caption tracks: ${tracks.map((t) => t.languageCode).join(', ')}`);
  const sortedTracks = [...tracks].sort((a, b) => captionTrackRank(a) - captionTrackRank(b));

  const failures: string[] = [];
  for (const track of sortedTracks) {
    try {
      const segments = await fetchCaptionTrack(track);
      if (segments.length > 0) {
        return segments;
      }
      failures.push(`${track.languageCode}: empty transcript`);
    } catch (err) {
      failures.push(`${track.languageCode}: ${String(err)}`);
    }
  }

  throw new Error(
    `All caption tracks failed to parse.\n` +
      failures.map((entry) => `  - ${entry}`).join('\n')
  );
}

/**
 * Fallback caption fetcher using the youtube-transcript package.
 */
async function fetchTranscriptViaYoutubeTranscript(videoId: string): Promise<TranscriptSegment[]> {
  const transcript = await YoutubeTranscript.fetchTranscript(videoId);
  const segments = transcript
    .map((seg) => ({
      text: normalizeTranscriptText(decodeHtmlEntities(seg.text)),
      startSeconds: Math.max(0, seg.offset),
      durationSeconds: Math.max(0, seg.duration),
    }))
    .filter((seg) => seg.text !== '');

  if (segments.length === 0) {
    throw new Error('No transcript segments returned by youtube-transcript.');
  }

  return segments;
}

async function fetchCaptionTrack(track: CaptionTrack): Promise<TranscriptSegment[]> {
  const attempts: Array<{ url: string; parse: (body: string) => TranscriptSegment[] }> = [];
  const json3Url = new URL(track.baseUrl);
  json3Url.searchParams.set('fmt', 'json3');
  attempts.push({ url: json3Url.toString(), parse: parseCaptionJson3 });
  attempts.push({ url: track.baseUrl, parse: parseTimedTextXml });
  const srv3Url = new URL(track.baseUrl);
  srv3Url.searchParams.set('fmt', 'srv3');
  attempts.push({ url: srv3Url.toString(), parse: parseTimedTextXml });

  const seenUrls = new Set<string>();
  for (const attempt of attempts) {
    if (seenUrls.has(attempt.url)) {
      continue;
    }
    seenUrls.add(attempt.url);

    const captionRes = await fetch(attempt.url, { headers: { 'User-Agent': YOUTUBE_UA } });
    if (!captionRes.ok) {
      continue;
    }
    const body = await captionRes.text();
    const segments = attempt.parse(body);
    if (segments.length > 0) {
      return segments;
    }
  }

  throw new Error('No parsable transcript segments found.');
}

function captionTrackRank(track: CaptionTrack): number {
  // Prefer manually-authored captions over auto-generated tracks.
  return track.kind === 'asr' ? 1 : 0;
}

/**
 * Parses YouTube json3 timedtext payloads.
 */
function parseCaptionJson3(payload: string): TranscriptSegment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }

  const events = (parsed as { events?: unknown }).events;
  if (!Array.isArray(events)) {
    return [];
  }

  const segments: TranscriptSegment[] = [];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) {
      continue;
    }

    const entry = event as {
      tStartMs?: unknown;
      dDurationMs?: unknown;
      segs?: unknown;
    };
    const startMs = typeof entry.tStartMs === 'number' ? entry.tStartMs : undefined;
    const durationMs = typeof entry.dDurationMs === 'number' ? entry.dDurationMs : 0;
    if (startMs === undefined || !Array.isArray(entry.segs)) {
      continue;
    }

    const rawText = entry.segs
      .map((seg) => {
        if (typeof seg !== 'object' || seg === null) {
          return '';
        }
        const utf8 = (seg as { utf8?: unknown }).utf8;
        return typeof utf8 === 'string' ? utf8 : '';
      })
      .join('');

    const text = normalizeTranscriptText(decodeHtmlEntities(rawText));
    if (text === '') {
      continue;
    }

    segments.push({
      text,
      startSeconds: Math.max(0, startMs / 1000),
      durationSeconds: Math.max(0, durationMs / 1000),
    });
  }

  return segments;
}

/**
 * Parses YouTube timedtext XML formats:
 * - srv3 style: <p t="ms" d="ms">...</p>
 * - legacy style: <text start="seconds" dur="seconds">...</text>
 */
function parseTimedTextXml(xml: string): TranscriptSegment[] {
  const paragraphSegments = parseTimedTextElements(xml, {
    tag: 'p',
    startAttr: 't',
    durationAttr: 'd',
    unitScale: 1000,
  });
  if (paragraphSegments.length > 0) {
    return paragraphSegments;
  }

  return parseTimedTextElements(xml, {
    tag: 'text',
    startAttr: 'start',
    durationAttr: 'dur',
    unitScale: 1,
  });
}

function parseTimedTextElements(
  xml: string,
  config: {
    tag: 'p' | 'text';
    startAttr: string;
    durationAttr: string;
    unitScale: number;
  }
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const elementRegex = new RegExp(`<${config.tag}\\b([^>]*)>([\\s\\S]*?)<\\/${config.tag}>`, 'g');

  let match: RegExpExecArray | null;
  while ((match = elementRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const inner = match[2];
    const startRaw = getXmlAttribute(attrs, config.startAttr);
    const durationRaw = getXmlAttribute(attrs, config.durationAttr);
    if (!startRaw || !durationRaw) {
      continue;
    }

    const start = Number(startRaw);
    const duration = Number(durationRaw);
    if (!Number.isFinite(start) || !Number.isFinite(duration)) {
      continue;
    }

    const text = extractXmlCaptionText(inner);

    if (text.length > 0) {
      segments.push({
        text,
        startSeconds: Math.max(0, start / config.unitScale),
        durationSeconds: Math.max(0, duration / config.unitScale),
      });
    }
  }

  return segments;
}

function getXmlAttribute(attrs: string, attrName: string): string | undefined {
  const escapedName = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = attrs.match(new RegExp(`${escapedName}="([^"]+)"`));
  return match?.[1];
}

function extractXmlCaptionText(inner: string): string {
  const wordRegex = /<s[^>]*>([\s\S]*?)<\/s>/g;
  const words: string[] = [];
  let wordMatch: RegExpExecArray | null;
  while ((wordMatch = wordRegex.exec(inner)) !== null) {
    words.push(wordMatch[1]);
  }

  const rawText = words.length > 0 ? words.join('') : inner;
  const withoutTags = rawText.replace(/<[^>]+>/g, '');
  return normalizeTranscriptText(decodeHtmlEntities(withoutTags));
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      if (Number.isFinite(codePoint)) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return full;
        }
      }
      return full;
    }

    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(codePoint)) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return full;
        }
      }
      return full;
    }

    switch (entity.toLowerCase()) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
      case '#39':
        return '\'';
      case 'nbsp':
        return ' ';
      default:
        return full;
    }
  });
}

function normalizeTranscriptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
