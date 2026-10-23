import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseSync } from 'vite';

const defaultEntries = ['scripts/benchmark-project-loading.mts', 'benchmarks/project-loading/cold-library-child.mts'];
const defaultMetadata = ['package-lock.json', 'package.json', 'apps/server/package.json',
  'packages/shared/package.json', 'packages/shared/tsconfig.json'];
export interface SourceBinding {
  schemaVersion: 2;
  sourceSha256: Record<string, string>;
  runtimeArtifactSha256: Record<string, string>;
  localImports: Record<string, string[]>;
}
interface BindingOptions { entries?: readonly string[]; metadata?: readonly string[] }

/** Bind literal local runtime imports, including integration-only dependencies.
 * External package versions remain pinned by package-lock.json. The shared
 * workspace's source AND executed compiled JS are bound separately.
 */
export async function captureProjectLoadingSourceBinding(repository: string, options: BindingOptions = {}): Promise<SourceBinding> {
  const root = await fs.realpath(repository);
  const sources = new Map<string, string>(), artifacts = new Map<string, string>();
  const localImports = new Map<string, string[]>(), visited = new Set<string>();
  const relative = (file: string) => {
    const name = path.relative(root, file);
    if (!name || path.isAbsolute(name) || name === '..' || name.startsWith(`..${path.sep}`)) throw new Error('Measured source escaped its repository.');
    return name.split(path.sep).join('/');
  };
  async function read(file: string) {
    const name = relative(file);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw new Error(`Measured source must be a regular repository file: ${name}`);
    const bytes = await fs.readFile(file);
    const target = name.startsWith('packages/shared/dist/') ? artifacts : sources;
    target.set(name, createHash('sha256').update(bytes).digest('hex'));
    return bytes.toString('utf8');
  }
  async function resolveLocal(importer: string, specifier: string) {
    if (specifier.includes('?') || specifier.includes('#')) throw new Error('Measured local import has unsupported resolution syntax.');
    const base = path.resolve(path.dirname(importer), specifier);
    relative(base);
    const extension = path.extname(base);
    const alternatives = extension === '.js' ? [base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx']
      : extension === '.mjs' ? [base.slice(0, -4) + '.mts']
      : extension === '.cjs' ? [base.slice(0, -4) + '.cts']
      : extension ? [] : ['.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.js'].map((suffix) => base + suffix);
    for (const candidate of [base, ...alternatives]) {
      if (await fs.lstat(candidate).then((stat) => stat.isFile() || stat.isSymbolicLink(), (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      })) return candidate;
    }
    throw new Error(`Measured local import is missing: ${relative(importer)} -> ${specifier}`);
  }
  async function visit(file: string): Promise<void> {
    const name = relative(file);
    if (visited.has(name)) return;
    visited.add(name);
    const text = await read(file);
    if (file.endsWith('.json')) return;
    const extension = path.extname(file);
    const lang = extension === '.tsx' ? 'tsx' : /\.(?:ts|mts|cts)$/.test(extension) ? 'ts' : extension === '.jsx' ? 'jsx' : 'js';
    const parsed = parseSync(file, text, { lang, sourceType: 'module' });
    if (parsed.errors.length) throw new Error(`Cannot parse measured source: ${name}`);
    const specifiers: string[] = [];
    function walk(value: unknown) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const node = value as Record<string, unknown>;
      if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
        const typeOnly = node.importKind === 'type' || node.exportKind === 'type'
          || (Array.isArray(node.specifiers) && node.specifiers.length > 0 && node.specifiers.every((entry) => entry.importKind === 'type' || entry.exportKind === 'type'));
        const source = node.source as { value?: unknown } | undefined;
        if (!typeOnly && typeof source?.value === 'string') specifiers.push(source.value);
      } else if (node.type === 'ImportExpression') {
        const source = node.source as { type?: string; value?: unknown } | undefined;
        if (source?.type !== 'Literal' || typeof source.value !== 'string') throw new Error(`Cannot bind nonliteral dynamic import in ${name}`);
        specifiers.push(source.value);
      }
      Object.values(node).forEach(walk);
    }
    walk(parsed.program);
    const dependencies = new Set<string>();
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const dependency = await resolveLocal(file, specifier);
        dependencies.add(relative(dependency)); await visit(dependency);
      } else if (specifier === '@kcs/shared') {
        const manifestFile = path.join(root, 'packages/shared/package.json');
        const manifest = JSON.parse(await read(manifestFile));
        if (manifest.name !== '@kcs/shared' || typeof manifest.main !== 'string') throw new Error('Shared workspace entry is unresolved.');
        for (const dependency of [path.join(root, 'packages/shared/src/index.ts'), path.resolve(path.dirname(manifestFile), manifest.main)]) {
          dependencies.add(relative(dependency)); await visit(dependency);
        }
      } else if (specifier.startsWith('@kcs/')) {
        throw new Error(`Unbound local workspace import in ${name}`);
      }
    }
    localImports.set(name, [...dependencies].sort());
  }
  for (const file of options.metadata ?? defaultMetadata) await read(path.resolve(root, file));
  for (const file of options.entries ?? defaultEntries) await visit(path.resolve(root, file));
  const sorted = <T,>(values: Map<string, T>) => Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b, 'en')));
  return { schemaVersion: 2, sourceSha256: sorted(sources), runtimeArtifactSha256: sorted(artifacts), localImports: sorted(localImports) };
}

export async function verifyProjectLoadingSourceBinding(repository: string, expected: SourceBinding, options: BindingOptions = {}) {
  const actual = await captureProjectLoadingSourceBinding(repository, options);
  assert.deepEqual(actual, expected, 'Measured source, runtime artifacts or local dependency graph changed during measurement.');
}
