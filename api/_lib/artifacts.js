import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ARTIFACTS_DIR = toAbsolutePath('artifacts');
const RELEASE_METADATA_PATH = ARTIFACTS_DIR ? path.join(ARTIFACTS_DIR, 'release-metadata.env') : '';
let cachedReleaseMetadata = null;

function toAbsolutePath(artifactPath) {
  const raw = String(artifactPath || '').trim();
  if (!raw || path.isAbsolute(raw)) return raw;

  // Paths to check for 'artifacts' directory
  const pathsToCheck = [
    path.resolve(process.cwd(), raw),
    path.resolve(process.cwd(), '..', raw),
    path.resolve('/var/task', raw)
  ];

  for (const p of pathsToCheck) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }

  return pathsToCheck[0]; // Fallback to current dir
}

function parsePositiveNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function parseEnvFile(text) {
  const result = {};
  for (const rawLine of String(text || '').split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function readReleaseMetadata() {
  if (cachedReleaseMetadata !== null) {
    return cachedReleaseMetadata;
  }

  if (!RELEASE_METADATA_PATH || !fs.existsSync(RELEASE_METADATA_PATH)) {
    cachedReleaseMetadata = {};
    return cachedReleaseMetadata;
  }

  try {
    cachedReleaseMetadata = parseEnvFile(fs.readFileSync(RELEASE_METADATA_PATH, 'utf8'));
  } catch (error) {
    console.warn('Failed to read release metadata:', error);
    cachedReleaseMetadata = {};
  }

  return cachedReleaseMetadata;
}

function lookupArtifactSetting(keys) {
  const metadata = readReleaseMetadata();

  for (const key of keys) {
    if (hasOwn(metadata, key)) {
      return String(metadata[key] ?? '');
    }
  }

  for (const key of keys) {
    if (hasOwn(process.env, key)) {
      return String(process.env[key] ?? '');
    }
  }

  return undefined;
}

function getArtifactSetting(keys, fallback = '', options = {}) {
  const { allowEmpty = false } = options;
  const raw = lookupArtifactSetting(keys);
  if (raw === undefined) {
    return fallback;
  }

  const value = String(raw).trim();
  if (!value && !allowEmpty) {
    return fallback;
  }

  return value;
}

function computeSha256Hex(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function inferContentType(fileName, fallback) {
  const lower = String(fileName || '').toLowerCase();
  if (lower.endsWith('.zip')) {
    return 'application/zip';
  }
  if (lower.endsWith('.jar')) {
    return 'application/java-archive';
  }
  if (lower.endsWith('.exe')) {
    return 'application/vnd.microsoft.portable-executable';
  }
  return fallback;
}

function formatVersionTimestamp(mtimeMs) {
  const date = new Date(mtimeMs);
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate())
  ].join('') + '-' + [
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds())
  ].join('');
}

function sanitizeVersionPart(value, fallback = 'artifact') {
  return String(value || '')
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    || fallback;
}

function buildAutoVersion(filePath, fileName, actualHash = '') {
  const stat = fs.statSync(filePath);
  const shortHash = String(actualHash || computeSha256Hex(filePath)).slice(0, 12);
  const versionBase = sanitizeVersionPart(path.basename(fileName || filePath, path.extname(fileName || filePath)));
  return `${versionBase}-${formatVersionTimestamp(stat.mtimeMs)}-${shortHash}`;
}

function shouldUseExternalUrl(absolutePath, externalUrl) {
  const normalizedUrl = String(externalUrl || '').trim();
  if (!normalizedUrl) {
    return false;
  }

  const preferExternal = String(getArtifactSetting(['PREFER_EXTERNAL_ARTIFACT_URLS'], ''))
    .trim()
    .toLowerCase() === 'true';

  if (preferExternal) {
    return true;
  }

  if (!absolutePath) {
    return true;
  }

  return !fs.existsSync(absolutePath);
}

function resolveNewestClientJarPath() {
  if (!ARTIFACTS_DIR || !fs.existsSync(ARTIFACTS_DIR)) {
    return '';
  }

  const entries = fs
    .readdirSync(ARTIFACTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
    .map((entry) => {
      const absolutePath = path.join(ARTIFACTS_DIR, entry.name);
      const stat = fs.statSync(absolutePath);
      return {
        absolutePath,
        fileName: entry.name,
        mtimeMs: stat.mtimeMs
      };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  return entries[0]?.absolutePath || '';
}

function clientConfig() {
  const configuredPath = toAbsolutePath(
    getArtifactSetting(['CLIENT_ARTIFACT_PATH', 'CLIENT_JAR_PATH'], 'artifacts/Aura.jar')
  );
  const latestJarPath = resolveNewestClientJarPath();
  const absolutePath = latestJarPath || configuredPath;
  const fileName = getArtifactSetting(
    ['CLIENT_ARTIFACT_NAME'],
    path.basename(absolutePath || 'Aura.jar')
  );
  const externalUrl = getArtifactSetting(
    ['CLIENT_ARTIFACT_URL', 'CLIENT_DOWNLOAD_URL'],
    '',
    { allowEmpty: true }
  );
  return {
    type: 'client',
    externalUrl: shouldUseExternalUrl(absolutePath, externalUrl) ? externalUrl : '',
    absolutePath,
    fileName,
    version: getArtifactSetting(['CLIENT_VERSION'], ''),
    hash: getArtifactSetting(['CLIENT_SHA256'], '').toLowerCase(),
    size: parsePositiveNumber(getArtifactSetting(['CLIENT_SIZE'], ''), 0),
    contentType: getArtifactSetting(
      ['CLIENT_ARTIFACT_CONTENT_TYPE'],
      inferContentType(fileName, 'application/java-archive')
    )
  };
}

function launcherConfig() {
  const absolutePath = toAbsolutePath(
    getArtifactSetting(['LAUNCHER_ARTIFACT_PATH'], 'artifacts/Auraloader.exe')
  );
  const fileName = getArtifactSetting(
    ['LAUNCHER_ARTIFACT_NAME'],
    path.basename(absolutePath || 'Auraloader.exe')
  );
  const externalUrl = getArtifactSetting(['LAUNCHER_ARTIFACT_URL'], '', { allowEmpty: true });
  return {
    type: 'launcher',
    externalUrl: shouldUseExternalUrl(absolutePath, externalUrl) ? externalUrl : '',
    absolutePath,
    fileName,
    version: getArtifactSetting(['LAUNCHER_VERSION'], ''),
    hash: getArtifactSetting(['LAUNCHER_SHA256'], '').toLowerCase(),
    size: parsePositiveNumber(getArtifactSetting(['LAUNCHER_SIZE'], ''), 0),
    contentType: getArtifactSetting(
      ['LAUNCHER_ARTIFACT_CONTENT_TYPE'],
      inferContentType(fileName, 'application/octet-stream')
    )
  };
}

function jreConfig() {
  const absolutePath = toAbsolutePath(getArtifactSetting(['JRE_ARTIFACT_PATH'], 'artifacts/jre.zip'));
  const fileName = getArtifactSetting(['JRE_ARTIFACT_NAME'], path.basename(absolutePath || 'jre.zip'));
  const externalUrl = getArtifactSetting(['JRE_ARTIFACT_URL'], 'https://github.com/Unpelsi/jre/releases/download/1.0/jre.zip', { allowEmpty: true });
  return {
    type: 'jre',
    externalUrl: shouldUseExternalUrl(absolutePath, externalUrl) ? externalUrl : '',
    absolutePath,
    fileName,
    version: getArtifactSetting(['JRE_VERSION'], '21'),
    hash: getArtifactSetting(['JRE_SHA256'], '').toLowerCase(),
    size: parsePositiveNumber(getArtifactSetting(['JRE_SIZE'], ''), 0),
    contentType: getArtifactSetting(
      ['JRE_ARTIFACT_CONTENT_TYPE'],
      inferContentType(fileName, 'application/zip')
    )
  };
}

function assetsConfig() {
  const absolutePath = toAbsolutePath(
    getArtifactSetting(['ASSETS_ARTIFACT_PATH'], 'artifacts/MinecraftAssets.zip')
  );
  const fileName = getArtifactSetting(
    ['ASSETS_ARTIFACT_NAME'],
    path.basename(absolutePath || 'MinecraftAssets.zip')
  );
  const externalUrl = getArtifactSetting(
    ['ASSETS_ARTIFACT_URL'],
    'https://github.com/Unpelsi/minecraft/releases/download/1.0/MinecraftAssets.zip',
    { allowEmpty: true }
  );
  return {
    type: 'assets',
    externalUrl: shouldUseExternalUrl(absolutePath, externalUrl) ? externalUrl : '',
    absolutePath,
    fileName,
    version: getArtifactSetting(['ASSETS_VERSION'], '1.0.0'),
    hash: getArtifactSetting(['ASSETS_SHA256'], '').toLowerCase(),
    size: parsePositiveNumber(getArtifactSetting(['ASSETS_SIZE'], ''), 0),
    contentType: getArtifactSetting(
      ['ASSETS_ARTIFACT_CONTENT_TYPE'],
      inferContentType(fileName, 'application/zip')
    )
  };
}

function fadeClientConfig() {
  const absolutePath = toAbsolutePath(
    getArtifactSetting(['FADE_ARTIFACT_PATH'], 'artifacts/Fade.jar')
  );
  const fileName = getArtifactSetting(
    ['FADE_ARTIFACT_NAME'],
    path.basename(absolutePath || 'Fade.jar')
  );
  const externalUrl = getArtifactSetting(['FADE_ARTIFACT_URL'], '', { allowEmpty: true });
  return {
    type: 'fade-client',
    externalUrl: shouldUseExternalUrl(absolutePath, externalUrl) ? externalUrl : '',
    absolutePath,
    fileName,
    version: getArtifactSetting(['FADE_VERSION'], ''),
    hash: getArtifactSetting(['FADE_SHA256'], '').toLowerCase(),
    size: parsePositiveNumber(getArtifactSetting(['FADE_SIZE'], ''), 0),
    contentType: getArtifactSetting(
      ['FADE_ARTIFACT_CONTENT_TYPE'],
      inferContentType(fileName, 'application/java-archive')
    )
  };
}

export function getArtifactConfig(type) {
  const kind = String(type || '').trim().toLowerCase();
  if (kind === 'client') {
    return clientConfig();
  }
  if (kind === 'launcher') {
    return launcherConfig();
  }
  if (kind === 'jre') {
    return jreConfig();
  }
  if (kind === 'assets') {
    return assetsConfig();
  }
  if (kind === 'fade-client') {
    return fadeClientConfig();
  }

  throw new Error(`Unsupported artifact type: ${type}`);
}

export function readArtifactMeta(type) {
  const cfg = getArtifactConfig(type);
  
  // If we have an external URL and the file is missing locally, favor the external URL.
  if (cfg.externalUrl) {
    return {
      ...cfg,
      hash: cfg.hash || '',
      size: cfg.size || 0,
      isExternal: true
    };
  }

  // If local file is expected but not found, don't crash the entire function initialization.
  if (!cfg.absolutePath || !fs.existsSync(cfg.absolutePath)) {
    console.warn(`Artifact file not found for type ${type}: ${cfg.absolutePath}. Falling back to empty meta.`);
    return {
      ...cfg,
      version: cfg.version || '0.0.0',
      hash: cfg.hash || '',
      size: cfg.size || 0,
      isMissing: true
    };
  }

  const actualHash = computeSha256Hex(cfg.absolutePath);
  const actualSize = fs.statSync(cfg.absolutePath).size;
  const staleHash = Boolean(cfg.hash) && cfg.hash !== actualHash;
  const staleSize = Boolean(cfg.size) && cfg.size !== actualSize;
  const autoVersion = buildAutoVersion(cfg.absolutePath, cfg.fileName, actualHash);

  let hash = cfg.hash || actualHash;
  let size = cfg.size || actualSize;
  let version = cfg.version || autoVersion;

  if (hash !== actualHash) {
    hash = actualHash;
  }
  if (size !== actualSize) {
    size = actualSize;
  }
  if (staleHash || staleSize) {
    version = autoVersion;
  }

  return {
    ...cfg,
    version,
    hash,
    size
  };
}
