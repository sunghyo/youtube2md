import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCli } from '../cli.js';
import { AppError } from '../types.js';

const VIDEO_URL = 'https://www.youtube.com/shorts/dQw4w9WgXcQ';

test('parses agent-oriented extract options', () => {
  const options = parseCli([
    'node',
    'youtube2md',
    '--url',
    VIDEO_URL,
    '--extract-only',
    '--extract-format',
    'timestamped-text',
    '--caption-lang',
    'ko-KR',
    '--captions-only',
    '--json',
    '--stdout',
  ]);

  assert.equal(options.videoId, 'dQw4w9WgXcQ');
  assert.equal(options.extractFormat, 'timestamped-text');
  assert.equal(options.captionLang, 'ko-KR');
  assert.equal(options.captionsOnly, true);
  assert.equal(options.json, true);
  assert.equal(options.stdout, true);
});

test('parses explicit provider selection', () => {
  const options = parseCli([
    'node',
    'youtube2md',
    '--url',
    VIDEO_URL,
    '--provider',
    'openai',
  ]);

  assert.equal(options.provider, 'openai');
});

test('turns missing required input into E_INVALID_INPUT', () => {
  const error = captureAppError(() => parseCli(['node', 'youtube2md', '--json']));
  assert.equal(error.code, 'E_INVALID_INPUT');
});

test('rejects extract format in full mode', () => {
  const error = captureAppError(() =>
    parseCli([
      'node',
      'youtube2md',
      '--url',
      VIDEO_URL,
      '--extract-format',
      'text',
    ])
  );
  assert.equal(error.code, 'E_INVALID_INPUT');
});

test('rejects malformed caption language codes', () => {
  const error = captureAppError(() =>
    parseCli([
      'node',
      'youtube2md',
      '--url',
      VIDEO_URL,
      '--caption-lang',
      'Korean language',
    ])
  );
  assert.equal(error.code, 'E_INVALID_INPUT');
});

function captureAppError(action: () => unknown): AppError {
  try {
    action();
  } catch (err) {
    assert.ok(err instanceof AppError);
    return err;
  }
  assert.fail('Expected AppError.');
}
