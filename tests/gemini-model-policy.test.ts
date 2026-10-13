import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalGeminiModel,
  defaultGeminiFallbackModel,
  defaultGeminiModel,
  resolveGeminiModelPair,
} from '../apps/server/src/services/gemini-model-policy.js';

test("only Google's documented Flash aliases resolve to their current backend", () => {
  assert.equal(canonicalGeminiModel(' models/gemini-3.7-flash '), 'gemini-3.8-flash');
  assert.equal(canonicalGeminiModel('gemini-3.5-flash'), 'gemini-3.6-flash');
  assert.equal(canonicalGeminiModel('gemini-3.6-flash'), 'gemini-3.6-flash');
  assert.equal(canonicalGeminiModel('models/custom-model-preview'), 'custom-model-preview');
  assert.equal(canonicalGeminiModel('Gemini-3.7-Flash'), 'Gemini-3.7-Flash');
});

test('historical defaults migrate to distinct Flash models; deliberate custom choices survive', () => {
  const recommended = { model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.6-flash' };
  assert.deepEqual(resolveGeminiModelPair('gemini-3.7-flash', 'gemini-3.6-flash'), recommended);
  assert.deepEqual(resolveGeminiModelPair('gemini-3.8-flash', 'gemini-3.7-flash'), recommended);
  assert.deepEqual(resolveGeminiModelPair('models/gemini-3.8-flash', 'models/gemini-3.7-flash'), recommended);
  assert.equal(defaultGeminiModel, recommended.model);
  assert.equal(defaultGeminiFallbackModel, recommended.fallbackModel);

  assert.deepEqual(resolveGeminiModelPair('gemini-3.7-flash', ''), { model: 'gemini-3.8-flash', fallbackModel: '' });
  assert.deepEqual(resolveGeminiModelPair('gemini-3.5-flash', 'gemini-3.6-flash'), { model: 'gemini-3.6-flash', fallbackModel: '' });
  assert.deepEqual(resolveGeminiModelPair('gemini-3.7-flash', 'gemini-3.8-flash'), { model: 'gemini-3.8-flash', fallbackModel: '' });
  assert.deepEqual(resolveGeminiModelPair('models/custom-preview', 'custom-preview'), { model: 'custom-preview', fallbackModel: '' });
  assert.deepEqual(resolveGeminiModelPair('models/custom-primary', 'models/custom-secondary'), {
    model: 'custom-primary',
    fallbackModel: 'custom-secondary',
  });
  assert.deepEqual(resolveGeminiModelPair('gemini-3.7-flash', 'custom-secondary'), {
    model: 'gemini-3.8-flash',
    fallbackModel: 'custom-secondary',
  });
});

test('old environment and stored default pairs migrate without accessing real secrets or saving on read', {
  skip: process.platform === 'darwin' ? 'The macOS settings resolver consults the real Keychain' : false,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sthang-gemini-policy-'));
  const envNames = [
    'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'STHANG_STUDIO_STATE_ROOT', 'STHANG_STUDIO_ENV_FILE',
    'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODEL',
  ] as const;
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  try {
    process.env.LOCALAPPDATA = tempRoot;
    process.env.XDG_CONFIG_HOME = tempRoot;
    process.env.STHANG_STUDIO_STATE_ROOT = tempRoot;
    process.env.STHANG_STUDIO_ENV_FILE = path.join(tempRoot, 'absent.env');
    process.env.GEMINI_API_KEY = 'your_google_ai_studio_api_key_here';
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    process.env.GEMINI_FALLBACK_MODEL = 'gemini-3.7-flash';

    const { config } = await import('../apps/server/src/config.js');
    assert.equal(config.geminiModel, 'gemini-3.8-flash');
    assert.equal(config.geminiFallbackModel, 'gemini-3.6-flash', 'a previously installed .env default needs an independent fallback');

    const settingsDir = path.join(tempRoot, process.platform === 'win32' ? 'Sthang Studio' : 'sthang-studio');
    const metadataFile = path.join(settingsDir, 'llm-settings.json');
    await fs.mkdir(settingsDir, { recursive: true });
    const oldV1 = JSON.stringify({
      version: 1,
      provider: 'gemini',
      model: 'gemini-3.7-flash',
      fallbackModel: 'gemini-3.6-flash',
      keyLast4: 'xxxx',
    });
    await fs.writeFile(metadataFile, oldV1);

    const { resolveGeminiSettings, saveLlmSettings, testGeminiConnection } = await import('../apps/server/src/services/llm-settings.js');
    const resolved = await resolveGeminiSettings();
    assert.equal(resolved.configured, false);
    assert.equal(resolved.model, 'gemini-3.8-flash');
    assert.equal(resolved.fallbackModel, 'gemini-3.6-flash');
    assert.equal(await fs.readFile(metadataFile, 'utf8'), oldV1, 'resolving settings must not rewrite metadata');

    // The old v2 default pair is independently handled when saving unchanged Settings.
    await fs.writeFile(metadataFile, JSON.stringify({
      version: 2,
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      fallbackModel: 'gemini-3.7-flash',
    }));
    const migrated = await saveLlmSettings({});
    assert.equal(migrated.model, 'gemini-3.8-flash');
    assert.equal(migrated.fallbackModel, 'gemini-3.6-flash');
    const saved = JSON.parse(await fs.readFile(metadataFile, 'utf8')) as { model: string; fallbackModel: string };
    assert.deepEqual({ model: saved.model, fallbackModel: saved.fallbackModel }, {
      model: 'gemini-3.8-flash',
      fallbackModel: 'gemini-3.6-flash',
    });

    const noFallback = await saveLlmSettings({ model: 'gemini-3.7-flash', fallbackModel: '' });
    assert.equal(noFallback.model, 'gemini-3.8-flash');
    assert.equal(noFallback.fallbackModel, '');

    const userModels = await saveLlmSettings({ model: 'models/custom-primary', fallbackModel: 'models/custom-secondary' });
    assert.equal(userModels.model, 'custom-primary');
    assert.equal(userModels.fallbackModel, 'custom-secondary');

    const aliased = await saveLlmSettings({ model: 'gemini-3.5-flash', fallbackModel: 'gemini-3.6-flash' });
    assert.equal(aliased.model, 'gemini-3.6-flash');
    assert.equal(aliased.fallbackModel, '', 'two API names for one backend do not provide fallback');

    const originalFetch = globalThis.fetch;
    try {
      let lookupCalls = 0;
      globalThis.fetch = (async (url: unknown, options?: RequestInit) => {
        lookupCalls += 1;
        assert.equal(String(url).endsWith('/models/gemini-3.8-flash'), true);
        assert.equal(options?.method, 'GET');
        return { ok: true, status: 200, text: async () => '{}' } as Response;
      }) as typeof fetch;
      const tested = await testGeminiConnection({ apiKey: 'synthetic-key-01234567890123456789', model: 'gemini-3.7-flash' });
      assert.equal(lookupCalls, 1);
      assert.equal(tested.model, 'gemini-3.8-flash');
      assert.match(tested.message, /model lookup succeeded/);
      assert.match(tested.message, /Live generation capacity was not tested/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    for (const name of envNames) {
      const before = previousEnv[name];
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
