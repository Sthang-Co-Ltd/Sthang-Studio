// Opt in on Windows with the reviewed workspace build and a locally installed KFA runtime.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { chromium, type Page, type Response } from '@playwright/test';
import { compileHighlightPlan, hydrateCaptionWordTimings, normalizeCaptionAppearance, planCaptionRenderStates, type CaptionProject, type CaptionSegment, type Coverage } from '@kcs/shared';
import { affectedHighlightIds, classifyHighlightTargets } from '../apps/web/src/word-highlight-apply.js';

assert.equal(process.env.STHANG_QUALIFY_WORD_HIGHLIGHT, '1', 'Explicit opt-in is required.');
assert.equal(process.platform, 'win32', 'Use the Windows qualification host.');
const owner = await fs.realpath(process.env.STHANG_QUALIFY_SOURCE_ROOT!);
const ids = process.argv.slice(2);
assert.equal(ids.length, 2, 'Provide two project IDs.');
assert.ok(ids.every((id) => /^[\w-]+$/.test(id)) && new Set(ids).size === 2);
const repo = await fs.realpath(fileURLToPath(new URL('..', import.meta.url)));
const python = await fs.realpath(process.env.LOCAL_TIMING_PYTHON!);
const scratch = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'studio-word-highlight-product-'));
for (const protectedRoot of [repo, owner]) {
  const relative = path.relative(protectedRoot, scratch);
  assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Scratch must be outside all source roots.');
}
console.log('Scratch evidence directory', scratch);
const json = async <T,>(filename: string): Promise<T> => JSON.parse(await fs.readFile(filename, 'utf8'));
const projectFile = (root: string, id: string) => path.join(root, 'data', 'projects', id + '.json');
const cacheFiles = (id: string) => ['normalized.wav', 'audio-meta.json'].map((name) => path.join('data', 'cache', id, name));
const originals = await Promise.all(ids.map((id) => json<CaptionProject>(projectFile(owner, id))));
assert.ok(originals.every((project, index) => project.id === ids[index] && /^(?!\.)[^\\/:]+\.mp4$/i.test(project.media.filename)));
const sourceFiles = originals.flatMap(({ id, media }) => [
  path.relative(owner, projectFile(owner, id)), path.join('uploads', media.filename), ...cacheFiles(id),
]);

async function fileHash(filename: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

const originalHashes = await Promise.all([...sourceFiles.map((file) => path.join(owner, file)), python].map(fileHash));
const snapshot = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const serverEntry = path.join(repo, 'apps', 'server', 'dist', 'index.js');
const webRoot = path.join(repo, 'apps', 'web', 'dist');
const binding = { snapshot, node: process.version, icu: process.versions.icu,
  serverEntryHash: await fileHash(serverEntry), webHtmlHash: await fileHash(path.join(webRoot, 'index.html')),
  workerHash: await fileHash(path.join(repo, 'local-timing', 'worker.py')),
  sourceHashes: originalHashes.slice(0, -1).map((hash, index) => ({ file: sourceFiles[index], hash })), pythonHash: originalHashes.at(-1) };

async function ephemeralPort() {
  const handle = net.createServer().listen(0, '127.0.0.1');
  await once(handle, 'listening');
  const address = handle.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => handle.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function createState(cohort: 'fresh' | 'stored') {
  const root = path.join(scratch, cohort);
  for (const file of sourceFiles) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(owner, file), target);
  }
  for (const project of originals) {
    const copy = { ...project, wordHighlightFollow: undefined,
      captionAppearance: { ...project.captionAppearance, highlightMode: 'word' },
      ...(cohort === 'fresh' ? {
        transcriptNeedsSync: true,
        captions: project.captions.map(({ wordTiming: _track, ...caption }) => caption),
      } : {}),
    };
    await fs.writeFile(projectFile(root, project.id), JSON.stringify(copy), 'utf8');
  }
  return root;
}

async function openProject(page: Page, origin: string, project: CaptionProject) {
  await page.goto(origin);
  await page.evaluate(() => {
    // Existing onboarding guards, local to this empty browser profile.
    localStorage.setItem('sthang:project-guide-seen:v1', '1');
  });
  // Studio opens AI settings once per load when the scratch account has no key.
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(project.title.replace(/[.*+?^$\x7B\x7D()|[\]\\]/g, '\\$&')) }).first().click();
  await page.locator('.media-stage video').waitFor();
  await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('region', { name: 'Word highlight results' }).waitFor();
}

function describe(project: CaptionProject) {
  const counts: Record<Coverage, number> = { 'full-individual': 0, 'full-with-groups': 0, partial: 0, none: 0 };
  const rows = project.captions.map((caption) => {
    const plan = compileHighlightPlan(caption, 'measured-and-manual');
    if (plan.spokenUnits) counts[plan.coverage]++;
    return { caption, plan };
  });
  return { counts, rows, painted: rows.filter(({ plan }) => plan.spans.length).length };
}

const notes: Array<{ project: string; caption: CaptionSegment; plan: ReturnType<typeof compileHighlightPlan> }> = [];
const results: unknown[] = [];
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
try {
  for (const cohort of ['fresh', 'stored'] as const) {
    const root = await createState(cohort);
    const port = await ephemeralPort();
    const origin = 'http://127.0.0.1:' + port;
    const activation = randomUUID();
    const localAppData = path.join(root, 'LocalAppData');
    const kfaModel = path.join('kfa', 'wav2vec2-km-base-1500.onnx');
    await fs.mkdir(path.join(localAppData, 'kfa'), { recursive: true });
    // The pinned KFA wheel otherwise downloads the model at import if absent.
    // Studio also resolves Windows credential storage relative to LOCALAPPDATA.
    await fs.copyFile(path.join(process.env.LOCALAPPDATA!, kfaModel), path.join(localAppData, kfaModel));
    // Keep credentials out of the child and disable every configured online service.
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/(API_KEY|TOKEN|PASSWORD|SECRET|NODE_OPTIONS)/i.test(key)));
    const child = spawn(process.execPath, [serverEntry], { cwd: repo, windowsHide: true, env: {
      ...env, LOCALAPPDATA: localAppData, PORT: String(port), WEB_ORIGIN: origin, STHANG_STUDIO_STATE_ROOT: root,
      STHANG_STUDIO_WEB_ROOT: webRoot, STHANG_STUDIO_ENV_FILE: path.join(root, 'absent.env'),
      STHANG_STUDIO_ACTIVATION_ID: activation, LOCAL_TIMING_PYTHON: python,
      LOCAL_KFA_ENABLED: '1', LOCAL_WHISPER_FALLBACK_ENABLED: '0',
      STHANG_CONTRIBUTION_ENDPOINT: 'disabled', STHANG_ANALYTICS_ENDPOINT: 'disabled',
      DOTENV_CONFIG_QUIET: 'true', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
      PYTHONDONTWRITEBYTECODE: '1', NUMBA_CACHE_DIR: path.join(root, 'numba'),
      UPDATE_MANIFEST_URL: '',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverReady = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (String(chunk).includes('Sthang Studio API')) serverReady = true;
    });
    child.stderr.resume();
    try {
      for (let check = 0; !serverReady && child.exitCode === null && check < 120; check++) await delay(250);
      assert.ok(serverReady && child.pid, 'The owned production entry point did not start.');
      const healthResponse = await fetch(origin + '/api/health');
      assert.equal(healthResponse.headers.get('x-sthang-studio-activation'), activation);
      const webResponse = await fetch(origin);
      assert.equal(webResponse.status, 200);
      assert.equal(createHash('sha256').update(Buffer.from(await webResponse.arrayBuffer())).digest('hex'), binding.webHtmlHash);
      const health = await healthResponse.json();
      assert.equal(health.llm.configured, false);
      assert.equal(health.llm.keySource, 'none');
      assert.equal(health.timing.configured, true);
      assert.equal(health.timing.fallbackEngine, null);
      assert.deepEqual(health.cloudConfiguration, { contributionConfigured: false, analyticsConfigured: false });
      for (const source of originals) {
        const project = hydrateCaptionWordTimings(await json<CaptionProject>(projectFile(root, source.id)));
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        let prepares = 0;
        const requested = new Set<string>();
        const dispositions = new Map(classifyHighlightTargets(project.captions).dispositions);
        const requests: Array<{ intent: string; requestId: string; keys: number }> = [];
        const keysById = new Map<string, string>();
        const responseTasks = new Set<Promise<void>>();
        const previewReplies: Response[] = [];
        const previewAborts: Array<{ timesMs: number[]; aborted: boolean }> = [];
        const previewUrl = origin + '/api/video-export/' + project.id + '/preview';
        await context.route('**/*', (route) => {
          const url = new URL(route.request().url());
          return url.origin === origin && !url.pathname.startsWith('/api/updates') ? route.continue() : route.abort();
        });
        page.on('response', (response) => {
          if (response.url() === previewUrl) {
            previewReplies.push(response);
            if (previewReplies.length > 24) previewReplies.shift();
          }
          if (!response.url().startsWith(origin + '/api/projects/' + project.id + '/caption-word-timing/')) return;
          if (response.url().endsWith('/candidates')) {
            const ids = response.request().postDataJSON().ids as string[];
            ids.forEach((id) => requested.add(id));
            const task = response.json().then(({ results }) => {
              for (const row of results ?? []) {
                dispositions.set(row.id, row.status);
                if (row.preparedKey) keysById.set(row.id, row.preparedKey);
              }
            });
            responseTasks.add(task);
            void task.catch(() => {});
          }
        });
        page.on('requestfailed', (request) => {
          if (request.url() !== previewUrl) return;
          const { timesMs } = request.postDataJSON();
          previewAborts.push({ timesMs, aborted: request.failure()?.errorText === 'net::ERR_ABORTED' });
          if (previewAborts.length > 24) previewAborts.shift();
        });
        page.on('request', (request) => {
          if (!request.url().startsWith(origin + '/api/projects/' + project.id + '/caption-word-timing/')) return;
          if (request.url().endsWith('/prepare')) prepares++;
          if (!request.url().endsWith('/batch-apply')) return;
          const body = request.postDataJSON();
          assert.equal(body.mode, 'prepared');
          requests.push({ intent: body.intent, requestId: body.requestId, keys: body.preparedKeys.length });
        });
        try {
          await openProject(page, origin, project);
          const controls = page.getByRole('region', { name: 'Word highlight results' });
          const history = async () => await (await fetch(origin + '/api/projects/' + project.id + '/history')).json();
          const historyBefore = await history();
          const start = performance.now();
          const response = page.waitForResponse((item) => item.url().endsWith('/batch-apply') && item.request().method() === 'POST', { timeout: 90_000 });
          // The On appearance was present on entry, without an armed follow epoch.
          await controls.getByRole('button', { name: 'Apply to all captions', exact: true }).click();
          const publication = await response;
          const wallMs = Math.round(performance.now() - start);
          assert.equal(publication.status(), 200);
          const accepted = await publication.json();
          await controls.getByRole('button', { name: 'Undo', exact: true }).waitFor();
          await Promise.all(responseTasks);
          const persisted = await json<CaptionProject>(projectFile(root, source.id));
          assert.ok(isDeepStrictEqual(persisted.captions, accepted.project.captions), 'Apply acknowledgement and durable captions differ.');
          const hydrated = hydrateCaptionWordTimings(persisted);
          const summary = describe(hydrated);
          const historyAfter = await history();
          const unattempted = project.captions.filter(({ id }) => !dispositions.has(id));
          const dispositionCounts = Object.fromEntries([...new Set(dispositions.values())].map((status) =>
            [status, [...dispositions.values()].filter((value) => value === status).length]));
          const row = { cohort, id: project.id, count: project.captions.length, ...summary.counts, painted: summary.painted,
            unattempted: unattempted.length, dispositionCounts, uniqueRequested: requested.size, newTracks: accepted.appliedCount,
            historyEntries: historyAfter.length - historyBefore.length, prepares, wallMs, pid: child.pid };
          results.push(row);
          console.log(JSON.stringify(row));
          await fs.writeFile(path.join(scratch, cohort + '-' + project.id + '-captions.json'), JSON.stringify(summary.rows), 'utf8');
          assert.deepEqual(unattempted.map(({ id }) => id), [], 'Every caption must be accounted for.');
          assert.equal(requests.length, 1);
          assert.equal(requests[0].keys, keysById.size);
          assert.equal(prepares, 1);
          assert.equal(row.historyEntries, 1);
          assert.equal(historyAfter[0].label, 'Before applying word highlights');
          assert.ok(summary.painted > 0);
          if (cohort === 'fresh') {
            for (const { caption, plan } of summary.rows) notes.push({ project: source.id, caption, plan });
          }

          const sample = summary.rows.find(({ plan }) => plan.spans.length && plan.coverage === 'full-individual')!;
          const sampleAt = (sample.plan.spans[0].startMs + sample.plan.spans[0].endMs) / 2;
          const appearance = normalizeCaptionAppearance(hydrated.captionAppearance);
          const sampleState = planCaptionRenderStates(hydrated.captions, true, appearance)
            .find(({ atMs, endMs }) => atMs <= sampleAt && sampleAt < endMs);
          assert.ok(sampleState?.paintKey && sampleState.activeWordOffsets?.some(({ captionIndex, startOffset, endOffset }) =>
            hydrated.captions[captionIndex].id === sample.caption.id
            && startOffset === sample.plan.spans[0].startOffset && endOffset === sample.plan.spans[0].endOffset));
          const samplePaint = async (phase: 'after-apply' | 'after-reload') => {
            const observations: Record<string, unknown> = { phase, sampleAt, key: sampleState.paintKey, frameAt: sampleState.atMs };
            Object.assign(row, { lastPaintProbe: observations });
            await page.locator('video').evaluate((video: HTMLVideoElement, time: number) => { video.pause(); video.currentTime = time / 1_000; }, sampleAt);
            await page.waitForFunction((ms) => {
              const video = document.querySelector('video');
              return video?.paused && !video.seeking && Math.abs(video.currentTime * 1_000 - ms) < 1;
            }, sampleAt);
            const image = page.locator(`.native-caption-surface[data-preview-mode="exact"][data-paint-key="${sampleState.paintKey}"] img`);
            try {
              await image.waitFor();
            } catch (error) {
              observations.client = await page.evaluate(() => {
                const media = document.querySelector<HTMLVideoElement>('.media-stage video');
                const surface = document.querySelector('.native-caption-surface');
                return {
                  media: media && { timeMs: media.currentTime * 1000, readyState: media.readyState, paused: media.paused,
                    seeking: media.seeking, width: media.videoWidth, height: media.videoHeight,
                    clientWidth: media.clientWidth, clientHeight: media.clientHeight },
                  mode: surface?.getAttribute('data-preview-mode'), key: surface?.getAttribute('data-paint-key'),
                  preparing: Boolean(document.querySelector('.native-preview-status')),
                  previewError: Boolean(document.querySelector('.native-preview-status.error')),
                };
              });
              observations.replies = await Promise.all(previewReplies.map(async (response) => {
                const { captions, timesMs } = response.request().postDataJSON();
                const frames = response.ok() ? await response.json().then((body) => body.frames as Array<{ atMs: number; png: string }>).catch(() => []) : [];
                return { status: response.status(), cueCount: captions.length, timesMs,
                  frames: frames.map(({ atMs, png }) => ({ atMs, bytes: png.length })) };
              }));
              observations.failedRequests = previewAborts.slice();
              throw error;
            }
            const pixels = await image.getAttribute('src');
            assert.ok(pixels?.startsWith('data:image/png;base64,'));
            const hash = createHash('sha256').update(pixels).digest('hex');
            observations.presented = true;
            return hash;
          };
          const paintBefore = await samplePaint('after-apply');
          Object.assign(row, { clientPresentation: { sampleAt, key: sampleState.paintKey, afterApply: paintBefore } });
          const toggle = controls.locator('..').getByRole('button', { name: 'Highlight spoken word' });
          await toggle.click();
          await page.getByText(/Word highlighting.*Off/, { exact: false }).first().waitFor();
          await page.waitForFunction(() => document.querySelector('.appearance-word-details button[aria-pressed]')?.getAttribute('aria-pressed') === 'false');
          for (let retry = 0; retry < 20 && (await json<CaptionProject>(projectFile(root, source.id))).wordHighlightFollow?.enabled; retry++) await delay(50);
          assert.equal((await json<CaptionProject>(projectFile(root, source.id))).wordHighlightFollow?.enabled, false);
          const armedAgain = page.waitForResponse((response) => response.url().endsWith('/word-highlight-follow')
            && response.request().postDataJSON().action === 'arm' && response.ok());
          await toggle.click();
          await armedAgain;
          await controls.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden' });
          await controls.getByRole('button', { name: 'Undo', exact: true }).waitFor();
          assert.equal(requests.length, 1, 'An identical Apply submitted another publication.');
          assert.equal((await history()).length, historyAfter.length);
          Object.assign(row, { repeatApply: 'no publication or checkpoint' });

          await openProject(page, origin, project);
          const reloadedPaint = await samplePaint('after-reload');
          assert.equal(reloadedPaint, paintBefore, 'Exact native preview pixels changed after reload.');
          Object.assign(row, { reload: 'same exact preview pixels',
            clientPresentation: { sampleAt, key: sampleState.paintKey, afterApply: paintBefore, afterReload: reloadedPaint } });

          const changed = persisted.captions.find((caption) => !caption.timingLocked && caption.wordTiming?.evidence === 2
            && compileHighlightPlan(caption, 'measured-and-manual').coverage === 'full-individual')!;
          const edit = page.locator(`[data-caption-id="${changed.id}"] textarea`);
          const saveResponse = page.waitForResponse((item) => new URL(item.url()).pathname === '/api/projects/' + source.id + '/captions'
            && item.request().method() === 'PUT' && item.ok()
            && (item.request().postDataJSON().captions as CaptionSegment[]).some(({ id, text }) => id === changed.id && text === changed.text + '!'));
          const followResponse = page.waitForResponse((item) => item.url().endsWith('/batch-apply')
            && item.request().postDataJSON().intent === 'follow' && item.ok(), { timeout: 45_000 });
          await edit.fill(changed.text + '!');
          await edit.press('Tab');
          const beforeFollow = (await (await saveResponse).json()).project as CaptionProject;
          const follow = await (await followResponse).json();
          const afterEdit = await json<CaptionProject>(projectFile(root, source.id));
          const affected = affectedHighlightIds(hydrated.captions, beforeFollow.captions);
          const unaffected = (captions: CaptionSegment[]) => captions.filter(({ id }) => !affected.includes(id));
          // A normal save can persist the editor's existing hydration of an
          // older project. Its acknowledgement is the pre-follow write basis.
          const hydratedWire = JSON.parse(JSON.stringify(hydrated.captions)) as CaptionSegment[];
          assert.ok(isDeepStrictEqual(unaffected(beforeFollow.captions), unaffected(hydratedWire)),
            'The normal save changed unrelated captions beyond legacy hydration.');
          assert.ok(isDeepStrictEqual(unaffected(afterEdit.captions), unaffected(beforeFollow.captions)),
            'Follow changed a caption outside the affected set.');
          assert.ok(follow.appliedCount > 0 && follow.applied.every(({ id }: { id: string }) => affected.includes(id)));
          assert.equal(afterEdit.captions.find(({ id }) => id === changed.id)?.text, changed.text + '!');
          assert.ok(isDeepStrictEqual(afterEdit.captions, follow.project.captions), 'Follow acknowledgement and durable captions differ.');
          Object.assign(row, { editFollow: follow.appliedCount });
        } finally { await context.close(); }
      }
    } finally {
      if (child.exitCode === null) {
        const finished = once(child, 'exit');
        child.kill();
        await finished;
      }
    }
  }
} finally {
  await browser.close();
  const after = await Promise.all([...sourceFiles.map((file) => path.join(owner, file)), python].map(fileHash));
  assert.deepEqual(after, originalHashes, 'An original file changed during qualification.');
  await fs.writeFile(path.join(scratch, 'qualification.json'), JSON.stringify({ binding, originalsUnchanged: true, results }, null, 2));
  console.log('Original project, media, cache files and Python executable are byte-identical.');
}

const checklist = new Map<string, (typeof notes)[number]>();
const add = (row: (typeof notes)[number]) => checklist.set(row.project + '/' + row.caption.id, row);
for (const row of notes) {
  if (row.caption.id === 'jWxXJX3f' || row.plan.coverage === 'none' || row.caption.wordTiming?.words.some(({ members }) => members)) add(row);
}
const spokenText = ({ caption, plan }: (typeof notes)[number]) => plan.spans.map(({ startOffset, endOffset }) =>
  caption.text.slice(startOffset, endOffset).normalize('NFC').replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, ''));
for (const selector of [
  notes.filter(({ plan }) => plan.coverage === 'partial'),
  [...notes].filter(({ plan }) => plan.coverage === 'full-individual').sort((a, b) =>
    b.plan.spokenUnits / (b.caption.endMs - b.caption.startMs) - a.plan.spokenUnits / (a.caption.endMs - a.caption.startMs)),
  notes.filter((row) => {
    const words = spokenText(row);
    return new Set(words).size < words.length;
  }),
  notes.filter(({ plan, caption }) => plan.spans.some(({ startMs, endMs }) => startMs === caption.startMs || endMs === caption.endMs)),
  notes.filter(({ plan }) => plan.coverage === 'full-individual'),
]) {
  for (const row of selector.slice(0, 7)) if (checklist.size < 40) add(row);
}
assert.ok([...checklist.values()].some(({ caption }) => caption.id === 'jWxXJX3f'));
const format = (ms: number) => (ms / 1000).toFixed(3) + ' s';
const sections = ['# Word highlight listening checklist', '', 'Listen to each caption and record whether each onset and end matches the audio. Mark uncertain boundaries and captions you would edit before export.'];
for (const { project, caption, plan } of checklist.values()) {
  sections.push('', `- [ ] ${project} / ${caption.id} · ${format(caption.startMs)} to ${format(caption.endMs)}`, `  ${caption.text.replaceAll('\n', ' / ')}`);
  if (!plan.spans.length) sections.push('  - Plain throughout.');
  for (const span of plan.spans) {
    sections.push(`  - “${caption.text.slice(span.startOffset, span.endOffset)}” lights from ${format(span.startMs)} to ${format(span.endMs)}.`);
  }
}
await fs.writeFile(path.join(scratch, 'owner-listening-checklist.md'), sections.join('\n') + '\n');
console.log('Owner listening checklist written', checklist.size);
