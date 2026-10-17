/** Temp-path regression fixture: no Studio imports, browser or HTTP requests. */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHarnessRun, isolatedEnvironment, prepareOwnedStateRoot, requireHarnessConfig, verifyOwnedStateRoot } from '../browser/harness-config.mjs';

const inheritedTemp = os.tmpdir();
const evidenceParent = path.join(inheritedTemp, 'evidence');
const config = await createHarnessRun(evidenceParent);
let root: string | undefined;
try {
  root = await prepareOwnedStateRoot(config, 'adversarial-child');
  const environment = isolatedEnvironment(config, root);
  const socketPath = path.join(environment.TMPDIR!, 'org.chromium.Chromium.XXXXXX', 'SingletonSocket');
  console.log(JSON.stringify({ config, root, inheritedTemp, evidenceParent,
    temp: { TEMP: environment.TEMP, TMP: environment.TMP, TMPDIR: environment.TMPDIR },
    socketPath, socketBytes: Buffer.byteLength(socketPath) }));
} catch (error) {
  console.error(JSON.stringify({ fixture: 'long-nested-browser-temp', retainedOwnedRoot: config.runRoot, stateRoot: root }));
  const owned = requireHarnessConfig({ STHANG_BROWSER_API_PORT: String(config.apiPort),
    STHANG_BROWSER_WEB_PORT: String(config.webPort), STHANG_BROWSER_RUN_ROOT: config.runRoot,
    STHANG_BROWSER_RUN_MARKER: config.marker });
  if (root) verifyOwnedStateRoot(root, owned);
  await fs.rm(owned.runRoot, { recursive: true });
  throw error;
}
