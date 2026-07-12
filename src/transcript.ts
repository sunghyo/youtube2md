import type { ExtractFormat, TranscriptSegment } from './types.js';

/** Renders transcript segments as plain or timestamp-preserving UTF-8 text. */
export function renderTranscriptText(
  segments: TranscriptSegment[],
  format: Exclude<ExtractFormat, 'json'>
): string {
  const lines = segments.map((segment) => {
    if (format === 'timestamped-text') {
      return `[${formatTimestamp(segment.startSeconds)}] ${segment.text}`;
    }
    return segment.text;
  });

  return `${lines.join('\n')}\n`;
}

export function formatTimestamp(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(remainder).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
