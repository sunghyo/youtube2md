import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTimestamp, renderTranscriptText } from '../transcript.js';

const segments = [
  { text: 'First line.', startSeconds: 0, durationSeconds: 2.5 },
  { text: 'Second line.', startSeconds: 65.9, durationSeconds: 3 },
  { text: 'Long video.', startSeconds: 3661, durationSeconds: 2 },
];

test('renders plain transcript text', () => {
  assert.equal(
    renderTranscriptText(segments, 'text'),
    'First line.\nSecond line.\nLong video.\n'
  );
});

test('renders timestamped transcript text', () => {
  assert.equal(
    renderTranscriptText(segments, 'timestamped-text'),
    '[0:00] First line.\n[1:05] Second line.\n[1:01:01] Long video.\n'
  );
});

test('formats negative and fractional timestamps safely', () => {
  assert.equal(formatTimestamp(-1), '0:00');
  assert.equal(formatTimestamp(65.9), '1:05');
});
