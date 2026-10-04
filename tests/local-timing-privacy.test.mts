import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../apps/server/src/config.js';
import { alignTimingLocally } from '../apps/server/src/services/local-timing.js';

test('persistent and recovery timing processes start with telemetry disabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-timing-privacy-'));
  const entry = path.join(root, 'fake-worker.cjs');
  const observations = path.join(root, 'startup.jsonl');
  const original = { localTimingPython: config.localTimingPython, localTimingWorker: config.localTimingWorker, cacheDir: config.cacheDir };
  const flags = ['ORT_DISABLE_TELEMETRY', 'HF_HUB_DISABLE_TELEMETRY', 'DO_NOT_TRACK'];
  const originalEnvironment = flags.map((name) => process.env[name]);
  try {
    for (const name of flags) process.env[name] = '0';
    await fs.writeFile(entry, `
const fs = require('node:fs');
const flags = ${JSON.stringify(flags)};
const server = process.argv.includes('--server');
fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({
  mode: server ? 'persistent' : 'recovery',
  flags: Object.fromEntries(flags.map(name => [name, process.env[name]])),
}) + '\\n');
if (server) process.exit(2); // Exercise the actual transport-failure recovery path.
const output = process.argv[process.argv.indexOf('--output') + 1];
fs.writeFileSync(output, JSON.stringify({
  transcript: 'hello', words: [{ text: 'hello', startMs: 0, endMs: 500 }],
  engine: 'kfa-local', model: 'synthetic-privacy-fixture', directAlignment: true,
}));
`);
    config.localTimingPython = process.execPath;
    config.localTimingWorker = entry;
    config.cacheDir = path.join(root, 'cache');
    const audio = path.join(root, 'synthetic.wav');
    await fs.writeFile(audio, Buffer.alloc(44));
    const result = await alignTimingLocally(audio, path.join(root, 'work'), 'hello', 'privacy-fixture');
    assert.equal(result.provider, 'local');
    const entries = (await fs.readFile(observations, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((item) => item.mode), ['persistent', 'recovery']);
    for (const item of entries) {
      assert.deepEqual(item.flags, Object.fromEntries(flags.map((name) => [name, '1'])));
    }
    for (const name of flags) assert.equal(process.env[name], '0', 'child policy must not mutate parent environment');
  } finally {
    Object.assign(config, original);
    flags.forEach((name, index) => {
      if (originalEnvironment[index] === undefined) delete process.env[name];
      else process.env[name] = originalEnvironment[index];
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});
