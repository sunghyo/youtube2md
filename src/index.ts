#!/usr/bin/env node

// dotenv/config must be imported first so env vars are loaded before anything reads them
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pre-parse --json flag before full CLI parsing so early errors can be emitted as JSON
let jsonMode = process.argv.includes('--json');

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
import { generateMarkdown, writeMarkdownFile } from './markdown.js';
import type { SummaryData, CliOptions } from './types.js';
import { AppError } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolves output file path from CLI options.
 * Priority: --out > --out-dir/<videoId>.<ext> > ./summaries/<videoId>.<ext>
 */
function computeOutputPath(videoId: string, opts: CliOptions, ext: string): string {
  if (opts.out) return path.resolve(opts.out);
  const dir = opts.outDir
    ? path.resolve(opts.outDir)
    : path.resolve(process.cwd(), 'summaries');
  return path.join(dir, `${videoId}.${ext}`);
}

// ─── Extract-only pipeline ────────────────────────────────────────────────────

async function runExtractPipeline(opts: CliOptions): Promise<void> {
  const videoId = extractVideoId(opts.url);

  // OpenAI is optional in extract-only mode (only needed for Whisper fallback)
  const apiKey = process.env['OPENAI_API_KEY']?.trim();
  const openai = apiKey ? new OpenAI({ apiKey }) : null;

  console.log(`Processing video: ${videoId}`);

  console.log('Fetching video metadata...');
  const metadata = await fetchVideoMetadata(videoId);
  console.log(`Title: "${metadata.title}" | Duration: ${metadata.duration}`);

  console.log('Fetching transcript...');
  const segments = await fetchTranscript(videoId, openai);
  console.log(`Transcript fetched: ${segments.length} segments.`);

  const output = JSON.stringify({ ok: true, videoId, metadata, segments }, null, 2);

  if (opts.stdout) {
    process.stdout.write(output + '\n');
    return;
  }

  const outPath = computeOutputPath(videoId, opts, 'json');
  try {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, output, 'utf-8');
  } catch (err) {
    throw new AppError('E_WRITE_FAILED', String(err));
  }
  console.log(`\nExtract complete! Written to:\n  ${outPath}`);
}

// ─── Full pipeline ────────────────────────────────────────────────────────────

async function runFullPipeline(opts: CliOptions): Promise<void> {
  const apiKey = process.env['OPENAI_API_KEY']?.trim();
  if (!apiKey) {
    throw new AppError(
      'E_OPENAI_AUTH',
      'OPENAI_API_KEY is not set.\n' +
        'Set it in your .env file or export it in your shell:\n' +
        '  export OPENAI_API_KEY=sk-...\n' +
        'Tip: use --extract-only to fetch transcripts without an API key.'
    );
  }

  const openai = new OpenAI({ apiKey });
  const model = opts.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-5-mini';

  const videoId = extractVideoId(opts.url);
  console.log(`Processing video: ${videoId}`);

  console.log('Fetching video metadata...');
  const metadata = await fetchVideoMetadata(videoId);
  console.log(`Title: "${metadata.title}" | Duration: ${metadata.duration}`);
  if (metadata.nativeChapters.length > 0) {
    console.log(`Found ${metadata.nativeChapters.length} native YouTube chapter(s).`);
  }

  console.log('Fetching transcript...');
  const segments = await fetchTranscript(videoId, openai);
  console.log(`Transcript fetched: ${segments.length} segments.`);

  if (opts.lang) {
    console.log(`Summary language override: ${opts.lang}`);
  } else {
    console.log('Summary language: same as transcript');
  }

  let gptResult: Awaited<ReturnType<typeof summarizeWithGpt>>;
  try {
    gptResult = await summarizeWithGpt(openai, segments, metadata, model, opts.lang);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('401') || /invalid.api.key/i.test(msg) || /authentication/i.test(msg)) {
      throw new AppError('E_OPENAI_AUTH', msg);
    }
    if (msg.includes('429') || /rate.limit/i.test(msg)) {
      throw new AppError('E_OPENAI_RATE_LIMIT', msg);
    }
    throw err;
  }
  console.log(`GPT summary complete: ${gptResult.chapters.length} chapters detected.`);

  const summaryData: SummaryData = {
    metadata,
    summary: gptResult.summary,
    chapters: gptResult.chapters,
    takeaways: gptResult.takeaways,
  };
  const markdown = generateMarkdown(summaryData);

  if (opts.stdout) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, videoId, metadata, markdown }, null, 2) + '\n'
      );
    } else {
      process.stdout.write(markdown);
    }
    return;
  }

  const outPath = computeOutputPath(videoId, opts, 'md');
  try {
    writeMarkdownFile(outPath, markdown);
  } catch (err) {
    throw new AppError('E_WRITE_FAILED', String(err));
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, videoId, metadata, outputPath: outPath }, null, 2) + '\n'
    );
  } else {
    console.log(`\nDone! Summary written to:\n  ${outPath}`);
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCli();
  jsonMode = opts.json;

  // Redirect progress logs to stderr so stdout stays clean for data output
  if (opts.json || opts.stdout) {
    console.log = (...args: unknown[]) => console.error(...args);
  }

  if (opts.extractOnly) {
    await runExtractPipeline(opts);
  } else {
    await runFullPipeline(opts);
  }
}

main().catch((err) => {
  if (err instanceof AppError) {
    if (jsonMode) {
      process.stdout.write(
        JSON.stringify({ ok: false, code: err.code, message: err.message }) + '\n'
      );
    } else {
      process.stderr.write(`Error [${err.code}]: ${err.message}\n`);
    }
  } else {
    if (jsonMode) {
      process.stdout.write(
        JSON.stringify({ ok: false, code: 'E_UNKNOWN', message: String(err) }) + '\n'
      );
    } else {
      console.error('Unexpected error:', err);
    }
  }
  process.exit(1);
});
