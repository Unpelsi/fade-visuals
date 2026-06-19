import fs from 'fs';
import { readArtifactMeta } from './artifacts.js';
import { adminDb } from './firebase-admin.js';
import { extractBearerToken, forbidden, unauthorized } from './http.js';
import { getEntitlement, getUserByUid, resolveEntitlementState, writeAuditLog } from './license.js';
import { verifyAccessToken } from './tokens.js';

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

export async function verifyLauncherArtifactAccess(req) {
  const rawToken = extractBearerToken(req);
  if (!rawToken) {
    return { ok: false, status: 401, message: 'Missing bearer token.' };
  }

  const verify = verifyAccessToken(rawToken);
  if (!verify.ok) {
    return { ok: false, status: 401, message: verify.message || 'Invalid access token.' };
  }

  const decoded = verify.decoded || {};
  const uid = String(decoded.sub || '').trim();
  const sessionId = String(decoded.sid || '').trim();
  const tokenVersion = Number(decoded.tv || 1);

  if (!uid || !sessionId) {
    return { ok: false, status: 401, message: 'Access token payload is incomplete.' };
  }

  const user = await getUserByUid(uid);
  if (!user) {
    return { ok: false, status: 401, message: 'User not found.' };
  }

  if (user.banned === true) {
    return { ok: false, status: 403, message: 'Account is banned.' };
  }

  const expectedTokenVersion = Number(user.tokenVersion || 1);
  if (expectedTokenVersion !== tokenVersion) {
    return { ok: false, status: 401, message: 'Access token was revoked.' };
  }

  const sessionSnapshot = await adminDb.ref(`sessions/${sessionId}`).get();
  if (!sessionSnapshot.exists()) {
    return { ok: false, status: 401, message: 'Session not found.' };
  }

  const session = sessionSnapshot.val() || {};
  if (String(session.uid || '') !== uid) {
    return { ok: false, status: 401, message: 'Session does not belong to this user.' };
  }

  if (Number(session.expiresAt || 0) <= Date.now()) {
    return { ok: false, status: 401, message: 'Session expired.' };
  }

  const entitlement = await getEntitlement(uid);
  const entitlementState = resolveEntitlementState(user, entitlement);
  if (!entitlementState.active) {
    return { ok: false, status: 403, message: 'Subscription inactive.' };
  }

  return {
    ok: true,
    uid,
    uidShort: String(decoded.uidShort || user.uidShort || '').trim(),
    subscription: entitlementState.plan,
    ip: getClientIp(req)
  };
}

export async function sendArtifactFile(req, res, artifactType, auditContext = {}) {
  const artifact = readArtifactMeta(artifactType);
  if (artifact.isExternal && artifact.externalUrl) {
    await writeAuditLog('launcher_artifact_redirected', {
      type: artifactType,
      artifactName: artifact.fileName,
      artifactVersion: artifact.version,
      externalUrl: artifact.externalUrl,
      ...auditContext
    });
    return res.redirect(302, artifact.externalUrl);
  }

  if (!fs.existsSync(artifact.absolutePath)) {
    return res.status(404).json({ ok: false, error: 'Artifact not found.' });
  }

  res.setHeader('Content-Type', artifact.contentType || 'application/octet-stream');
  res.setHeader('Content-Length', String(artifact.size));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="${artifact.fileName}"`);
  res.setHeader('X-Artifact-Version', artifact.version);
  res.setHeader('X-Artifact-Sha256', artifact.hash);

  await writeAuditLog('launcher_artifact_download_started', {
    type: artifactType,
    artifactName: artifact.fileName,
    artifactVersion: artifact.version,
    ...auditContext
  });

  const stream = fs.createReadStream(artifact.absolutePath);
  stream.on('error', (error) => {
    console.error('launcher artifact stream error:', error);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'Failed to stream artifact.' });
    } else {
      res.end();
    }
  });

  stream.pipe(res);
}

export async function requireLauncherArtifactAccessAndSend(req, res, artifactType) {
  const access = await verifyLauncherArtifactAccess(req);
  if (!access.ok) {
    if (access.status === 401) {
      return unauthorized(res, access.message);
    }
    return forbidden(res, access.message);
  }

  return sendArtifactFile(req, res, artifactType, {
    uid: access.uid,
    uidShort: access.uidShort,
    subscription: access.subscription,
    ip: access.ip
  });
}
