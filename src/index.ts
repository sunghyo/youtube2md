#!/usr/bin/env node

// dotenv/config must be imported first so env vars are loaded before anything reads them
import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function configureYtdlDebugPath(): void {
  if (process.env['YTDL_DEBUG_PATH']) {
    return;
  }

  // Avoid writing into cwd so --help/--version work from read-only directories.
  const ytdlCacheDir = path.join(os.tmpdir(), 'youtube2md', 'ytdl');
  try {
    mkdirSync(ytdlCacheDir, { recursive: true });
    process.env['YTDL_DEBUG_PATH'] = ytdlCacheDir;
  } catch {
    // Best-effort only. Continue without custom debug path.
  }
}

configureYtdlDebugPath();
import OpenAI from 'openai';
import { parseCli } from './cli.js';
import { extractVideoId, fetchVideoMetadata, fetchTranscript } from './youtube.js';
import { summarizeWithGpt } from './summarizer.js';
import { generateMarkdown, resolveOutputPath, writeMarkdownFile } from './markdown.js';
import type { SummaryData } from './types.js';

async function main(): Promise<void> {
  // Step 1: Parse and validate CLI arguments
  const { url, out, lang, model: cliModel } = parseCli();

  // Step 2: Validate environment
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey || apiKey.trim() === '') {
    console.error(
      'Error: OPENAI_API_KEY environment variable is not set.\n' +
        'Set it in your .env file or export it in your shell:\n' +
        '  export OPENAI_API_KEY=sk-...'
    );
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey });
  const model = cliModel ?? process.env['OPENAI_MODEL'] ?? 'gpt-5-mini';

  // Step 3: Extract video ID
  let videoId: string;
  try {
    videoId = extractVideoId(url);
  } catch (err) {
    console.error(`Error: ${String(err)}`);
    process.exit(1);
  }

  console.log(`Processing video: ${videoId}`);

  // Step 4: Fetch metadata
  let metadata: Awaited<ReturnType<typeof fetchVideoMetadata>>;
  try {
    console.log('Fetching video metadata...');
    metadata = await fetchVideoMetadata(videoId);
    console.log(`Title: "${metadata.title}" | Duration: ${metadata.duration}`);
    if (metadata.nativeChapters.length > 0) {
      console.log(`Found ${metadata.nativeChapters.length} native YouTube chapter(s).`);
    }
  } catch (err) {
    console.error(`Error fetching metadata: ${String(err)}`);
    process.exit(1);
  }

  // Step 5: Fetch transcript (with fallback to Whisper)
  let segments: Awaited<ReturnType<typeof fetchTranscript>>;
  try {
    segments = await fetchTranscript(videoId, openai);
    console.log(`Transcript fetched: ${segments.length} segments.`);
  } catch (err) {
    console.error(
      `Error: Could not fetch transcript through any method.\n` +
        `${String(err)}\n\n` +
        `Possible causes:\n` +
        `  - The video has no captions and audio download failed\n` +
        `  - The video is private or age-restricted\n` +
        `  - OPENAI_API_KEY lacks audio transcription access`
    );
    process.exit(1);
  }

  // Step 6: Summarize with GPT
  let gptResult: Awaited<ReturnType<typeof summarizeWithGpt>>;
  try {
    if (lang) {
      console.log(`Summary language override: ${lang}`);
    } else {
      console.log('Summary language: same as transcript');
    }

    gptResult = await summarizeWithGpt(openai, segments, metadata, model, lang);
    console.log(`GPT summary complete: ${gptResult.chapters.length} chapters detected.`);
  } catch (err) {
    console.error(`Error during GPT summarization: ${String(err)}`);
    process.exit(1);
  }

  // Step 7: Generate and write Markdown
  const summaryData: SummaryData = {
    metadata,
    summary: gptResult.summary,
    chapters: gptResult.chapters,
    takeaways: gptResult.takeaways,
  };

  const markdown = generateMarkdown(summaryData);
  const outputPath = resolveOutputPath(videoId, out);

  try {
    writeMarkdownFile(outputPath, markdown);
    console.log(`\nDone! Summary written to:\n  ${outputPath}`);
  } catch (err) {
    console.error(`Error writing output file: ${String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
