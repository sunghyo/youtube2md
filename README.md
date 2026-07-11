# youtube2md

[![npm version](https://img.shields.io/npm/v/youtube2md)](https://www.npmjs.com/package/youtube2md)
[![npm downloads](https://img.shields.io/npm/dm/youtube2md)](https://www.npmjs.com/package/youtube2md)

> Also available as a skill: [youtube-summary on ClawhHub](https://clawhub.ai/sunghyo/youtube-summary)

Convert any YouTube video into a structured Markdown summary — with chapter detection, clickable timestamp links, and key takeaways.

Two modes:

- **Standalone** — fetch transcript + summarize with Codex SDK or OpenAI → write Markdown file
- **Extract-only** — fetch transcript only, no API key required → output JSON for external processing

## Install

```bash
npm install -g youtube2md
```

Or use without installing (reuses an existing Codex ChatGPT login when available):

```bash
npx youtube2md --url https://youtu.be/VIDEO_ID
```

## Usage

```bash
# Basic usage
youtube2md --url https://www.youtube.com/watch?v=VIDEO_ID

# Custom output path
youtube2md --url https://youtu.be/VIDEO_ID --out ./notes/video.md

# Custom output directory (files saved as <video_id>.md)
youtube2md --url https://youtu.be/VIDEO_ID --out-dir ./output

# Set summary language
youtube2md --url https://youtu.be/VIDEO_ID --lang Korean

# Use a specific model
youtube2md --url https://youtu.be/VIDEO_ID --model gpt-5.6-luna

# Extract transcript only (no API key required if captions are available)
youtube2md --url https://youtu.be/VIDEO_ID --extract-only

# Use signed-in YouTube cookies when captions/audio need an authenticated session
YOUTUBE_COOKIES_PATH=./cookies.youtube.json youtube2md --url https://youtu.be/VIDEO_ID --extract-only

# Machine-readable JSON output from full pipeline
youtube2md --url https://youtu.be/VIDEO_ID --json --stdout
```

Output is saved to `./summaries/<video_id>.md` (full pipeline) or `./summaries/<video_id>.json` (extract-only) by default.

### Options

| Option | Description |
|---|---|
| `--url <youtube_url>` | YouTube video URL (required) |
| `--model <model>` | OpenAI model to use (default: `gpt-5.6-luna`). Overrides `OPENAI_MODEL` env var. |
| `--lang <language>` | Summary output language (default: same as transcript language) |
| `--out <path>` | Output file path |
| `--out-dir <dir>` | Output directory; file is named `<video_id>.md` (default: `./summaries`) |
| `--extract-only` | Skip summarization, output raw transcript as JSON |
| `--json` | Emit result as JSON (success and errors); progress logs go to stderr |
| `--stdout` | Write output to stdout instead of a file |
| `--help` | Show help |
| `--version` | Show version |

## Requirements

- Node.js 18+
- An active Codex ChatGPT login, or an OpenAI API key as a fallback
- `OPENAI_API_KEY` is still required when caption retrieval fails and Whisper STT is needed

## Authentication priority

Summarization providers are tried in this order:

1. **Codex SDK with ChatGPT login** — detected with the bundled Codex CLI and used without passing `OPENAI_API_KEY` to Codex.
2. **OpenAI API** — used only when Codex ChatGPT login is unavailable or Codex summarization fails.

Log in to Codex once, then run `youtube2md` normally:

```bash
codex login
codex login status
youtube2md --url https://youtu.be/VIDEO_ID
```

Only a ChatGPT-authenticated Codex session is preferred. A Codex session authenticated with an API key is not treated as the keyless Codex path.

## Environment variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | Optional summarization fallback; also enables Whisper STT when captions are unavailable. |
| `OPENAI_MODEL` | Optional. Fallback model if `--model` is not passed (default: `gpt-5.6-luna`). |
| `YOUTUBE_COOKIES_PATH` | Optional. Path to an EditThisCookie JSON export for `youtube.com`. Used for metadata, captions, and audio fallback requests. |
| `YOUTUBE_COOKIE_HEADER` | Optional. Raw `Cookie` header string for `youtube.com` requests. Useful when you already have a browser request cookie string. |

To configure the API fallback, export a key:

```bash
export OPENAI_API_KEY=sk-...
youtube2md --url https://youtu.be/VIDEO_ID
```

Or create a `.env` file in your working directory:

```
OPENAI_API_KEY=sk-...
# YOUTUBE_COOKIES_PATH=./cookies.youtube.json
```

When YouTube exposes caption tracks but blocks the actual transcript or downloadable audio to anonymous requests, provide `YOUTUBE_COOKIES_PATH` or `YOUTUBE_COOKIE_HEADER` from a signed-in browser session.

## Output format

### Markdown (full pipeline)

```markdown
# Video Title

> [Watch on YouTube](https://youtu.be/VIDEO_ID) | Duration: 12:34 | Published: 2024-01-01

> Transcript source: OpenAI Whisper STT (`whisper-1`)

## Summary

One paragraph overview of the video content.

## Chapters

### [0:00] Introduction

[▶ 0:00](https://youtu.be/VIDEO_ID?t=0)

- First key point from this section.
- Second key point from this section.

## Key Takeaways

- Key point 1
- Key point 2
```

The transcript source line is included only when the caption fallbacks were unavailable and Whisper STT produced the transcript.

### JSON (extract-only)

```json
{
  "ok": true,
  "videoId": "VIDEO_ID",
  "metadata": {
    "videoId": "VIDEO_ID",
    "title": "Video Title",
    "duration": "12:34",
    "publishDate": "2024-01-01",
    "nativeChapters": []
  },
  "transcriptSource": "youtube-captions",
  "segments": [
    { "text": "Hello world", "startSeconds": 0.0, "durationSeconds": 2.4 }
  ]
}
```

### JSON (full pipeline with `--json`)

```json
{
  "ok": true,
  "videoId": "VIDEO_ID",
  "metadata": { "..." },
  "transcriptSource": "whisper",
  "outputPath": "/path/to/summaries/VIDEO_ID.md"
}
```

### Error JSON

All errors emit a structured object when `--json` is active:

```json
{ "ok": false, "code": "E_TRANSCRIPT_UNAVAILABLE", "message": "..." }
```

| Code | Cause |
|---|---|
| `E_TRANSCRIPT_UNAVAILABLE` | No captions found and Whisper fallback unavailable |
| `E_SUMMARIZER_UNAVAILABLE` | Neither Codex SDK nor the OpenAI API fallback could summarize |
| `E_OPENAI_AUTH` | The configured `OPENAI_API_KEY` fallback is invalid |
| `E_OPENAI_RATE_LIMIT` | OpenAI rate limit hit |
| `E_WHISPER_FAILED` | Whisper STT transcription failed |
| `E_NETWORK` | Network or YouTube access error |
| `E_WRITE_FAILED` | Could not write output file |

## Transcript strategy

The tool tries these methods in order:

1. **YouTube captions via watch-page / InnerTube requests** — uses caption tracks directly and applies configured YouTube cookies when available (supports `json3` and XML timedtext formats)
2. **`youtube-transcript` fallback** — retries with an alternate parser path
3. **OpenAI Whisper STT fallback** — resolves a directly downloadable audio-only stream through the Android InnerTube player, downloads it, and transcribes it with `whisper-1` segment timestamps (requires `OPENAI_API_KEY`; audio must be under 25 MB). The resulting JSON records `transcriptSource: "whisper"`, and full Markdown output adds a Whisper source notice. Skipped when no API key is set.

## Summary process

Summarization runs in two modes based on transcript token count (using `tiktoken` with model-aware encoding):

The tool first attempts the Codex SDK with an active ChatGPT login. If that path is unavailable or fails, it retries the complete summarization through the OpenAI Responses API when `OPENAI_API_KEY` is configured. Codex runs in a temporary read-only working directory with tool, command, and web use disabled by the summarization prompt and runtime settings.

1. **Normalize transcript**: convert each segment to `[MM:SS] spoken text` (or `[H:MM:SS]` past the one-hour mark).
2. **Count tokens**: compute transcript size with `tiktoken` (fallback to `o200k_base`).
3. **Choose mode**:
   - **Single-pass** when total tokens are `<= 5000`
   - **Chunked** when total tokens are `> 5000`
4. **Single-pass mode**: one GPT request with metadata, video description, native YouTube chapters, and full transcript.
5. **Chunked mode**:
   - Split into chunks targeting `5000` tokens, snapping boundaries to natural break points (native chapter starts or speech pauses) once a chunk is soft-filled, so a topic isn't cut mid-sentence.
   - Merge tiny final chunk (`< 25%` of limit) into the previous chunk.
   - Carry a short **read-only overlap** from the previous section into each chunk for context.
   - Give each chunk the video description and full chapter outline, and scale its output targets (chapters / descriptions / takeaways) to the amount of content it holds.
   - Summarize each chunk in parallel (up to 4 concurrent jobs).
   - Combine chapters locally, merging near-in-time boundary duplicates that adjacent chunks emit.
   - One final GPT request for full-video summary and takeaways.
6. **Structured output + validation**: Codex SDK requests use `outputSchema`; OpenAI Responses API requests use strict `json_schema`. Transient failures retry with exponential backoff. Chapter times are resolved from the (transcript-copied) timestamp, clamped to their section's window, and re-rendered so display and `?t=` link always agree.
7. **Render Markdown**: convert to final output.

### Token thresholds & tuning

Defined in `src/summarizer.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `SINGLE_PASS_TOKEN_LIMIT` | `5000` | Use single-pass below this |
| `CHUNK_TOKEN_LIMIT` | `5000` | Target tokens per chunk |
| `MIN_LAST_CHUNK_RATIO` | `0.25` | Merge final chunk if smaller than 25% of limit |
| `CHUNK_SOFT_FILL_RATIO` | `0.6` | Fraction of budget after which a chunk closes at the next natural boundary |
| `SPEECH_GAP_BREAK_SECONDS` | `2.5` | Silent gap treated as a topic break |
| `CHUNK_OVERLAP_RATIO` | `0.12` | Leading read-only overlap carried into each chunk |
| `MAX_API_ATTEMPTS` | `3` | Attempts per GPT request before giving up |

---

## Development

```bash
# Clone and install
git clone https://github.com/sunghyo/youtube2md
cd youtube2md
npm install

# Optional: configure the API/Whisper fallback
cp .env.example .env
# Edit .env and add OPENAI_API_KEY if needed

# Run without building
npx tsx src/index.ts --url https://www.youtube.com/watch?v=VIDEO_ID
```

### Build

```bash
npm run build   # Compile TypeScript to dist/
npm run dev     # Run directly with tsx (no build needed)
npm test        # Run TypeScript tests with Node's test runner
npm run clean   # Remove dist/
```

### Project structure

```
src/
├── index.ts             # Entry point — pipeline branching and orchestration
├── cli.ts               # CLI argument parsing (Commander)
├── youtube.ts           # Metadata fetch + transcript fetch with fallback
├── summary-provider.ts  # Codex-first provider selection and OpenAI adapter
├── summarizer.ts        # Provider-neutral prompting + JSON parsing
├── markdown.ts          # Markdown generation + file writing
├── __tests__/            # TypeScript tests run with npm test
└── types.ts             # Shared interfaces, AppError, error codes
summaries/         # Default output directory
```

## Attribution

This project was built with AI assistance from [Claude](https://claude.ai) (Anthropic) and [Codex](https://openai.com/blog/openai-codex) (OpenAI).
