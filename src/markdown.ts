import fs from 'node:fs';
import path from 'node:path';
import type { SummaryData } from './types.js';

/**
 * Generates the complete Markdown document as a string.
 */
export function generateMarkdown(data: SummaryData): string {
  const { metadata, transcriptSource, summary, chapters, takeaways } = data;
  const { videoId, title, duration, publishDate } = metadata;
  const watchUrl = `https://youtu.be/${videoId}`;

  const chaptersSection = chapters
    .map((ch) => {
      const linkUrl = `${watchUrl}?t=${ch.seconds}`;
      const descriptionsSection = ch.descriptions.map((line) => `- ${line}`).join('\n');
      return [
        `### [${ch.timestamp}] ${ch.title}`,
        ``,
        `[▶ ${ch.timestamp}](${linkUrl})`,
        ``,
        descriptionsSection,
      ].join('\n');
    })
    .join('\n\n');

  const takeawaysSection = takeaways.map((t) => `- ${t}`).join('\n');
  const transcriptNotice = transcriptSource === 'whisper'
    ? [`> Transcript source: OpenAI Whisper STT (\`whisper-1\`)`, ``]
    : [];

  return [
    `# ${title}`,
    ``,
    `> [Watch on YouTube](${watchUrl}) | Duration: ${duration} | Published: ${publishDate}`,
    ``,
    ...transcriptNotice,
    `## Summary`,
    ``,
    summary,
    ``,
    `## Chapters`,
    ``,
    chaptersSection,
    ``,
    `## Key Takeaways`,
    ``,
    takeawaysSection,
    ``,
  ].join('\n');
}

/**
 * Writes Markdown content to disk, creating parent directories as needed.
 */
export function writeMarkdownFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(
      `Failed to create output directory "${dir}".\n` +
        `Details: ${String(err)}`
    );
  }

  try {
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to write output file "${filePath}".\n` +
        `Details: ${String(err)}`
    );
  }
}
