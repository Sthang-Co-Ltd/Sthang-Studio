import assert from 'node:assert/strict';
import test from 'node:test';
import { localTimingSetupFix } from '../apps/server/src/services/doctor.js';

test('Windows timing setup names the installer and script without a local path', () => {
  const fix = localTimingSetupFix('win32');
  assert.equal(fix, 'Run Install Sthang Studio.bat again from your download, or run setup-local-timing-windows.bat in the Studio folder. Then run the System check again.');
  assert.doesNotMatch(fix, /[a-z]:|[\\/]/i);
});

test('macOS timing setup uses only the relative script name', () => {
  const fix = localTimingSetupFix('darwin');
  assert.equal(fix, 'In the Studio folder, run bash ./setup-local-timing-macos.sh. Then run the System check again.');
  assert.doesNotMatch(fix.replace('./', ''), /[a-z]:|[\\/]/i);
});

test('Linux timing setup keeps the generic instruction', () => {
  assert.equal(localTimingSetupFix('linux'), 'Install the local timing Python dependencies for this platform.');
});
