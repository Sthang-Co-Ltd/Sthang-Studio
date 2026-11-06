import path from 'node:path';
import { parseSync } from 'vite';
import { webSourceIdentity } from './web-runtime-identity.mjs';

export const WORKSPACE_NAMES = ['WaveformEditor', 'ExportWorkspace', 'CaptionAppearanceWorkspace', 'RegenerationReviewDock'];
export const WORKSPACE_MANIFEST = '/studio-workspaces.json';
const retryKey = 'studio-retry';
const toolKey = 'studio-tool';
const origin = 'http://studio.invalid';
const normalize = (id) => id.replaceAll('\\', '/');
const sourceUrl = (name) => `/src/components/${name}.tsx`;

function closure(roots, imports) {
  const seen = new Set();
  const visit = (id) => { if (seen.has(id)) return; seen.add(id); for (const dep of imports(id)) visit(dep); };
  roots.forEach(visit);
  return seen;
}

function staticImports(code) {
  const parsed = parseSync('workspace.js', code);
  if (parsed.errors.length) throw new Error('Workspace source could not be parsed.');
  return parsed.program.body.flatMap((node) =>
    ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source ? [node.source] : []);
}

/** Fail closed if a future split introduces another unversioned lazy download. */
export function workspaceBuildManifest(bundle, buildId) {
  const chunks = Object.values(bundle).filter((item) => item.type === 'chunk');
  const initial = closure(chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName), (id) => bundle[id]?.imports || []);
  const tools = {};
  const entries = new Set();
  for (const name of WORKSPACE_NAMES) {
    const chunk = chunks.find((item) => item.moduleIds.some((id) => normalize(id).endsWith(sourceUrl(name))));
    if (!chunk || initial.has(chunk.fileName) || chunk.dynamicImports.length || chunk.imports.some((id) => !initial.has(id))) {
      throw new Error(`Deferred workspace ${name} must be a leaf outside the initial JavaScript graph.`);
    }
    if (!chunk.exports.includes(name)) throw new Error(`Deferred workspace ${name} must retain its public export.`);
    if (entries.has(chunk.fileName)) throw new Error('Each deferred workspace must keep its own download.');
    entries.add(chunk.fileName);
    const css = [];
    const visited = new Set();
    const visit = (item) => {
      if (visited.has(item.fileName)) return;
      visited.add(item.fileName);
      item.imports.forEach((id) => visit(bundle[id]));
      for (const file of item.viteMetadata?.importedCss || []) if (!css.includes(`/${file}`)) css.push(`/${file}`);
    };
    visit(chunk);
    tools[name] = { entry: `/${chunk.fileName}`, css };
  }
  return { buildId, tools };
}

export function workspaceRetryPlugin(sourceRoot) {
  const webRoot = normalize(path.join(sourceRoot, 'apps/web'));
  const buildId = webSourceIdentity(sourceRoot).buildId;
  let assignment;
  function group(id, ctx) {
    if (!assignment) {
      const imports = (key) => ctx.getModuleInfo(key)?.importedIds || [];
      const eager = closure([`${webRoot}/index.html`, `${webRoot}/src/main.tsx`], imports);
      assignment = new Map([...eager].map((key) => [key, 'studio-core']));
      for (const name of WORKSPACE_NAMES) {
        for (const key of closure([`${webRoot}${sourceUrl(name)}`], imports)) {
          if (eager.has(key)) continue;
          const previous = assignment.get(key);
          if (previous && previous !== name) throw new Error('A new shared lazy dependency needs an explicit workspace loading decision.');
          assignment.set(key, name);
        }
      }
    }
    // Leave tool entries to Vite so their native named exports are retained.
    // Pin the eager closure together; otherwise a shared icon can be split out
    // into a previously unrequested dependency of several optional tools.
    return assignment.get(normalize(id)) === 'studio-core' ? 'studio-core' : undefined;
  }
  return {
    name: 'studio-workspace-retry',
    config() {
      return {
        define: { __STUDIO_WEB_BUILD_ID__: JSON.stringify(buildId) },
        build: { rolldownOptions: { output: { minifyInternalExports: false, codeSplitting: {
          groups: [{ name: group, debugName: 'studio-workspace-leaves', includeDependenciesRecursively: false }],
        } } } },
      };
    },
    generateBundle(_options, bundle) {
      const manifest = workspaceBuildManifest(bundle, buildId);
      this.emitFile({ type: 'asset', fileName: WORKSPACE_MANIFEST.slice(1), source: JSON.stringify(manifest) });
    },
    configureServer(server) {
      let graphPromise;
      server.watcher.on('change', () => { graphPromise = undefined; });
      const graph = () => graphPromise ||= (async () => {
        const modules = new Map();
        async function visit(url) {
          if (modules.has(url)) return;
          if (modules.size > 600) throw new Error('Workspace module graph exceeded its bound.');
          modules.set(url, { code: '', imports: [] });
          const transformed = await server.transformRequest(url);
          if (!transformed) throw new Error('Workspace module is unavailable.');
          const imports = staticImports(transformed.code).map((node) => {
            const resolved = new URL(node.value, `${origin}${url}`);
            if (resolved.origin !== origin) throw new Error('Workspace imports must stay local.');
            return { start: node.start, end: node.end, url: `${resolved.pathname}${resolved.search}` };
          });
          modules.set(url, { code: transformed.code, imports });
          for (const dep of imports) await visit(dep.url);
        }
        await visit('/src/main.tsx');
        const eager = new Set(modules.keys());
        const tools = {};
        const owners = new Map();
        for (const name of WORKSPACE_NAMES) {
          await visit(sourceUrl(name));
          const privateModules = closure([sourceUrl(name)], (url) => eager.has(url) ? [] : modules.get(url).imports.map((dep) => dep.url));
          for (const url of privateModules) {
            if (eager.has(url)) { privateModules.delete(url); continue; }
            if (owners.has(url)) throw new Error('Shared lazy development modules need an explicit loading decision.');
            owners.set(url, name);
          }
          tools[name] = privateModules;
        }
        return { modules, tools };
      })().catch((error) => { graphPromise = undefined; throw error; });
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', origin);
        if (url.pathname !== WORKSPACE_MANIFEST && !url.searchParams.has(retryKey)) return next();
        if (!['GET', 'HEAD'].includes(req.method || '')) { res.statusCode = 405; res.end(); return; }
        try {
          if (url.pathname === WORKSPACE_MANIFEST) {
            await graph();
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({ buildId, tools: Object.fromEntries(WORKSPACE_NAMES.map((name) => [name, { entry: sourceUrl(name), css: [] }])) }));
            return;
          }
          const attempt = url.searchParams.get(retryKey);
          const tool = url.searchParams.get(toolKey);
          if (!/^[a-f0-9-]{36}$/.test(attempt || '') || !WORKSPACE_NAMES.includes(tool)) throw new Error('Invalid workspace retry.');
          url.searchParams.delete(retryKey); url.searchParams.delete(toolKey);
          const canonical = `${url.pathname}${url.search}`;
          const { modules, tools } = await graph();
          if (!tools[tool].has(canonical)) throw new Error('Unknown workspace retry module.');
          const module = modules.get(canonical);
          let code = module.code;
          // Transform the canonical source once: Vite's CSS style ID and HMR
          // ownership stay canonical even though the module URL is fresh.
          for (const dep of [...module.imports].reverse()) {
            if (!tools[tool].has(dep.url)) continue;
            const target = new URL(dep.url, origin);
            target.searchParams.set(retryKey, attempt); target.searchParams.set(toolKey, tool);
            code = code.slice(0, dep.start) + JSON.stringify(`${target.pathname}${target.search}`) + code.slice(dep.end);
          }
          res.setHeader('Content-Type', 'text/javascript');
          res.setHeader('Cache-Control', 'no-store');
          res.end(req.method === 'HEAD' ? undefined : code);
        } catch {
          res.statusCode = 503; res.setHeader('Cache-Control', 'no-store'); res.end('Workspace download is unavailable.');
        }
      });
    },
  };
}
