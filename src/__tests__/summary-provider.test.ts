import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENAI_MODEL,
  detectCodexChatGptLogin,
  resolveSummaryModel,
} from '../summary-provider.js';

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

test('resolves models per provider so OPENAI_MODEL never leaks into Codex', (t) => {
  // The Codex/ChatGPT backend has its own model catalog; sending an OpenAI API
  // model ID there 404s, which silently pushed every run onto the billed API.
  const savedOpenAi = process.env['OPENAI_MODEL'];
  const savedCodex = process.env['CODEX_MODEL'];
  t.after(() => {
    if (savedOpenAi === undefined) delete process.env['OPENAI_MODEL'];
    else process.env['OPENAI_MODEL'] = savedOpenAi;
    if (savedCodex === undefined) delete process.env['CODEX_MODEL'];
    else process.env['CODEX_MODEL'] = savedCodex;
  });

  process.env['OPENAI_MODEL'] = 'api-only-model';
  delete process.env['CODEX_MODEL'];
  assert.equal(resolveSummaryModel('openai'), 'api-only-model');
  assert.equal(resolveSummaryModel('codex'), DEFAULT_CODEX_MODEL);

  process.env['CODEX_MODEL'] = 'codex-model-override';
  assert.equal(resolveSummaryModel('codex'), 'codex-model-override');

  delete process.env['OPENAI_MODEL'];
  assert.equal(resolveSummaryModel('openai'), DEFAULT_OPENAI_MODEL);

  assert.equal(resolveSummaryModel('codex', 'explicit-cli-model'), 'explicit-cli-model');
  assert.equal(resolveSummaryModel('openai', 'explicit-cli-model'), 'explicit-cli-model');
});
