import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const entrypoint = path.resolve('src/index.ts');

test('emits a single JSON envelope for CLI validation errors', () => {
  const result = runCli(['--json']);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    ok: false,
    mode: 'full',
    code: 'E_INVALID_INPUT',
    message: "required option '--url <youtube_url>' not specified",
  });
});

test('reports explicit OpenAI provider policy failures without network access', () => {
  const result = runCli(
    [
      '--json',
      '--url',
      'https://youtu.be/dQw4w9WgXcQ',
      '--provider',
      'openai',
    ],
    { OPENAI_API_KEY: '' }
  );

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    ok: false,
    mode: 'full',
    code: 'E_OPENAI_AUTH',
    message: '--provider openai requires OPENAI_API_KEY.',
  });
});

function runCli(
  args: string[],
  envOverrides: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
