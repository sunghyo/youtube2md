import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../types.js';
import { extractVideoId, parseYouTubeUrl } from '../youtube-url.js';

const VIDEO_ID = 'dQw4w9WgXcQ';

test('extracts IDs from supported YouTube URL variants', () => {
  const urls = [
    `https://www.youtube.com/watch?v=${VIDEO_ID}&t=42s`,
    `https://youtu.be/${VIDEO_ID}?t=42`,
    `https://www.youtube.com/shorts/${VIDEO_ID}`,
    `https://www.youtube.com/live/${VIDEO_ID}?feature=share`,
    `https://www.youtube.com/embed/${VIDEO_ID}`,
    `https://music.youtube.com/watch?v=${VIDEO_ID}`,
    `https://www.youtube-nocookie.com/embed/${VIDEO_ID}`,
  ];

  for (const url of urls) {
    assert.equal(extractVideoId(url), VIDEO_ID, url);
  }
});

test('returns a canonical URL', () => {
  assert.deepEqual(parseYouTubeUrl(`https://youtu.be/${VIDEO_ID}`), {
    videoId: VIDEO_ID,
    canonicalUrl: `https://youtu.be/${VIDEO_ID}`,
  });
});

test('rejects non-video and unsafe video IDs', () => {
  for (const url of [
    'https://www.youtube.com/',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=../../tmp/file',
    'file:///tmp/video',
  ]) {
    assert.throws(
      () => extractVideoId(url),
      (err: unknown) => err instanceof AppError && err.code.startsWith('E_'),
      url
    );
  }
});
