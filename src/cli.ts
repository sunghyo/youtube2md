import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import { AppError } from './types.js';
import type {
  CliOptions,
  ExtractFormat,
  ProviderPreference,
} from './types.js';
import { parseYouTubeUrl } from './youtube-url.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
const PROVIDERS = new Set<ProviderPreference>(['auto', 'codex', 'openai']);
const EXTRACT_FORMATS = new Set<ExtractFormat>([
  'json',
  'text',
  'timestamped-text',
]);

/** Signals that Commander already displayed help/version and no error occurred. */
export class CliDisplayExit extends Error {
  constructor(public readonly exitCode: number) {
    super('CLI display completed.');
    this.name = 'CliDisplayExit';
  }
}

/** Parses and validates CLI arguments without directly terminating the process. */
export function parseCli(argv: string[] = process.argv): CliOptions {
  const program = new Command();

  program
    .name('youtube2md')
    .description('Convert a YouTube video to a Markdown summary file')
    .version(version)
    .requiredOption('--url <youtube_url>', 'YouTube video URL to summarize')
    .option(
      '--lang <language>',
      'Summary output language (default: same as transcript language)'
    )
    .option(
      '--caption-lang <language_code>',
      'Preferred caption language, such as en, ko, or pt-BR (falls back if unavailable)'
    )
    .option(
      '--model <model>',
      'Model for summarization; applies to whichever provider runs ' +
        '(default: gpt-5.6-luna; per-provider overrides: CODEX_MODEL, OPENAI_MODEL)'
    )
    .option(
      '--provider <provider>',
      'Summarization provider: auto, codex, or openai',
      'auto'
    )
    .option(
      '--out <path>',
      'Output file path (default: ./summaries/<video_id>.<ext>)'
    )
    .option(
      '--out-dir <dir>',
      'Output directory; file is named <video_id>.<ext> (default: ./summaries)'
    )
    .option(
      '--extract-only',
      'Skip summarization and output transcript data'
    )
    .option(
      '--extract-format <format>',
      'Extract artifact format: json, text, or timestamped-text (default: json)'
    )
    .option(
      '--captions-only',
      'Use YouTube captions only; never send audio to Whisper'
    )
    .option(
      '--json',
      'Emit a versioned JSON result envelope; errors also output as JSON'
    )
    .option(
      '--stdout',
      'Write content to stdout instead of a file'
    )
    .addHelpText(
      'after',
      `
Examples:
  $ youtube2md --url https://www.youtube.com/watch?v=dQw4w9WgXcQ
  $ youtube2md --url https://youtu.be/dQw4w9WgXcQ --out ./notes/video.md
  $ youtube2md --url https://youtu.be/dQw4w9WgXcQ --lang English --provider openai
  $ youtube2md --url https://youtu.be/dQw4w9WgXcQ --extract-only --stdout
  $ youtube2md --url https://youtu.be/dQw4w9WgXcQ --extract-only --extract-format timestamped-text
  $ youtube2md --url https://youtu.be/dQw4w9WgXcQ --extract-only --captions-only --json
    `
    );

  program.exitOverride();
  program.configureOutput({
    // A single top-level handler owns all error output, including JSON mode.
    writeErr: () => undefined,
  });

  try {
    program.parse(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.exitCode === 0) {
        throw new CliDisplayExit(0);
      }
      throw new AppError('E_INVALID_INPUT', cleanCommanderMessage(err.message));
    }
    throw err;
  }

  const opts = program.opts<{
    url: string;
    out?: string;
    outDir?: string;
    lang?: string;
    captionLang?: string;
    model?: string;
    provider: string;
    extractOnly?: boolean;
    extractFormat?: string;
    captionsOnly?: boolean;
    json?: boolean;
    stdout?: boolean;
  }>();

  if (!PROVIDERS.has(opts.provider as ProviderPreference)) {
    throw new AppError(
      'E_INVALID_INPUT',
      '--provider must be one of: auto, codex, openai.'
    );
  }

  const extractFormat = (opts.extractFormat ?? 'json') as ExtractFormat;
  if (!EXTRACT_FORMATS.has(extractFormat)) {
    throw new AppError(
      'E_INVALID_INPUT',
      '--extract-format must be one of: json, text, timestamped-text.'
    );
  }
  if (opts.extractFormat && !opts.extractOnly) {
    throw new AppError(
      'E_INVALID_INPUT',
      '--extract-format can only be used with --extract-only.'
    );
  }

  const language = normalizeWhitespace(opts.lang);
  const captionLang = opts.captionLang?.trim();
  if (captionLang && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(captionLang)) {
    throw new AppError(
      'E_INVALID_INPUT',
      '--caption-lang must be a language code such as en, ko, zh-Hant, or pt-BR.'
    );
  }

  const { videoId } = parseYouTubeUrl(opts.url);

  return {
    url: opts.url,
    videoId,
    out: opts.out,
    outDir: opts.outDir,
    lang: language,
    captionLang,
    model: opts.model?.trim() || undefined,
    provider: opts.provider as ProviderPreference,
    extractFormat,
    captionsOnly: opts.captionsOnly ?? false,
    extractOnly: opts.extractOnly ?? false,
    json: opts.json ?? false,
    stdout: opts.stdout ?? false,
  };
}

function normalizeWhitespace(value?: string): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function cleanCommanderMessage(message: string): string {
  return message.replace(/^error:\s*/i, '').trim();
}
