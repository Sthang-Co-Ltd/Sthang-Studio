import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateTrustRoot } from './update-protocol.mjs';
import { BROKER_DESCRIPTOR, BROKER_PATHS, BROKER_UPDATE_NOTE, compareBrokerVersions, validateBrokerDescriptor } from './broker-contract.mjs';

// Git archive honors the committed eol=crlf rules for PS1. This normalization is
// only for source validation; installed and signed package checks use raw bytes.
export function brokerExportBytes(relative, bytes) {
  return relative.endsWith('.ps1')
    ? Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'))
    : bytes;
}
export async function verifyBrokerSource(root, { release = false } = {}) {
  const descriptor = validateBrokerDescriptor(JSON.parse(await fs.readFile(path.join(root, BROKER_DESCRIPTOR), 'utf8')));
  for (const relative of BROKER_PATHS) {
    const bytes = brokerExportBytes(relative, await fs.readFile(path.join(root, relative)));
    const expected = descriptor.files[relative];
    if (expected.sizeBytes !== bytes.length || expected.sha256 !== sha256(bytes)) throw new Error(`Broker payload identity needs review: ${relative}`);
  }
  const launcher = await fs.readFile(path.join(root, BROKER_PATHS[0]), 'utf8');
  if (!launcher.includes(`$BrokerVersion = '${descriptor.brokerVersion}'`)) throw new Error('The launcher and broker descriptor versions differ.');
  // Preserve the schema-1 signer's existing source for minBrokerVersion. It is
  // intentionally independent of the actual bundled/installed broker identity.
  const trust = validateTrustRoot(JSON.parse(await fs.readFile(path.join(root, 'config/update-trust-root.json'), 'utf8')));
  if (compareBrokerVersions(trust.brokerVersion, descriptor.brokerVersion) > 0) throw new Error('The release requires a broker newer than its recovery installer provides.');
  if (release && compareBrokerVersions(trust.brokerVersion, descriptor.brokerVersion) < 0) {
    const app = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const notes = await fs.readFile(path.join(root, `release-notes/v${app.version}.txt`), 'utf8');
    if (!notes.replace(/\r\n?/g, '\n').split('\n').includes(BROKER_UPDATE_NOTE)) throw new Error(`Release notes must disclose: ${BROKER_UPDATE_NOTE}`);
  }
  return { brokerVersion: descriptor.brokerVersion, minimumBrokerVersion: trust.brokerVersion };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const rootIndex = argv.indexOf('--root');
  const allowed = new Set(['--root', '--release', '--print-minimum']);
  if ((rootIndex >= 0 && (!argv[rootIndex + 1] || argv[rootIndex + 1].startsWith('--')))
      || argv.some((arg, i) => !(rootIndex >= 0 && i === rootIndex + 1) && !allowed.has(arg))) {
    console.error('Usage: verify-studio-broker.mjs [--root PATH] [--release] [--print-minimum]');
    process.exit(1);
  }
  const root = rootIndex >= 0 ? path.resolve(argv[rootIndex + 1] || '') : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  verifyBrokerSource(root, { release: argv.includes('--release') }).then((result) => {
    console.log(argv.includes('--print-minimum') ? result.minimumBrokerVersion : `Broker ${result.brokerVersion} verified; OTA minimum ${result.minimumBrokerVersion}.`);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
