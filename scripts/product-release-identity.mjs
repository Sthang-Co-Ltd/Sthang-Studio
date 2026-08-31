const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/;

function version(value, label) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a valid SemVer version.`);
  }
  return value;
}

export function deriveProductReleaseIdentity({ sourceVersion, publicVersion }) {
  const source = version(sourceVersion, 'Source version');
  const published = version(publicVersion, 'Public version');
  const publicTag = `v${published}`;
  const publicAssetName = `Sthang-Studio-Windows-v${published}.zip`;
  return Object.freeze({
    sourceVersion: source,
    publicVersion: published,
    publicTag,
    publicAssetName,
    publicChecksumName: `${publicAssetName}.sha256`,
    publicReleaseBase: `https://github.com/Sthang-Co-Ltd/Sthang-Studio/releases/download/${publicTag}`,
    publicArchiveRoot: `Sthang Studio ${published}`,
  });
}
