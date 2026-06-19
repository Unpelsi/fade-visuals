import fs from 'fs';
import { readArtifactMeta } from './_lib/artifacts.js';
import { adminDb } from './_lib/firebase-admin.js';
import { verifyDownloadToken } from './_lib/download-links.js';
import { createHash } from 'crypto';
import { getEntitlement, resolveEntitlementState, writeAuditLog } from './_lib/license.js';

function readQueryToken(req) {
  const token = req?.query?.token;
  if (Array.isArray(token)) {
    return token[0] || '';
  }
  return String(token || '').trim();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let artifactType = String(req.query.type || '').trim();
  let userId = 'public';
  let tokenId = 'public-jti';
  let tokenPayload = {};

  const isPublicType = ['jre', 'assets'].includes(artifactType);

  if (!isPublicType) {
    const queryToken = readQueryToken(req);
    const verified = verifyDownloadToken(queryToken);
    if (!verified.valid) {
      return res.status(403).json({ ok: false, error: verified.message || 'Download link is invalid.' });
    }

    tokenPayload = verified.payload || {};
    artifactType = String(tokenPayload.type || '').trim();
    userId = String(tokenPayload.uid || '').trim();
    tokenId = String(tokenPayload.jti || '').trim();

    if (!artifactType || !userId || !tokenId) {
      return res.status(403).json({ ok: false, error: 'Download token payload is invalid.' });
    }
  }

  if (!['launcher', 'client', 'jre', 'assets'].includes(artifactType)) {
    return res.status(403).json({ ok: false, error: 'Unsupported artifact type.' });
  }

  try {
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();


    // Security checks ONLY for non-public artifacts
    if (!isPublicType) {
      if (tokenPayload.ip && String(tokenPayload.ip).trim() !== ip) {
        return res.status(403).json({ ok: false, error: 'Download token IP mismatch.' });
      }

/*
      const usedTokenKey = createHash('sha256').update(`${userId}:${tokenId}`, 'utf8').digest('hex');
      const usedSnapshot = await get(ref(db, `used_download_tokens/${usedTokenKey}`));
      if (usedSnapshot.exists()) {
        return res.status(403).json({ ok: false, error: 'Download token already used.' });
      }
*/

      const userSnapshot = await adminDb.ref(`users/${userId}`).get();
      const user = userSnapshot.exists() ? (userSnapshot.val() || {}) : {};
      if (user.banned === true) {
        return res.status(403).json({ ok: false, error: 'Account is banned.' });
      }

      const entitlement = await getEntitlement(userId);
      const entitlementState = resolveEntitlementState(user, entitlement);
      if (!entitlementState.active) {
        return res.status(403).json({ ok: false, error: 'Subscription inactive.' });
      }

/*
      // Mark token as used
      await set(ref(db, `used_download_tokens/${usedTokenKey}`), {
        uid: userId,
        type: artifactType,
        jti: tokenId,
        usedAt: Date.now(),
        ip
      });
*/
    }

    let artifact;
    try {
      artifact = readArtifactMeta(artifactType);
    } catch (error) {
      const message = String(error?.message || '');
      if (message.includes('Artifact file not found') || message.includes('Artifact path is not configured')) {
        return res.status(404).json({ ok: false, error: message || 'Artifact not found.' });
      }
      throw error;
    }

    if (artifact.isExternal && artifact.externalUrl) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Artifact-Version', artifact.version);
      res.setHeader('X-Artifact-Sha256', artifact.hash || '');
      await writeAuditLog('artifact_download_redirected', {
        uid: userId,
        type: artifactType,
        artifactName: artifact.fileName,
        ip,
        externalUrl: artifact.externalUrl
      });
      return res.redirect(302, artifact.externalUrl);
    }

    if (!fs.existsSync(artifact.absolutePath)) {
      console.error(`[DOWNLOAD] Artifact NOT found at: ${artifact.absolutePath}`);
      return res.status(404).json({ ok: false, error: 'Artifact not found.' });
    }

    console.log(`[DOWNLOAD] Serving artifact from: ${artifact.absolutePath}`);

    res.setHeader('Content-Type', artifact.contentType || 'application/octet-stream');
    res.setHeader('Content-Length', String(artifact.size));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.fileName}"`);
    res.setHeader('X-Artifact-Version', artifact.version);
    res.setHeader('X-Artifact-Sha256', artifact.hash);

    await writeAuditLog('artifact_download_started', {
      uid: userId,
      type: artifactType,
      artifactName: artifact.fileName,
      ip
    });

    const stream = fs.createReadStream(artifact.absolutePath);
    stream.on('error', (error) => {
      console.error('download stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'Failed to stream artifact.' });
      } else {
        res.end();
      }
    });

    stream.pipe(res);
  } catch (error) {
    console.error('download/artifact error:', error);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
}
