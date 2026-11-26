import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppProfile } from '@kcs/shared';
import express from 'express';

test('the profile API normalizes the language and transfers it through export and import', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-language-profile-'));
  process.env.STHANG_STUDIO_STATE_ROOT = root;
  process.env.STHANG_STUDIO_ENV_FILE = path.join(root, 'absent.env');
  process.env.GEMINI_API_KEY = '';
  process.env.STHANG_CONTRIBUTION_ENDPOINT = '';
  process.env.STHANG_ANALYTICS_ENDPOINT = '';
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const { default: router } = await import('../apps/server/src/routes/profile.js');
  const app = express();
  app.use(express.json());
  app.use('/api/profile', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/profile`;
  const read = async (suffix = '', method = 'GET', body?: unknown): Promise<AppProfile> => {
    const response = await fetch(url + suffix, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  try {
    assert.equal(Object.hasOwn((await read()).preferences, 'interfaceLanguage'), false);
    for (const locale of ['en', 'km'] as const) {
      const saved = await read('', 'PATCH', { preferences: { interfaceLanguage: locale, waveformZoom: 3 } });
      assert.equal(saved.preferences.interfaceLanguage, locale);
      const exported = await read('/export');
      assert.equal(exported.preferences.interfaceLanguage, locale);
      for (const invalid of ['fr', '', null]) {
        const rejected = await read('', 'PATCH', { preferences: { interfaceLanguage: invalid } });
        assert.equal(Object.hasOwn(rejected.preferences, 'interfaceLanguage'), false);
        assert.equal(rejected.preferences.waveformZoom, 3);
      }
      const imported = await read('/import', 'POST', exported);
      assert.equal(imported.preferences.interfaceLanguage, locale);
      assert.equal((await read()).preferences.interfaceLanguage, locale);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
