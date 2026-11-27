import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { CAPTION_LOOKS } from '@kcs/shared';
import { looksMessages } from '../apps/web/src/i18n/messages/en/looks.js';
import { serverMessages } from '../apps/web/src/i18n/messages/en/server.js';
import { settingsMessages } from '../apps/web/src/i18n/messages/en/settings.js';
import { systemMessages } from '../apps/web/src/i18n/messages/en/system.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const readSource = (file: string) => readFileSync(new URL(file, new URL('../', import.meta.url)), 'utf8');
const productionSources = (patterns: string[]) => globSync(patterns, { cwd: root, exclude: [
  'apps/web/src/i18n/**', '**/tests/**', '**/__tests__/**', '**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx',
] }).map((file) => readSource(file.replaceAll('\\', '/')));

const server = productionSources(['apps/server/src/**/*.ts']);
const web = productionSources(['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx']);
const shared = productionSources(['packages/shared/src/**/*.ts']);
const doctor = readSource('apps/server/src/services/doctor.ts');
const drift = (key: string) => `${key}: server wording changed. Update the mapping or catalog.`;

function hasLiteral(sources: string[], value: string) {
  return sources.some((source) => ['\'', '"', '`'].some((quote) => source.includes(`${quote}${value}${quote}`)));
}

const applyModes = { applyRegeneration: 'all', applyRegenerationText: 'text-only', applyRegenerationTiming: 'timing-only' };

test('Exact-match server labels still agree with production source', async (t) => {
  for (const namespace of ['historyLabel', 'candidateLabel', 'selectedCandidateReason'] as const) {
    for (const [label, value] of Object.entries(serverMessages[namespace])) {
      if (namespace === 'historyLabel' && Object.hasOwn(applyModes, label)) continue;
      const key = `server.${namespace}.${label}`;
      await t.test(key, () => assert.ok(hasLiteral([...server, ...web], value), drift(key)));
    }
  }
});

test('Regeneration checkpoint labels agree with the template and all non-reject apply modes', async (t) => {
  const source = readSource('apps/server/src/services/project-processing.ts');
  const template = '`Before applying regeneration (${mode})`';
  const sharedSource = readSource('packages/shared/src/index.ts');
  const union = /\btype\s+RegenerationApplyMode\s*=\s*([^;]+);/.exec(sharedSource)?.[1];
  const modes = union?.split('|').map((member) => /^['"]([^'"]+)['"]$/.exec(member.trim())?.[1]);
  const keys = Object.keys(applyModes).map((label) => `server.historyLabel.${label}`).join(', ');
  assert.deepEqual(new Set(modes?.filter((mode) => mode !== 'reject')), new Set(Object.values(applyModes)), drift(keys));
  for (const [label, mode] of Object.entries(applyModes)) {
    const key = `server.historyLabel.${label}`;
    await t.test(key, () => {
      assert.ok(source.includes(template), drift(key));
      assert.equal(serverMessages.historyLabel[label as keyof typeof applyModes],
        template.slice(1, -1).replace('${mode}', mode), drift(key));
    });
  }
});

test('Job stage and History source codes still occur in production source', async (t) => {
  for (const namespace of ['stage', 'historySource'] as const) {
    for (const code of Object.keys(serverMessages[namespace])) {
      const key = `server.${namespace}.${code}`;
      await t.test(key, () => assert.ok(hasLiteral([...server, ...shared], code), drift(key)));
    }
  }
});

test('Look catalog keys and English labels match the shared recipes', () => {
  assert.deepEqual(new Set(Object.keys(looksMessages)), new Set(CAPTION_LOOKS.map(({ id }) => id)), drift('looks.*'));
  for (const { id, label } of CAPTION_LOOKS) assert.equal(looksMessages[id], label, drift(`looks.${id}`));
});

test('Doctor catalog IDs still occur as check IDs in the doctor', async (t) => {
  const calls = [...doctor.matchAll(/\bcheck\(\s*(['"])([\w-]+)\1/g)].map((match) => match[2]);
  const directoryLoop = /for \(const \[id, label, dir\] of \[([\s\S]*?)\] as const\)/.exec(doctor)?.[1] ?? '';
  const directories = [...directoryLoop.matchAll(/\[\s*(['"])([\w-]+)\1\s*,/g)].map((match) => match[2]);
  const ids = new Set([...calls, ...directories]);
  for (const id of Object.keys(systemMessages.check)) {
    const key = `system.check.${id}`;
    await t.test(key, () => assert.ok(ids.has(id), drift(key)));
  }
});

test('Doctor timing-fix wording matches localTimingSetupFix on each platform', async (t) => {
  // Evaluate the helper's return expression without loading server configuration.
  const expression = /\bfunction localTimingSetupFix\([^\n]*\): string\s*\{\s*return ([\s\S]*?);\s*\}/.exec(doctor)?.[1];
  for (const [name, expected] of Object.entries(systemMessages.timingFix)) {
    const key = `system.timingFix.${name}`;
    await t.test(key, () => {
      assert.ok(expression, drift(key));
      const platform = name === 'other' ? 'linux' : name;
      const actual: unknown = runInNewContext(`(${expression})`, { platform }, { timeout: 100 });
      assert.equal(actual, expected, drift(key));
    });
  }
});

test('Secure-storage English labels still occur in server source', async (t) => {
  for (const [name, label] of Object.entries(settingsMessages.secureStorage)) {
    const key = `settings.secureStorage.${name}`;
    await t.test(key, () => assert.ok(hasLiteral(server, label), drift(key)));
  }
});
