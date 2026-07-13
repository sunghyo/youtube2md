import assert from 'node:assert/strict';
import test from 'node:test';
import { detectCodexChatGptLogin } from '../summary-provider.js';

test('detects the installed ESM-only Codex SDK', async () => {
  // @openai/codex-sdk is a devDependency, so detection must get past the
  // installation check. The SDK is ESM-only; resolving it with require.resolve
  // used to throw ERR_PACKAGE_PATH_NOT_EXPORTED and misreport it as missing.
  const availability = await detectCodexChatGptLogin();

  assert.notEqual(
    availability.reason,
    'Optional @openai/codex-sdk provider is not installed.'
  );
  assert.notEqual(availability.reason, 'Codex CLI is not installed.');
});
