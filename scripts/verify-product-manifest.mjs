import fs from 'node:fs';
import path from 'node:path';
import { deriveProductReleaseIdentity } from './product-release-identity.mjs';

const root = process.cwd();
const manifestPath = path.join(root, '.sthang', 'product-manifest.json');
const errors = [];

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
  } catch (error) {
    errors.push(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function objectAt(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return {};
  }
  return value;
}

function exactKeys(value, label, expected) {
  const object = objectAt(value, label);
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.join('\0') !== wanted.join('\0')) {
    errors.push(`${label} keys must be exactly: ${wanted.join(', ')}; found: ${actual.join(', ')}`);
  }
  return object;
}

function equal(actual, expected, label) {
  if (actual !== expected) errors.push(`${label} must be ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}`);
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    errors.push(`${label} must be a non-empty array of non-empty strings`);
  }
}

function exactStringArray(value, label, expected) {
  stringArray(value, label);
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    errors.push(`${label} must be exactly ${JSON.stringify(expected)}; found ${JSON.stringify(value)}`);
  }
}

function rejectEmbeddedEvidence(value, label = 'manifest') {
  const forbiddenKeys = new Set([
    'implementationRevision',
    'sourceCommit',
    'releaseCommit',
    'commit',
    'provenanceCommit',
    'hash',
    'sha256',
    'digest',
    'manifestDigest',
    'canonicalDigest',
    'token',
    'credential',
    'rpcUrl',
  ]);

  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectEmbeddedEvidence(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)) {
      errors.push(`${label} must not embed a commit or content hash; HQ observes provenance externally`);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) errors.push(`${label}.${key} is forbidden; HQ observes provenance externally`);
    rejectEmbeddedEvidence(child, `${label}.${key}`);
  }
}

function readEvidenceCorpus(paths, label) {
  return paths.map((relativePath) => {
    try {
      return fs.readFileSync(path.join(root, relativePath), 'utf8');
    } catch (error) {
      errors.push(`${label} path cannot be read: ${relativePath} (${error instanceof Error ? error.message : String(error)})`);
      return '';
    }
  }).join('\n');
}

const manifest = readJson('.sthang/product-manifest.json');
const rootPackage = readJson('package.json');
const serverPackage = readJson('apps/server/package.json');
const webPackage = readJson('apps/web/package.json');
const sharedPackage = readJson('packages/shared/package.json');
const lock = readJson('package-lock.json');
const updateTrustRoot = readJson('config/update-trust-root.json');

if (manifest && rootPackage && serverPackage && webPackage && sharedPackage && lock && updateTrustRoot) {
  const version = rootPackage.version;
  let releaseIdentity;
  try {
    releaseIdentity = deriveProductReleaseIdentity({
      sourceVersion: version,
      publicVersion: manifest?.proposal?.release?.publicVersion,
    });
  } catch (error) {
    errors.push(`release identity is invalid: ${error instanceof Error ? error.message : String(error)}`);
    releaseIdentity = {
      sourceVersion: String(version ?? ''),
      publicVersion: String(manifest?.proposal?.release?.publicVersion ?? ''),
      publicTag: `v${String(manifest?.proposal?.release?.publicVersion ?? '')}`,
      publicAssetName: `Sthang-Studio-Windows-v${String(manifest?.proposal?.release?.publicVersion ?? '')}.zip`,
      publicChecksumName: `Sthang-Studio-Windows-v${String(manifest?.proposal?.release?.publicVersion ?? '')}.zip.sha256`,
      publicReleaseBase: `https://github.com/Sthang-Co-Ltd/Sthang-Studio/releases/download/v${String(manifest?.proposal?.release?.publicVersion ?? '')}`,
      publicArchiveRoot: `Sthang Studio ${String(manifest?.proposal?.release?.publicVersion ?? '')}`,
    };
  }

  const {
    publicVersion,
    publicTag: tag,
    publicAssetName: assetName,
    publicChecksumName: checksumName,
    publicReleaseBase: releaseBase,
    publicArchiveRoot: archiveRoot,
  } = releaseIdentity;

  exactKeys(manifest, 'manifest', ['$schema', 'schemaVersion', 'kind', 'productId', 'source', 'change', 'proposal', 'evidence']);
  equal(manifest.$schema, 'https://sthang.app/schemas/product-manifest.schema.json', 'manifest.$schema');
  equal(manifest.schemaVersion, 1, 'manifest.schemaVersion');
  equal(manifest.kind, 'sthang-product-manifest', 'manifest.kind');
  equal(manifest.productId, 'studio', 'manifest.productId');

  const source = exactKeys(manifest.source, 'manifest.source', ['repository', 'visibilityClaim', 'defaultBranchClaim']);
  equal(source.repository, 'Sthang-Co-Ltd/Sthang-Studio', 'manifest.source.repository');
  equal(source.visibilityClaim, 'public', 'manifest.source.visibilityClaim');
  equal(source.defaultBranchClaim, 'main', 'manifest.source.defaultBranchClaim');

  const change = exactKeys(manifest.change, 'manifest.change', ['id', 'userVisible', 'documentationImpact', 'releaseImpact']);
  equal(change.id, 'studio-khmer-contributor-analytics-v0-8-0', 'manifest.change.id');
  equal(change.userVisible, true, 'manifest.change.userVisible');
  equal(change.releaseImpact, 'version', 'manifest.change.releaseImpact');
  const documentationImpact = exactKeys(change.documentationImpact, 'manifest.change.documentationImpact', ['status', 'summary']);
  equal(documentationImpact.status, 'required', 'manifest.change.documentationImpact.status');
  equal(
    documentationImpact.summary,
    'Prepare explicit opt-in Khmer Caption Contributor corpus and privacy-safe product analytics for unreleased Studio 0.8.0 with production services provisioned and synthetic-validated, while preserving v0.7.14 as the verified public download and keeping release, HQ, and Distribution separately gated.',
    'manifest.change.documentationImpact.summary',
  );

  const proposal = exactKeys(manifest.proposal, 'manifest.proposal', [
    'displayName',
    'parentBrand',
    'lifecycle',
    'publicVisibilityRequest',
    'source',
    'distribution',
    'updates',
    'release',
    'routes',
    'brand',
    'publicSummary',
    'publicClaims',
    'dataProcessing',
  ]);
  equal(proposal.displayName, 'Sthang Studio', 'manifest.proposal.displayName');
  equal(proposal.parentBrand, 'Sthang', 'manifest.proposal.parentBrand');
  equal(proposal.lifecycle, 'preview', 'manifest.proposal.lifecycle');

  const visibilityRequest = exactKeys(proposal.publicVisibilityRequest, 'manifest.proposal.publicVisibilityRequest', ['status', 'basis']);
  equal(visibilityRequest.status, 'approved', 'manifest.proposal.publicVisibilityRequest.status');
  equal(
    visibilityRequest.basis,
    `Approved public repository and independently verified ${tag} prerelease evidence for the Studio beta`,
    'manifest.proposal.publicVisibilityRequest.basis',
  );

  const proposalSource = exactKeys(proposal.source, 'manifest.proposal.source', ['visibility', 'repository', 'normalization']);
  equal(proposalSource.visibility, 'public', 'manifest.proposal.source.visibility');
  equal(proposalSource.repository, 'Sthang-Co-Ltd/Sthang-Studio', 'manifest.proposal.source.repository');
  equal(
    proposalSource.normalization,
    'Public repository visibility and source access are independently verified against the governed repository',
    'manifest.proposal.source.normalization',
  );
  if (typeof proposal.publicSummary !== 'string' || !proposal.publicSummary.trim()) {
    errors.push('manifest.proposal.publicSummary must be a non-empty string');
  }
  exactStringArray(proposal.publicClaims, 'manifest.proposal.publicClaims', [
    'Khmer-first caption editing in the Captions workspace',
    'Public source and a reviewed Beta download on GitHub',
    'Timing, editing, projects, history, and exports remain local in the verified v0.7.14 Beta',
  ]);

  const distribution = exactKeys(proposal.distribution, 'manifest.proposal.distribution', [
    'model',
    'availability',
    'downloadAuthority',
    'primaryAction',
    'sourceAction',
  ]);
  equal(distribution.model, 'public-github-release', 'manifest.proposal.distribution.model');
  equal(distribution.availability, 'available', 'manifest.proposal.distribution.availability');
  equal(distribution.downloadAuthority, 'github-releases', 'manifest.proposal.distribution.downloadAuthority');
  const primaryAction = exactKeys(distribution.primaryAction, 'manifest.proposal.distribution.primaryAction', ['label', 'href']);
  equal(primaryAction.label, 'Download for Windows', 'manifest.proposal.distribution.primaryAction.label');
  equal(primaryAction.href, `${releaseBase}/${assetName}`, 'manifest.proposal.distribution.primaryAction.href');
  const sourceAction = exactKeys(distribution.sourceAction, 'manifest.proposal.distribution.sourceAction', ['label', 'href']);
  equal(sourceAction.label, 'View source on GitHub', 'manifest.proposal.distribution.sourceAction.label');
  equal(sourceAction.href, 'https://github.com/Sthang-Co-Ltd/Sthang-Studio', 'manifest.proposal.distribution.sourceAction.href');

  const updates = exactKeys(proposal.updates, 'manifest.proposal.updates', ['model', 'automaticPublication']);
  equal(updates.model, 'manual-github-release', 'manifest.proposal.updates.model');
  equal(updates.automaticPublication, false, 'manifest.proposal.updates.automaticPublication');

  const release = exactKeys(proposal.release, 'manifest.proposal.release', [
    'sourceVersion',
    'publicVersion',
    'publicVersionStatus',
    'channel',
  ]);
  equal(release.sourceVersion, version, 'manifest.proposal.release.sourceVersion');
  equal(release.publicVersion, publicVersion, 'manifest.proposal.release.publicVersion');
  equal(release.publicVersionStatus, 'verified', 'manifest.proposal.release.publicVersionStatus');
  equal(release.channel, 'preview', 'manifest.proposal.release.channel');

  const routes = exactKeys(proposal.routes, 'manifest.proposal.routes', ['website', 'legacyWebsite', 'docs']);
  equal(routes.website, '/studio/', 'manifest.proposal.routes.website');
  if (!Array.isArray(routes.legacyWebsite) || routes.legacyWebsite.length !== 0) {
    errors.push('manifest.proposal.routes.legacyWebsite must be an empty array');
  }
  equal(routes.docs, '/studio/', 'manifest.proposal.routes.docs');

  const brand = exactKeys(proposal.brand, 'manifest.proposal.brand', ['assetSet', 'accent']);
  equal(brand.assetSet, 'studio', 'manifest.proposal.brand.assetSet');
  equal(brand.accent, '#D7FF4F', 'manifest.proposal.brand.accent');

  const dataProcessing = exactKeys(proposal.dataProcessing, 'manifest.proposal.dataProcessing', ['providers']);
  if (!Array.isArray(dataProcessing.providers) || dataProcessing.providers.length !== 3) {
    errors.push('manifest.proposal.dataProcessing.providers must contain Gemini, Sthang contribution, and PostHog declarations');
  } else {
    const [gemini, contribution, posthog] = dataProcessing.providers;

    const provider = exactKeys(gemini, 'manifest.proposal.dataProcessing.providers[0]', [
      'id',
      'purpose',
      'availability',
      'triggers',
      'dataSent',
      'staysLocal',
      'credentialOwner',
      'keyStorage',
      'interactionStore',
      'fileApiUpload',
      'fileDeleteCalledByApp',
      'remoteFileRetention',
      'privacyUrl',
    ]);
    equal(provider.id, 'google-gemini', 'Gemini provider id');
    equal(provider.purpose, 'AI caption wording', 'Gemini purpose');
    equal(provider.availability, 'current-configured-user-action', 'Gemini availability');
    exactStringArray(provider.triggers, 'Gemini triggers', ['generate', 'regenerate']);
    exactStringArray(provider.dataSent, 'Gemini dataSent', ['normalized WAV audio', 'relevant context', 'requested wording']);
    exactStringArray(provider.staysLocal, 'Gemini staysLocal', ['timing', 'editing', 'projects', 'history', 'exports']);
    equal(provider.credentialOwner, 'user', 'Gemini credentialOwner');
    exactStringArray(provider.keyStorage, 'Gemini keyStorage', [
      'Windows user-protected in-app storage',
      'Advanced GEMINI_API_KEY environment or .env fallback',
    ]);
    equal(provider.interactionStore, false, 'Gemini interactionStore');
    equal(provider.fileApiUpload, true, 'Gemini fileApiUpload');
    equal(provider.fileDeleteCalledByApp, false, 'Gemini fileDeleteCalledByApp');
    equal(provider.remoteFileRetention, 'provider-controlled-up-to-48-hours', 'Gemini remoteFileRetention');
    equal(provider.privacyUrl, 'https://github.com/Sthang-Co-Ltd/Sthang-Studio/blob/main/PRIVACY.md', 'Gemini privacyUrl');

    const corpusProvider = exactKeys(contribution, 'manifest.proposal.dataProcessing.providers[1]', [
      'id',
      'purpose',
      'availability',
      'triggers',
      'dataSent',
      'staysLocal',
      'credentialOwner',
      'credentialStorage',
      'remoteStorage',
      'retention',
      'deletion',
      'trainingPurpose',
      'privacyUrl',
    ]);
    equal(corpusProvider.id, 'sthang-khmer-contribution', 'Contribution provider id');
    equal(corpusProvider.purpose, 'Optional Khmer caption improvement corpus', 'Contribution purpose');
    equal(corpusProvider.availability, 'unreleased-provisioned-default-off', 'Contribution availability');
    exactStringArray(corpusProvider.triggers, 'Contribution triggers', [
      'explicit Khmer Caption Contributor opt-in',
      'eligible post-consent caption correction followed by approval',
    ]);
    exactStringArray(corpusProvider.dataSent, 'Contribution dataSent', [
      'random contributor id',
      'bounded short WAV around corrected caption',
      'generated caption wording',
      'corrected caption wording',
      'caption and clip timing',
      'generated timing, model, and Studio version evidence',
      'audio SHA-256',
    ]);
    exactStringArray(corpusProvider.staysLocal, 'Contribution staysLocal', [
      'full source video',
      'project title',
      'source filename',
      'local filesystem paths',
      'unrelated captions',
      'topic and context text',
      'correction memory',
      'SRT exports',
      'Gemini API key',
      'product analytics installation id',
    ]);
    equal(corpusProvider.credentialOwner, 'app-generated-pseudonymous', 'Contribution credentialOwner');
    equal(corpusProvider.credentialStorage, 'local withdrawal token; service stores only its SHA-256', 'Contribution credentialStorage');
    exactStringArray(corpusProvider.remoteStorage, 'Contribution remoteStorage', [
      'private Cloudflare R2 audio',
      'Cloudflare D1 correction metadata',
    ]);
    equal(corpusProvider.retention, 'submitted-unverified-180-days; verified-until-withdrawal-or-program-retirement', 'Contribution retention');
    equal(corpusProvider.deletion, 'contributor-wide authenticated withdrawal deletes private audio and blanks contributed text', 'Contribution deletion');
    equal(corpusProvider.trainingPurpose, true, 'Contribution trainingPurpose');
    equal(corpusProvider.privacyUrl, 'https://github.com/Sthang-Co-Ltd/Sthang-Studio/blob/main/PRIVACY.md', 'Contribution privacyUrl');

    const analyticsProvider = exactKeys(posthog, 'manifest.proposal.dataProcessing.providers[2]', [
      'id',
      'purpose',
      'availability',
      'triggers',
      'dataSent',
      'staysLocal',
      'identity',
      'personProfiles',
      'sessionReplay',
      'autocapture',
      'privacyUrl',
    ]);
    equal(analyticsProvider.id, 'posthog-eu', 'PostHog provider id');
    equal(analyticsProvider.purpose, 'Optional product analytics processed through the Sthang-owned analytics relay', 'PostHog purpose');
    equal(analyticsProvider.availability, 'unreleased-provisioned-default-off', 'PostHog availability');
    exactStringArray(analyticsProvider.triggers, 'PostHog triggers', ['explicit product analytics opt-in']);
    exactStringArray(analyticsProvider.dataSent, 'PostHog dataSent', [
      'allow-listed event names',
      'coarse workflow buckets',
      'random analytics installation id',
      'Studio and platform version',
      'ordinary infrastructure and HTTPS metadata may be observed by service providers',
    ]);
    exactStringArray(analyticsProvider.staysLocal, 'PostHog staysLocal', [
      'caption and transcript text',
      'audio and video',
      'filenames and project names',
      'local paths',
      'topic, vocabulary, and context text',
      'correction memory',
      'SRT contents',
      'Gemini API key',
      'Khmer Contributor id',
    ]);
    equal(analyticsProvider.identity, 'random installation id separate from Khmer Contributor identity', 'PostHog identity');
    equal(analyticsProvider.personProfiles, false, 'PostHog personProfiles');
    equal(analyticsProvider.sessionReplay, false, 'PostHog sessionReplay');
    equal(analyticsProvider.autocapture, false, 'PostHog autocapture');
    equal(analyticsProvider.privacyUrl, 'https://posthog.com/privacy', 'PostHog privacyUrl');
  }

  const evidence = exactKeys(manifest.evidence, 'manifest.evidence', ['release', 'installation', 'dataProcessing', 'identity']);
  const releaseEvidence = exactKeys(evidence.release, 'manifest.evidence.release', [
    'mode',
    'tag',
    'expectedDraft',
    'expectedPrerelease',
    'assetName',
    'checksumAssetName',
    'notesRequiredTerms',
    'notesForbiddenTerms',
    'package',
  ]);
  equal(releaseEvidence.mode, 'github-release', 'manifest.evidence.release.mode');
  equal(releaseEvidence.tag, tag, 'manifest.evidence.release.tag');
  equal(releaseEvidence.expectedDraft, false, 'manifest.evidence.release.expectedDraft');
  equal(releaseEvidence.expectedPrerelease, true, 'manifest.evidence.release.expectedPrerelease');
  equal(releaseEvidence.assetName, assetName, 'manifest.evidence.release.assetName');
  equal(releaseEvidence.checksumAssetName, checksumName, 'manifest.evidence.release.checksumAssetName');
  exactStringArray(releaseEvidence.notesRequiredTerms, 'manifest.evidence.release.notesRequiredTerms', [
    `Sthang Studio ${publicVersion}`,
    'Public Beta',
    'Windows 10 or 11 x64',
    'Gemini Developer API key',
    'Files API',
    '48 hours',
    'SHA-256',
  ]);
  exactStringArray(releaseEvidence.notesForbiddenTerms, 'manifest.evidence.release.notesForbiddenTerms', [
    'private repository',
    'release candidate',
    'not publicly available',
    'no public download',
  ]);

  const releasePackage = exactKeys(releaseEvidence.package, 'manifest.evidence.release.package', ['entrypoint', 'requiredPaths', 'truth']);
  equal(releasePackage.entrypoint, `${archiveRoot}/Install Sthang Studio.bat`, 'manifest.evidence.release.package.entrypoint');
  exactStringArray(releasePackage.requiredPaths, 'manifest.evidence.release.package.requiredPaths', [
    `${archiveRoot}/Install Sthang Studio.bat`,
    `${archiveRoot}/Read Me.txt`,
    `${archiveRoot}/Sthang Studio Files/.env.example`,
    `${archiveRoot}/Sthang Studio Files/.sthang/product-manifest.json`,
    `${archiveRoot}/Sthang Studio Files/INSTALL-NEW-PC.bat`,
    `${archiveRoot}/Sthang Studio Files/README.md`,
    `${archiveRoot}/Sthang Studio Files/PRIVACY.md`,
    `${archiveRoot}/Sthang Studio Files/package-lock.json`,
    `${archiveRoot}/Sthang Studio Files/scripts/install-release-package.ps1`,
  ]);
  const packageTruth = exactKeys(releasePackage.truth, 'manifest.evidence.release.package.truth', ['paths', 'requiredTerms', 'forbiddenTerms']);
  exactStringArray(packageTruth.paths, 'manifest.evidence.release.package.truth.paths', [
    `${archiveRoot}/Read Me.txt`,
    `${archiveRoot}/Sthang Studio Files/README.md`,
    `${archiveRoot}/Sthang Studio Files/PRIVACY.md`,
  ]);
  exactStringArray(packageTruth.requiredTerms, 'manifest.evidence.release.package.truth.requiredTerms', [
    'public Beta',
    tag,
    'Gemini Files API',
    'store: false',
    '48 hours',
  ]);
  exactStringArray(packageTruth.forbiddenTerms, 'manifest.evidence.release.package.truth.forbiddenTerms', [
    'private repository',
    'release candidate',
    'not publicly available',
  ]);

  const installation = exactKeys(evidence.installation, 'manifest.evidence.installation', ['paths', 'requiredTerms', 'forbiddenTerms']);
  const installationPaths = ['README.md', 'packaging/windows/Read Me.txt', 'docs/PUBLIC-RELEASE-CHECKLIST.md', 'docs/OTA-UPDATES.md'];
  exactStringArray(installation.paths, 'manifest.evidence.installation.paths', installationPaths);
  exactStringArray(installation.requiredTerms, 'manifest.evidence.installation.requiredTerms', [
    'Install Sthang Studio.bat',
    '%LOCALAPPDATA%\\Sthang Studio\\app',
    'delete this extracted setup folder',
    'Windows 10 or 11',
    'Gemini API key',
    'updates.sthang.app',
    'GitHub Release',
    'explicit confirmation',
    'rollback',
  ]);
  exactStringArray(installation.forbiddenTerms, 'manifest.evidence.installation.forbiddenTerms', [
    'Download ZIP is the installer',
    'Chrome is required',
  ]);

  const evidenceDataProcessing = exactKeys(evidence.dataProcessing, 'manifest.evidence.dataProcessing', ['paths', 'requiredTerms', 'forbiddenTerms']);
  const dataProcessingPaths = [
    'PRIVACY.md',
    'README.md',
    'docs/KHMER-CAPTION-CONTRIBUTOR.md',
    'config/product-services.json',
    'apps/server/src/services/gemini.ts',
    'apps/server/src/services/analytics.ts',
    'apps/server/src/services/contribution-store.ts',
    'infra/contribution-worker/src/index.mjs',
    'infra/contribution-worker/src/retention.mjs',
    'infra/analytics-worker/src/index.mjs',
    'infra/analytics-worker/README.md',
    'docs/OTA-UPDATES.md',
  ];
  exactStringArray(evidenceDataProcessing.paths, 'manifest.evidence.dataProcessing.paths', dataProcessingPaths);
  exactStringArray(evidenceDataProcessing.requiredTerms, 'manifest.evidence.dataProcessing.requiredTerms', [
    'Files API',
    '48 hours',
    'store: false',
    'ai.files.upload',
    'updates.sthang.app',
    'ordinary HTTPS metadata',
    'no license, authentication, D1 enrollment',
    'contribute.sthang.app',
    'analytics.sthang.app',
    'explicit opt-in',
    'private R2',
    '180 days',
    'PostHog',
    '$process_person_profile',
    'session replay',
    'autocapture',
  ]);
  exactStringArray(evidenceDataProcessing.forbiddenTerms, 'manifest.evidence.dataProcessing.forbiddenTerms', [
    'Sthang Studio is fully offline',
    'Studio deletes the remote file',
    'remote audio is deleted immediately',
    'analytics is required',
    'contribution is required',
  ]);

  for (const [label, declaration] of [
    ['manifest.evidence.installation', installation],
    ['manifest.evidence.dataProcessing', evidenceDataProcessing],
  ]) {
    const corpus = readEvidenceCorpus(declaration.paths, label);
    for (const term of declaration.requiredTerms) {
      if (!corpus.includes(term)) errors.push(`${label} required term is not present in its declared paths: ${term}`);
    }
    for (const term of declaration.forbiddenTerms) {
      if (corpus.toLowerCase().includes(term.toLowerCase())) {
        errors.push(`${label} forbidden term is present in its declared paths: ${term}`);
      }
    }
  }

  const identity = exactKeys(evidence.identity, 'manifest.evidence.identity', ['manifestPath', 'assets']);
  equal(identity.manifestPath, 'apps/web/public/brand/brand-manifest.json', 'manifest.evidence.identity.manifestPath');
  const expectedIdentityAssets = [
    ['mark-on-dark', 'apps/web/public/brand/sthang-studio-mark.svg'],
    ['mark-on-light', 'apps/web/public/brand/sthang-studio-mark-ink.svg'],
    ['mark-monochrome', 'apps/web/public/brand/sthang-studio-mark-mono.svg'],
    ['wordmark-on-dark', 'apps/web/public/brand/sthang-wordmark.svg'],
    ['wordmark-on-light', 'apps/web/public/brand/sthang-wordmark-ink.svg'],
  ];
  if (!Array.isArray(identity.assets) || identity.assets.length !== expectedIdentityAssets.length) {
    errors.push(`manifest.evidence.identity.assets must contain exactly ${expectedIdentityAssets.length} protected assets`);
  } else {
    identity.assets.forEach((asset, index) => {
      const object = exactKeys(asset, `manifest.evidence.identity.assets[${index}]`, ['role', 'path']);
      equal(object.role, expectedIdentityAssets[index][0], `manifest.evidence.identity.assets[${index}].role`);
      equal(object.path, expectedIdentityAssets[index][1], `manifest.evidence.identity.assets[${index}].path`);
    });
  }
  for (const relativePath of [identity.manifestPath, ...expectedIdentityAssets.map(([, assetPath]) => assetPath)]) {
    if (!fs.existsSync(path.join(root, relativePath))) errors.push(`manifest.evidence.identity path does not exist: ${relativePath}`);
  }

  for (const [label, value] of [
    ['package.json', rootPackage.version],
    ['apps/server/package.json', serverPackage.version],
    ['apps/web/package.json', webPackage.version],
    ['packages/shared/package.json', sharedPackage.version],
    ['package-lock.json root', lock.version],
    ['package-lock.json packages[""]', lock.packages?.['']?.version],
    ['package-lock.json apps/server', lock.packages?.['apps/server']?.version],
    ['package-lock.json apps/web', lock.packages?.['apps/web']?.version],
    ['package-lock.json packages/shared', lock.packages?.['packages/shared']?.version],
    ['apps/server @kcs/shared', serverPackage.dependencies?.['@kcs/shared']],
    ['apps/web @kcs/shared', webPackage.dependencies?.['@kcs/shared']],
    ['package-lock apps/server @kcs/shared', lock.packages?.['apps/server']?.dependencies?.['@kcs/shared']],
    ['package-lock apps/web @kcs/shared', lock.packages?.['apps/web']?.dependencies?.['@kcs/shared']],
  ]) equal(value, version, label);

  const versionModule = fs.readFileSync(path.join(root, 'apps/server/src/version.ts'), 'utf8');
  if (!versionModule.includes("path.join(rootDir, 'package.json')") || !versionModule.includes('export const APP_VERSION = readVersion()')) {
    errors.push('apps/server/src/version.ts must derive APP_VERSION from the active version package.json');
  }
  const serverIndex = fs.readFileSync(path.join(root, 'apps/server/src/index.ts'), 'utf8');
  if (!serverIndex.includes("import { APP_VERSION } from './version.js'") || !serverIndex.includes('engineVersion: APP_VERSION')) {
    errors.push('apps/server/src/index.ts must expose the centralized APP_VERSION in health responses');
  }
  if (serverIndex.includes(`engineVersion: '${version}'`) || serverIndex.includes(`API v${version}`)) {
    errors.push('apps/server/src/index.ts must not duplicate the package version as a hard-coded runtime literal');
  }
  const doctorText = fs.readFileSync(path.join(root, 'apps/server/src/services/doctor.ts'), 'utf8');
  const doctorMatches = doctorText.match(new RegExp(version.replaceAll('.', '\\.'), 'g')) ?? [];
  if (doctorMatches.length !== 1) {
    errors.push(`apps/server/src/services/doctor.ts must contain runtime version ${version} exactly once; found ${doctorMatches.length}`);
  }

  const trust = exactKeys(updateTrustRoot, 'config/update-trust-root.json', [
    'schemaVersion', 'product', 'platform', 'channel', 'endpoint', 'keyId', 'publicKeyHex', 'provisioned', 'brokerVersion',
  ]);
  equal(trust.schemaVersion, 1, 'update trust schemaVersion');
  equal(trust.product, 'sthang-studio', 'update trust product');
  equal(trust.platform, 'windows-x64', 'update trust platform');
  equal(trust.channel, 'preview', 'update trust channel');
  equal(trust.endpoint, 'https://updates.sthang.app/studio/windows/latest.json', 'update trust endpoint');
  equal(trust.keyId, 'studio-updates-ed25519-root-v1', 'update trust keyId');
  equal(trust.publicKeyHex, '0e9ff5aaa1d9b3ea80887bd372d73fe83d5d7aaf51bfcfa09c3c07b1280cce5d', 'update trust publicKeyHex');
  equal(trust.provisioned, true, 'update trust provisioned');
  equal(trust.brokerVersion, '1.0.0', 'update trust brokerVersion');

  const releaseNotesPath = `release-notes/v${version}.txt`;
  try {
    const releaseNotes = fs.readFileSync(path.join(root, releaseNotesPath), 'utf8').replace(/\r\n?/g, '\n').trim();
    const releaseNoteLines = releaseNotes.split('\n');
    if (!releaseNotes || releaseNotes.length > 4000 || releaseNoteLines.length > 40 || releaseNoteLines.some((line) => line.length > 240)) {
      errors.push(`${releaseNotesPath} must contain 1-4000 characters, no more than 40 lines, and no line over 240 characters`);
    }
    if (/[^\t\n\r\x20-\x7E]/.test(releaseNotes)) {
      errors.push(`${releaseNotesPath} must remain bounded plain ASCII text for release metadata`);
    }
  } catch (error) {
    errors.push(`${releaseNotesPath} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  const otaDocs = fs.readFileSync(path.join(root, 'docs/OTA-UPDATES.md'), 'utf8');
  for (const required of [
    'not evidence that OTA updates are publicly available',
    'no license, authentication, D1 enrollment',
    'public verification key is provisioned',
    'GitHub Release',
  ]) {
    if (!otaDocs.toLowerCase().includes(required.toLowerCase())) {
      errors.push(`docs/OTA-UPDATES.md must preserve bootstrap updater truth: ${required}`);
    }
  }

  const contributorDocs = readEvidenceCorpus([
    'PRIVACY.md',
    'docs/KHMER-CAPTION-CONTRIBUTOR.md',
    'infra/contribution-worker/README.md',
  ], 'Contributor privacy evidence');
  for (const required of [
    'off by default',
    'Corrections made before joining are not collected retroactively',
    'submitted',
    'verified',
    '180 days',
    'Request deletion',
    'cannot literally rewind an already-trained model',
  ]) {
    if (!contributorDocs.toLowerCase().includes(required.toLowerCase())) {
      errors.push(`Contributor privacy evidence must preserve: ${required}`);
    }
  }

  const analyticsSource = fs.readFileSync(path.join(root, 'apps/server/src/services/analytics.ts'), 'utf8');
  for (const forbidden of [
    'caption.text', 'project.title', 'originalName', 'transcriptionContext', 'GEMINI_API_KEY',
    'api_key', '$process_person_profile', '$geoip_disable', 'posthog',
  ]) {
    if (analyticsSource.toLowerCase().includes(forbidden.toLowerCase())) {
      errors.push(`Studio analytics source must not reference processor/content field: ${forbidden}`);
    }
  }
  for (const required of ['analyticsConsent', 'config.analyticsEndpoint', '/v1/events', 'installationId']) {
    if (!analyticsSource.includes(required)) errors.push(`Studio analytics source must preserve Sthang-relay privacy guard: ${required}`);
  }

  const analyticsRelay = fs.readFileSync(path.join(root, 'infra/analytics-worker/src/index.mjs'), 'utf8');
  for (const required of [
    '$process_person_profile: false',
    '$geoip_disable: true',
    'https://eu.i.posthog.com/i/v0/e/',
    'ANALYTICS_PROJECT_KEY',
    "url.pathname === '/v1/events'",
  ]) {
    if (!analyticsRelay.includes(required)) errors.push(`Analytics relay must preserve downstream privacy boundary: ${required}`);
  }

  rejectEmbeddedEvidence(manifest);
}

if (errors.length) {
  console.error('Product-manifest verification failed:');
  for (const error of [...new Set(errors)]) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Product-manifest verification passed (${path.relative(root, manifestPath)}).`);
