#!/usr/bin/env node

// dotenv/config must be imported first so env vars are loaded before anything reads them
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pre-parse --json flag before full CLI parsing so early errors can be emitted as JSON
let jsonMode = process.argv.includes('--json');

function configureYtdlEnvironment(): void {
  process.env['YTDL_NO_UPDATE'] ??= '1';

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

configureYtdlEnvironment();
import OpenAI from 'openai';
import { parseCli } from './cli.js';
import { extractVideoId, fetchVideoMetadata, fetchTranscript } from './youtube.js';
import { summarizeWithProvider } from './summarizer.js';
import {
  createCodexSummaryProvider,
  createOpenAiSummaryProvider,
  detectCodexChatGptLogin,
  type SummaryProvider,
} from './summary-provider.js';
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
  const transcript = await fetchTranscript(videoId, openai);
  console.log(
    `Transcript fetched: ${transcript.segments.length} segments via ${transcript.source}.`
  );

  const output = JSON.stringify(
    {
      ok: true,
      videoId,
      metadata,
      transcriptSource: transcript.source,
      segments: transcript.segments,
    },
    null,
    2
  );

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
  const openai = apiKey ? new OpenAI({ apiKey }) : null;
  const model = opts.model ?? process.env['OPENAI_MODEL'] ?? 'gpt-5.6-luna';

  const providers: SummaryProvider[] = [];
  const codexAvailability = await detectCodexChatGptLogin();
  if (codexAvailability.available) {
    try {
      providers.push(createCodexSummaryProvider());
    } catch (err) {
      console.warn(`Codex SDK initialization failed: ${String(err)}`);
    }
  } else {
    console.log(`Codex SDK unavailable: ${codexAvailability.reason}`);
  }
  if (openai) {
    providers.push(createOpenAiSummaryProvider(openai));
  }

  if (providers.length === 0) {
    throw new AppError(
      'E_SUMMARIZER_UNAVAILABLE',
      'No summarization provider is available.\n' +
        'Log in to Codex with ChatGPT (preferred):\n' +
        '  codex login\n' +
        'Or set an OpenAI API key as a fallback:\n' +
        '  export OPENAI_API_KEY=sk-...\n' +
        'Tip: use --extract-only to fetch transcripts without an API key.'
    );
  }

  const videoId = extractVideoId(opts.url);
  console.log(`Processing video: ${videoId}`);

  console.log('Fetching video metadata...');
  const metadata = await fetchVideoMetadata(videoId);
  console.log(`Title: "${metadata.title}" | Duration: ${metadata.duration}`);
  if (metadata.nativeChapters.length > 0) {
    console.log(`Found ${metadata.nativeChapters.length} native YouTube chapter(s).`);
  }

  console.log('Fetching transcript...');
  const transcript = await fetchTranscript(videoId, openai);
  const { segments } = transcript;
  console.log(
    `Transcript fetched: ${segments.length} segments via ${transcript.source}.`
  );

  if (opts.lang) {
    console.log(`Summary language override: ${opts.lang}`);
  } else {
    console.log('Summary language: same as transcript');
  }

  let gptResult: Awaited<ReturnType<typeof summarizeWithProvider>> | undefined;
  let selectedProvider: SummaryProvider | undefined;
  const providerFailures: Array<{ provider: SummaryProvider; error: unknown }> = [];

  for (const [index, provider] of providers.entries()) {
    console.log(`Summarization provider: ${provider.name}`);
    try {
      gptResult = await summarizeWithProvider(
        provider,
        segments,
        metadata,
        model,
        opts.lang
      );
      selectedProvider = provider;
      break;
    } catch (err) {
      providerFailures.push({ provider, error: err });
      const nextProvider = providers[index + 1];
      if (nextProvider) {
        console.warn(
          `${provider.name} failed; falling back to ${nextProvider.name}.\n` +
            `Details: ${String(err)}`
        );
      }
    }
  }

  if (!gptResult || !selectedProvider) {
    const details = providerFailures
      .map(({ provider, error }) => `  - ${provider.name}: ${String(error)}`)
      .join('\n');
    const openAiFailure = providerFailures.find(({ provider }) => provider.kind === 'openai');
    if (openAiFailure) {
      const msg = String(openAiFailure.error);
      if (msg.includes('401') || /invalid.api.key/i.test(msg) || /authentication/i.test(msg)) {
        throw new AppError('E_OPENAI_AUTH', msg);
      }
      if (msg.includes('429') || /rate.limit/i.test(msg)) {
        throw new AppError('E_OPENAI_RATE_LIMIT', msg);
      }
    }

    throw new AppError(
      'E_SUMMARIZER_UNAVAILABLE',
      `All configured summarization providers failed.\n${details}`
    );
  }
  console.log(
    `Summary complete via ${selectedProvider.name}: ` +
      `${gptResult.chapters.length} chapters detected.`
  );

  const summaryData: SummaryData = {
    metadata,
    transcriptSource: transcript.source,
    summary: gptResult.summary,
    chapters: gptResult.chapters,
    takeaways: gptResult.takeaways,
  };
  const markdown = generateMarkdown(summaryData);

  if (opts.stdout) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            videoId,
            metadata,
            transcriptSource: transcript.source,
            markdown,
          },
          null,
          2
        ) + '\n'
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
      JSON.stringify(
        {
          ok: true,
          videoId,
          metadata,
          transcriptSource: transcript.source,
          outputPath: outPath,
        },
        null,
        2
      ) + '\n'
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
