import assert from 'node:assert/strict';
import test from 'node:test';
import { generateMarkdown } from '../markdown.js';
import type { SummaryData, TranscriptSource } from '../types.js';

function createSummaryData(transcriptSource: TranscriptSource): SummaryData {
  return {
    metadata: {
      videoId: 'video-id',
      title: 'Video title',
      duration: '1:00',
      publishDate: '2026-07-12',
      description: '',
      nativeChapters: [],
    },
    transcriptSource,
    summary: 'Summary text.',
    chapters: [
      {
        timestamp: '0:00',
        seconds: 0,
        title: 'Introduction',
        descriptions: ['Chapter description.'],
      },
    ],
    takeaways: ['Key takeaway.'],
  };
}

test('marks summaries generated from a Whisper transcript', () => {
  const markdown = generateMarkdown(createSummaryData('whisper'));

  assert.match(
    markdown,
    /> Transcript source: OpenAI Whisper STT \(`whisper-1`\)/
  );
});

test('does not add a Whisper notice for YouTube captions', () => {
  const markdown = generateMarkdown(createSummaryData('youtube-captions'));

  assert.doesNotMatch(markdown, /Whisper/);
});
