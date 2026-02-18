import { Command } from 'commander';
import type { CliOptions } from './types.js';

/**
 * Parses process.argv and returns validated CLI options.
 * Exits with a user-friendly message on validation failure.
 */
export function parseCli(): CliOptions {
  const program = new Command();

  program
    .name('youtube2md')
    .description('Convert a YouTube video to a Markdown summary file')
    .version('1.0.0')
    .requiredOption('--url <youtube_url>', 'YouTube video URL to summarize')
    .option(
      '--lang <language>',
      'Summary output language (default: same as transcript language)'
    )
    .option(
      '--out <path>',
      'Output file path (default: ./summaries/<video_id>.md)'
    )
    .addHelpText(
      'after',
      `
Examples:
  $ youtube2md --url https://www.youtube.com/watch?v=dQw4w9WgXcQ
  $ youtube2md --url https://youtu.be/dQw4w9WgXcQ --out ./notes/video.md
  $ youtube2md --url https://youtu.be/dQw4w9WgXcQ --lang English
    `
    );

  program.parse(process.argv);

  const opts = program.opts<{ url: string; out?: string; lang?: string }>();

  if (!isYouTubeUrl(opts.url)) {
    console.error(
      `Error: --url must be a valid YouTube URL.\n` +
        `  Got: ${opts.url}\n` +
        `  Expected: https://www.youtube.com/watch?v=... or https://youtu.be/...`
    );
    process.exit(1);
  }

  const language = opts.lang?.replace(/\s+/g, ' ').trim();

  return {
    url: opts.url,
    out: opts.out,
    lang: language && language.length > 0 ? language : undefined,
  };
}

function isYouTubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'www.youtube.com' ||
      parsed.hostname === 'youtube.com' ||
      parsed.hostname === 'youtu.be' ||
      parsed.hostname === 'm.youtube.com'
    );
  } catch {
    return false;
  }
}
