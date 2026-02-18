# youtube2md

Convert any YouTube video into a structured Markdown summary — with chapter detection, clickable timestamp links, and key takeaways.

## Output

```markdown
# Video Title

> [Watch on YouTube](https://youtu.be/VIDEO_ID) | Duration: 12:34 | Published: 2024-01-01

## Summary

One paragraph overview of the video content.

## Chapters

### [0:00] Introduction

[▶ 0:00](https://youtu.be/VIDEO_ID?t=0)

- First key point from this section.
- Second key point from this section.

### [2:30] Main Topic

[▶ 2:30](https://youtu.be/VIDEO_ID?t=150)

- First key point from this section.
- Second key point from this section.

## Key Takeaways

- Key point 1
- Key point 2
```

## Requirements

- Node.js 18+
- OpenAI API key with access to GPT-5 models

## Setup

```bash
# 1. Clone and install
git clone <repo>
cd youtube2md
npm install

# 2. Set your API key
cp .env.example .env
# Edit .env and add your OPENAI_API_KEY
```

## Usage

```bash
# Development
npx tsx src/index.ts --url https://www.youtube.com/watch?v=VIDEO_ID

# After build
npm run build
node dist/index.js --url https://www.youtube.com/watch?v=VIDEO_ID

# With custom output path
node dist/index.js --url https://youtu.be/VIDEO_ID --out ./notes/video.md
```

Output is saved to `./summaries/<video_id>.md` by default.

### Options

| Option | Description |
|---|---|
| `--url <youtube_url>` | YouTube video URL (required) |
| `--out <path>` | Output file path (default: `./summaries/<video_id>.md`) |
| `--help` | Show help |
| `--version` | Show version |

### Global install

```bash
npm install -g .
youtube2md --url https://youtu.be/VIDEO_ID
```

## Environment variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | Required. Your OpenAI API key. |
| `OPENAI_MODEL` | Optional. Override the model (default: `gpt-5-mini`). |

## Transcript strategy

The tool tries these methods in order:

1. **YouTube captions via Android Innertube** — uses YouTube caption tracks when available (official or auto-generated)
2. **OpenAI Whisper STT fallback** — downloads audio and transcribes it when captions are unavailable (requires API quota; audio must be under 25 MB)

## Summary process

Summarization runs in two modes based on transcript token count (using `tiktoken` with model-aware encoding):

1. **Normalize transcript**: convert each segment to `[MM:SS] spoken text` so timestamps stay tied to content.
2. **Count tokens**: compute transcript size with `tiktoken` (model-aware encoding; fallback to `o200k_base`).
3. **Choose mode**:
   - **Single-pass** when total tokens are `<= 5000`
   - **Chunked** when total tokens are `> 5000`
4. **Single-pass mode**:
   - Send one GPT request with metadata, optional native YouTube chapters, and full transcript.
   - Expect strict JSON output: `summary`, `chapters`, `takeaways`.
5. **Chunked mode**:
   - Split transcript into chunks targeting `5000` tokens.
   - If the last chunk is too small (`< 25%` of chunk limit), merge it into the previous chunk.
   - Summarize each chunk to the same JSON schema.
   - Combine chunk summaries + chapters locally (chronological sort + dedupe).
   - Run one final GPT request for full-video summary + takeaways.
6. **Validate + normalize**:
   - Parse JSON and require non-empty `summary`, `chapters`, and `takeaways`.
   - Normalize timestamps/seconds, sort chapters chronologically, and deduplicate chapters/takeaways.
7. **Render Markdown**:
   - Convert the normalized structured result into the final Markdown output.

This prevents long videos from being truncated and keeps output quality more proportional to transcript length.

### Token thresholds

These constants are defined in `src/summarizer.ts`:

- `SINGLE_PASS_TOKEN_LIMIT = 5000`
  - If the full transcript is `<= 5000` tokens, the app uses single-pass summarization.
- `CHUNK_TOKEN_LIMIT = 5000`
  - In chunked mode, each chunk targets up to about `5000` tokens.
- `MIN_LAST_CHUNK_RATIO = 0.25`
  - If the final chunk is smaller than `25%` of `CHUNK_TOKEN_LIMIT`, it is merged into the previous chunk.
  - This avoids a tiny final chunk that usually lowers summary quality.

## Project structure

```
src/
├── index.ts       # Entry point — orchestrates all steps
├── cli.ts         # CLI argument parsing (Commander)
├── youtube.ts     # Metadata fetch + transcript fetch with fallback
├── summarizer.ts  # OpenAI Responses API prompting + JSON parsing
├── markdown.ts    # Markdown generation + file writing
└── types.ts       # Shared TypeScript interfaces
summaries/         # Default output directory
```

## Build

```bash
npm run build   # Compile TypeScript to dist/
npm run dev     # Run directly with tsx (no build needed)
npm run clean   # Remove dist/
```

## Attribution

This project was built with AI assistance. This project was generated with AI assistance from [Claude](https://claude.ai) (Anthropic) and [Codex](https://openai.com/blog/openai-codex) (OpenAI).
