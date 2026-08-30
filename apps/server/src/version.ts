import fs from 'node:fs';
import path from 'node:path';
import { rootDir } from './config.js';
import { exactVersion } from '../../../scripts/update-protocol.mjs';

interface PackageIdentity {
  version?: unknown;
}

function readVersion() {
  const parsed = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as PackageIdentity;
  return exactVersion(parsed.version, 'Studio package version');
}

export const APP_VERSION = readVersion();
