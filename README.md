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

[▶ 0:00](https://youtu.be/VIDEO_ID?t=0) Brief description of this section.

### [2:30] Main Topic

[▶ 2:30](https://youtu.be/VIDEO_ID?t=150) Brief description of this section.

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

The tool tries three methods in order:

1. **YouTube captions** — official subtitles if available
2. **Auto-generated captions** — YouTube's automatic captions (built-in fallback)
3. **OpenAI Whisper STT** — downloads audio and transcribes it (requires API quota; audio must be under 25 MB)

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
