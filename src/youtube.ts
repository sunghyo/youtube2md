import ytdl from '@distube/ytdl-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type OpenAI from 'openai';
import { YoutubeTranscript } from 'youtube-transcript';
import { AppError } from './types.js';
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
    info = await ytdl.getBasicInfo(buildVideoUrl(videoId), getYtdlRequestOptions());
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

interface InnertubePlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
}

interface BrowserCookie {
  domain?: string;
  expirationDate?: number;
  hostOnly?: boolean;
  httpOnly?: boolean;
  name: string;
  path?: string;
  sameSite?: string;
  secure?: boolean;
  session?: boolean;
  value: string;
}

interface YouTubeAuthContext {
  agent: ytdl.Agent;
  cookieHeader: string;
  sourceLabel: string;
}

type YtdlPlayerClient = 'WEB_EMBEDDED' | 'TV' | 'IOS' | 'ANDROID' | 'WEB';

const AUDIO_DOWNLOAD_CLIENT_SETS: ReadonlyArray<ReadonlyArray<YtdlPlayerClient>> = [
  ['WEB_EMBEDDED', 'IOS', 'ANDROID', 'TV'],
  ['TV'],
  ['IOS'],
  ['ANDROID'],
  ['WEB'],
];

const MAX_WHISPER_FILE_BYTES = 24 * 1024 * 1024;
const ANDROID_CLIENT_VERSION = '20.10.38';
const ANDROID_OS_VERSION = '14';

let cachedYouTubeAuthContext: YouTubeAuthContext | null | undefined;
let loggedYouTubeAuthContext = false;

/**
 * Fetches a transcript using three strategies in order:
 * 1. YouTube caption tracks from the watch page / ytdl basic info
 * 2. youtube-transcript library fallback
 * 3. ytdl audio download → OpenAI Whisper STT (requires openai client; skipped when null)
 *
 * Pass `openai: null` in --extract-only mode when no API key is available.
 * Whisper fallback is skipped and E_TRANSCRIPT_UNAVAILABLE is thrown instead.
 */
export async function fetchTranscript(
  videoId: string,
  openai: OpenAI | null
): Promise<TranscriptSegment[]> {
  const failures: string[] = [];

  try {
    console.log('Fetching transcript via YouTube captions...');
    const segments = await fetchTranscriptViaYouTubeCaptions(videoId);
    if (segments.length > 0) {
      return segments;
    }
    throw new Error('Caption fetch returned empty transcript.');
  } catch (captionErr) {
    failures.push(`YouTube captions: ${String(captionErr)}`);
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
    failures.push(`youtube-transcript: ${String(fallbackErr)}`);
    console.warn(`youtube-transcript fallback unavailable: ${String(fallbackErr)}`);
  }

  if (!openai) {
    throw new AppError(
      'E_TRANSCRIPT_UNAVAILABLE',
      'No captions found for this video.\n' +
        `${formatTranscriptFailures(failures)}\n` +
        'If the video needs a signed-in YouTube session, set YOUTUBE_COOKIES_PATH or YOUTUBE_COOKIE_HEADER.\n' +
        'Whisper STT fallback requires OPENAI_API_KEY.\n' +
        'Set OPENAI_API_KEY or use a video with captions enabled.'
    );
  }

  console.warn('Falling back to Whisper STT (this may take a while)...');
  try {
    return await fetchTranscriptViaWhisper(videoId, openai);
  } catch (whisperErr) {
    failures.push(`Whisper STT: ${String(whisperErr)}`);
    throw new AppError(
      'E_TRANSCRIPT_UNAVAILABLE',
      'Could not fetch transcript through any method.\n' +
        `${formatTranscriptFailures(failures)}\n` +
        'Possible causes:\n' +
        '  - The video captions are client-restricted or temporarily unavailable\n' +
        '  - Audio download could not find a playable format without valid YouTube cookies or a proxy\n' +
        '  - OPENAI_API_KEY lacks audio transcription access'
    );
  }
}

/**
 * Fetches captions using a modern Android InnerTube player payload first, then
 * the watch-page / ytdl response as a fallback. Supports JSON3 + XML timedtext formats.
 */
async function fetchTranscriptViaYouTubeCaptions(videoId: string): Promise<TranscriptSegment[]> {
  const tracks = await fetchCaptionTracks(videoId);
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

async function fetchCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  const failures: string[] = [];

  try {
    const tracks = await fetchCaptionTracksViaInnertube(videoId);
    if (tracks.length > 0) {
      return tracks;
    }
    failures.push('InnerTube: no caption tracks found');
  } catch (err) {
    failures.push(`InnerTube: ${String(err)}`);
  }

  try {
    const tracks = await fetchCaptionTracksViaYtdl(videoId);
    if (tracks.length > 0) {
      return tracks;
    }
    failures.push('watch page: no caption tracks found');
  } catch (err) {
    failures.push(`watch page: ${String(err)}`);
  }

  throw new Error(
    'No caption tracks found.\n' +
      failures.map((entry) => `  - ${entry}`).join('\n')
  );
}

async function fetchCaptionTracksViaYtdl(videoId: string): Promise<CaptionTrack[]> {
  const info = await ytdl.getBasicInfo(buildVideoUrl(videoId), getYtdlRequestOptions());
  const tracks = info.player_response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return tracks.map((track) => ({
    baseUrl: track.baseUrl,
    languageCode: track.languageCode,
    kind: track.kind,
  }));
}

async function fetchCaptionTracksViaInnertube(videoId: string): Promise<CaptionTrack[]> {
  const player = await fetchAndroidInnertubePlayer(videoId);
  return player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

async function fetchAndroidInnertubePlayer(videoId: string): Promise<InnertubePlayerResponse> {
  const playerRes = await youtubeFetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `com.google.android.youtube/${ANDROID_CLIENT_VERSION} (Linux; U; Android ${ANDROID_OS_VERSION})`,
    },
    body: JSON.stringify({
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: ANDROID_CLIENT_VERSION,
        },
      },
    }),
  });

  if (!playerRes.ok) {
    throw new Error(`InnerTube player request failed: HTTP ${playerRes.status}`);
  }

  return await playerRes.json() as InnertubePlayerResponse;
}

/**
 * Fallback caption fetcher using the youtube-transcript package.
 */
async function fetchTranscriptViaYoutubeTranscript(videoId: string): Promise<TranscriptSegment[]> {
  const transcript = await YoutubeTranscript.fetchTranscript(buildVideoUrl(videoId));
  const transcriptUsesMilliseconds = shouldTreatYoutubeTranscriptTimesAsMilliseconds(transcript);
  const segments = transcript
    .map((seg) => ({
      text: normalizeTranscriptText(decodeHtmlEntities(seg.text)),
      startSeconds: normalizeYoutubeTranscriptTime(seg.offset, transcriptUsesMilliseconds),
      durationSeconds: normalizeYoutubeTranscriptTime(seg.duration, transcriptUsesMilliseconds),
    }))
    .filter((seg) => seg.text !== '');

  if (segments.length === 0) {
    throw new Error('No transcript segments returned by youtube-transcript.');
  }

  return segments;
}

function shouldTreatYoutubeTranscriptTimesAsMilliseconds(
  transcript: Array<{ duration: number }>
): boolean {
  return transcript.some((seg) => Number.isFinite(seg.duration) && seg.duration > 100);
}

function normalizeYoutubeTranscriptTime(value: number, fromMilliseconds: boolean): number {
  const normalized = fromMilliseconds ? value / 1000 : value;
  return Math.max(0, normalized);
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

    const captionRes = await youtubeFetch(attempt.url, { headers: { 'User-Agent': YOUTUBE_UA } });
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
  let tmpFile: string | null = null;

  try {
    const resolvedAudio = await resolveAudioDownload(videoId);
    tmpFile = path.join(
      os.tmpdir(),
      `youtube2md-${videoId}-${Date.now()}.${resolveTempAudioExtension(resolvedAudio.format)}`
    );

    console.log(
      `Downloading audio for Whisper transcription using ${describeAudioFormat(
        resolvedAudio.format
      )}...`
    );
    await downloadAudioToFile(resolvedAudio.info, resolvedAudio.format, tmpFile);

    // Check file size — Whisper rejects files larger than 25MB
    const stats = fs.statSync(tmpFile);
    const sizeMB = stats.size / (1024 * 1024);
    if (stats.size > MAX_WHISPER_FILE_BYTES) {
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
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Downloads a specific audio-capable format to a local file.
 * Uses stream/promises pipeline for proper backpressure and error propagation.
 */
async function downloadAudioToFile(
  info: ytdl.videoInfo,
  format: ytdl.videoFormat,
  filePath: string
): Promise<void> {
  const audioStream = ytdl.downloadFromInfo(info, { format });
  const writeStream = fs.createWriteStream(filePath);
  await pipeline(audioStream, writeStream);
}

async function resolveAudioDownload(
  videoId: string
): Promise<{ info: ytdl.videoInfo; format: ytdl.videoFormat }> {
  const failures: string[] = [];
  const url = buildVideoUrl(videoId);

  for (const clientSet of AUDIO_DOWNLOAD_CLIENT_SETS) {
    try {
      const info = await ytdl.getInfo(
        url,
        getYtdlRequestOptions({ playerClients: [...clientSet] })
      );
      const format = selectWhisperAudioFormat(info.formats);
      if (!format) {
        throw new Error('No audio-capable formats returned.');
      }
      return { info, format };
    } catch (err) {
      failures.push(`${clientSet.join('+')}: ${String(err)}`);
    }
  }

  throw new Error(
    'Unable to resolve a playable audio format.\n' +
      failures.map((entry) => `  - ${entry}`).join('\n')
  );
}

function selectWhisperAudioFormat(formats: ytdl.videoFormat[]): ytdl.videoFormat | null {
  const audioFormats = formats.filter((format) => format.hasAudio && format.url);
  if (audioFormats.length === 0) {
    return null;
  }

  const supportedFormats = audioFormats.filter(isWhisperUploadSafeFormat);
  return (
    selectPreferredAudioFormat(supportedFormats) ??
    selectPreferredAudioFormat(audioFormats) ??
    null
  );
}

function selectPreferredAudioFormat(formats: ytdl.videoFormat[]): ytdl.videoFormat | null {
  if (formats.length === 0) {
    return null;
  }

  const audioOnlyFormats = formats.filter((format) => !format.hasVideo);

  return (
    pickHighestQualityWithinLimit(audioOnlyFormats) ??
    pickHighestQualityWithinLimit(formats) ??
    pickSmallestFormat(audioOnlyFormats) ??
    pickSmallestFormat(formats) ??
    null
  );
}

function pickHighestQualityWithinLimit(formats: ytdl.videoFormat[]): ytdl.videoFormat | null {
  const withinLimit = formats.filter((format) => {
    const sizeBytes = estimateFormatSizeBytes(format);
    return sizeBytes !== undefined && sizeBytes <= MAX_WHISPER_FILE_BYTES;
  });
  return [...withinLimit].sort(compareHigherQualityAudioFormat)[0] ?? null;
}

function pickSmallestFormat(formats: ytdl.videoFormat[]): ytdl.videoFormat | null {
  return [...formats].sort(compareSmallestAudioFormat)[0] ?? null;
}

function compareHigherQualityAudioFormat(a: ytdl.videoFormat, b: ytdl.videoFormat): number {
  const audioOnlyDiff = Number(a.hasVideo) - Number(b.hasVideo);
  if (audioOnlyDiff !== 0) {
    return audioOnlyDiff;
  }

  const audioBitrateDiff = (b.audioBitrate ?? 0) - (a.audioBitrate ?? 0);
  if (audioBitrateDiff !== 0) {
    return audioBitrateDiff;
  }

  return compareEstimatedSize(a, b);
}

function compareSmallestAudioFormat(a: ytdl.videoFormat, b: ytdl.videoFormat): number {
  const audioOnlyDiff = Number(a.hasVideo) - Number(b.hasVideo);
  if (audioOnlyDiff !== 0) {
    return audioOnlyDiff;
  }

  const sizeDiff = compareEstimatedSize(a, b);
  if (sizeDiff !== 0) {
    return sizeDiff;
  }

  return (b.audioBitrate ?? 0) - (a.audioBitrate ?? 0);
}

function compareEstimatedSize(a: ytdl.videoFormat, b: ytdl.videoFormat): number {
  const aSize = estimateFormatSizeBytes(a) ?? Number.MAX_SAFE_INTEGER;
  const bSize = estimateFormatSizeBytes(b) ?? Number.MAX_SAFE_INTEGER;
  return aSize - bSize;
}

function estimateFormatSizeBytes(format: ytdl.videoFormat): number | undefined {
  const contentLength = Number.parseInt(format.contentLength, 10);
  if (Number.isFinite(contentLength) && contentLength > 0) {
    return contentLength;
  }

  const durationMs = Number.parseInt(format.approxDurationMs ?? '', 10);
  const audioBitrate = format.audioBitrate;
  if (
    Number.isFinite(durationMs) &&
    durationMs > 0 &&
    typeof audioBitrate === 'number' &&
    audioBitrate > 0
  ) {
    return Math.round((audioBitrate * 1000 / 8) * (durationMs / 1000));
  }

  return undefined;
}

function isWhisperUploadSafeFormat(format: ytdl.videoFormat): boolean {
  return format.container === 'mp4' || format.container === 'webm';
}

function resolveTempAudioExtension(format: ytdl.videoFormat): string {
  if (format.container === 'mp4' && !format.hasVideo) {
    return 'm4a';
  }
  return format.container;
}

function describeAudioFormat(format: ytdl.videoFormat): string {
  const parts: string[] = [format.container];
  if (typeof format.audioBitrate === 'number') {
    parts.push(`${format.audioBitrate}kbps`);
  }
  if (format.audioCodec) {
    parts.push(format.audioCodec);
  }
  if (format.hasVideo) {
    parts.push('muxed');
  }
  return parts.join(' ');
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function buildVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function getYtdlRequestOptions(overrides: ytdl.getInfoOptions = {}): ytdl.getInfoOptions {
  const auth = getYouTubeAuthContext();
  if (!auth) {
    return overrides;
  }

  logYouTubeAuthContext(auth);
  return {
    ...overrides,
    agent: auth.agent,
  };
}

async function youtubeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const auth = getYouTubeAuthContext();
  const headers = new Headers(init.headers);

  if (auth && !headers.has('Cookie')) {
    headers.set('Cookie', auth.cookieHeader);
    logYouTubeAuthContext(auth);
  }

  return fetch(url, {
    ...init,
    headers,
  });
}

function formatTranscriptFailures(failures: string[]): string {
  return failures.map((failure) => `  - ${failure}`).join('\n');
}

function getYouTubeAuthContext(): YouTubeAuthContext | null {
  if (cachedYouTubeAuthContext !== undefined) {
    return cachedYouTubeAuthContext;
  }

  const cookieFilePath = process.env['YOUTUBE_COOKIES_PATH']?.trim();
  if (cookieFilePath) {
    cachedYouTubeAuthContext = createYouTubeAuthContext(
      loadCookiesFromFile(cookieFilePath),
      'YOUTUBE_COOKIES_PATH'
    );
    return cachedYouTubeAuthContext;
  }

  const cookieHeader = process.env['YOUTUBE_COOKIE_HEADER']?.trim();
  if (cookieHeader) {
    cachedYouTubeAuthContext = createYouTubeAuthContext(
      parseCookieHeader(cookieHeader),
      'YOUTUBE_COOKIE_HEADER'
    );
    return cachedYouTubeAuthContext;
  }

  cachedYouTubeAuthContext = null;
  return cachedYouTubeAuthContext;
}

function createYouTubeAuthContext(
  cookies: BrowserCookie[],
  sourceLabel: string
): YouTubeAuthContext {
  if (cookies.length === 0) {
    throw new Error(`No YouTube cookies were loaded from ${sourceLabel}.`);
  }

  const agent = ytdl.createAgent(cookies);
  const cookieHeader = agent.jar.getCookieStringSync('https://www.youtube.com');

  if (!cookieHeader) {
    throw new Error(`Loaded ${sourceLabel}, but no cookies matched https://www.youtube.com.`);
  }

  return {
    agent,
    cookieHeader,
    sourceLabel,
  };
}

function loadCookiesFromFile(cookieFilePath: string): BrowserCookie[] {
  const resolvedPath = path.resolve(cookieFilePath);
  let raw: string;

  try {
    raw = fs.readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    throw new Error(`Could not read YOUTUBE_COOKIES_PATH at "${resolvedPath}": ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `YOUTUBE_COOKIES_PATH must be a JSON cookie export (for example from EditThisCookie).\n` +
        `File: ${resolvedPath}\n` +
        `Details: ${String(err)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `YOUTUBE_COOKIES_PATH must contain a JSON array of cookie objects.\n` +
        `File: ${resolvedPath}`
    );
  }

  const cookies = parsed.filter(isBrowserCookie);
  if (cookies.length === 0) {
    throw new Error(
      `YOUTUBE_COOKIES_PATH did not contain any usable cookie objects with name/value fields.\n` +
        `File: ${resolvedPath}`
    );
  }

  return cookies;
}

function parseCookieHeader(cookieHeader: string): BrowserCookie[] {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex <= 0) {
        throw new Error(
          `YOUTUBE_COOKIE_HEADER must be a standard Cookie header string.\n` +
            `Invalid segment: ${part}`
        );
      }

      return {
        domain: '.youtube.com',
        hostOnly: false,
        httpOnly: false,
        name: part.slice(0, separatorIndex).trim(),
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        value: part.slice(separatorIndex + 1).trim(),
      };
    });
}

function isBrowserCookie(value: unknown): value is BrowserCookie {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { name?: unknown; value?: unknown };
  return typeof candidate.name === 'string' && typeof candidate.value === 'string';
}

function logYouTubeAuthContext(auth: YouTubeAuthContext): void {
  if (loggedYouTubeAuthContext) {
    return;
  }

  loggedYouTubeAuthContext = true;
  console.log(`Using configured YouTube cookies from ${auth.sourceLabel}.`);
}

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
