import { AppError } from './types.js';

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export interface ParsedYouTubeUrl {
  videoId: string;
  canonicalUrl: string;
}

/**
 * Parses the supported public YouTube URL shapes and validates the video ID.
 * Keeping parsing in one module prevents CLI validation and output-path logic
 * from disagreeing about which URLs are accepted.
 */
export function parseYouTubeUrl(input: string): ParsedYouTubeUrl {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new AppError('E_INVALID_INPUT', '--url must be a valid absolute URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AppError('E_UNSUPPORTED_URL', 'Only HTTP(S) YouTube URLs are supported.');
  }

  const hostname = parsed.hostname.toLowerCase();
  let candidate: string | null = null;

  if (hostname === 'youtu.be') {
    candidate = firstPathSegment(parsed.pathname);
  } else if (YOUTUBE_HOSTS.has(hostname)) {
    if (parsed.pathname === '/watch') {
      candidate = parsed.searchParams.get('v');
    } else {
      const segments = parsed.pathname.split('/').filter(Boolean);
      if (
        segments.length >= 2 &&
        ['shorts', 'live', 'embed', 'v'].includes(segments[0].toLowerCase())
      ) {
        candidate = segments[1];
      }
    }
  } else {
    throw new AppError(
      'E_UNSUPPORTED_URL',
      '--url must use youtube.com, youtube-nocookie.com, or youtu.be.'
    );
  }

  if (!candidate || !VIDEO_ID_PATTERN.test(candidate)) {
    throw new AppError(
      'E_UNSUPPORTED_URL',
      'Could not find a valid 11-character YouTube video ID in --url.'
    );
  }

  return {
    videoId: candidate,
    canonicalUrl: `https://youtu.be/${candidate}`,
  };
}

export function extractVideoId(input: string): string {
  return parseYouTubeUrl(input).videoId;
}

function firstPathSegment(pathname: string): string | null {
  return pathname.split('/').filter(Boolean)[0] ?? null;
}
