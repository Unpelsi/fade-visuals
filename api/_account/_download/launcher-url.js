/**
 * GET /api/account/download/launcher-url
 *
 * Returns a signed download URL for the launcher executable.
 * Requires active subscription.
 */

import { verifyRequestAuth } from '../../_lib/auth.js';
import { resolveEntitlementState } from '../../_lib/license.js';
import { createDownloadToken, buildArtifactDownloadUrl } from '../../_lib/download-links.js';
import { methodNotAllowed, serverError, unauthorized, forbidden, extractBearerToken } from '../../_lib/http.js';

const DATABASE_URL = String(
  process.env.FIREBASE_DATABASE_URL ||
  'https://fade-client-default-rtdb.firebaseio.com'
).replace(/\/$/, '');

async function rtdbGet(path, idToken) {
  try {
    const url = `${DATABASE_URL}/${path}.json?auth=${encodeURIComponent(idToken)}`;
    const res = await fetch(url, { method: 'GET' });
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      return null;
    }
    if (!res.ok) {
      console.warn(`launcher-url: rtdbGet("${path}") returned ${res.status}`);
      return null;
    }
    const data = await res.json().catch(() => null);
    return data;
  } catch (err) {
    console.warn(`launcher-url: rtdbGet("${path}") failed:`, err?.message || err);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    const auth = await verifyRequestAuth(req);
    if (!auth.ok) {
      return unauthorized(res, auth.message || 'Unauthorized.');
    }

    const idToken = extractBearerToken(req);
    const user = (await rtdbGet(`users/${auth.uid}`, idToken)) || {};
    const entitlement = await rtdbGet(`entitlements/${auth.uid}`, idToken);
    const subState = resolveEntitlementState(user, entitlement);

    if (user.banned === true) {
      return forbidden(res, 'Account is banned.');
    }

    if (!subState.active) {
      return forbidden(res, 'Active subscription required to download launcher.');
    }

    const launcherMeta = (await rtdbGet('meta/launcher', idToken)) || {};
    const version = String(launcherMeta.version || '1.0.0');
    const sha256 = String(launcherMeta.sha256 || '');

    const { token, expiresAt } = createDownloadToken({
      type: 'launcher',
      uid: auth.uid,
      version
    });

    const url = buildArtifactDownloadUrl(req, token);

    return res.status(200).json({
      ok: true,
      url,
      expiresAt,
      version,
      sha256
    });
  } catch (error) {
    console.error('account/download/launcher-url error:', error);
    return serverError(res, 'Internal server error.', error?.message);
  }
}
