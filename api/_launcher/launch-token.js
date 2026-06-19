import { adminDb } from '../_lib/firebase-admin.js';
import {
  badRequest,
  methodNotAllowed,
  serverError,
  tooManyRequests,
  unauthorized,
  forbidden,
  getBody
} from '../_lib/http.js';
import { checkRateLimit, getClientIp } from '../_lib/rate-limit.js';
import {
  getEntitlement,
  hashToken,
  normalizeHwidHash,
  normalizeUsername,
  resolveEntitlementState,
  verifySessionToken,
  writeAuditLog
} from '../_lib/license.js';
import { createLaunchToken, verifyAccessToken } from '../_lib/tokens.js';

const LAUNCH_TOKEN_LIMIT = Number(process.env.LAUNCHER_LAUNCH_TOKEN_RATE_LIMIT || 90);
const LAUNCH_TOKEN_WINDOW_MS = Number(process.env.LAUNCHER_LAUNCH_TOKEN_WINDOW_MS || 10 * 60 * 1000);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res);
  }

  const ip = getClientIp(req);
  const body = getBody(req);
  const sessionToken = String(body.sessionToken || body.token || '').trim();
  const accessToken = String(body.accessToken || body.bearer || '').trim();
  const hwidHash = normalizeHwidHash(body.hwidHash || body.hwid || '');
  const username = normalizeUsername(body.username || body.login || '');
  const launcherVersion = String(body.launcherVersion || 'unknown').trim().slice(0, 64);

  const limit = checkRateLimit(
    `launcher-launch-token:${ip}:${hwidHash || 'no-hwid'}`,
    LAUNCH_TOKEN_LIMIT,
    LAUNCH_TOKEN_WINDOW_MS
  );
  if (!limit.allowed) {
    return tooManyRequests(res, limit.retryAfterMs);
  }

  if (!sessionToken || !accessToken || !hwidHash) {
    return badRequest(res, 'sessionToken, accessToken and hwidHash are required.');
  }

  try {
    const verification = await verifySessionToken(sessionToken, hwidHash, { touchSession: true });
    if (!verification.valid) {
      await writeAuditLog('launcher_launch_token_denied_session', {
        ip,
        hwidHash,
        username,
        launcherVersion,
        reason: verification.message || 'invalid_session'
      });
      return unauthorized(res, verification.message || 'Session invalid.');
    }

    if (username && normalizeUsername(verification.username || '') && normalizeUsername(verification.username || '') !== username) {
      await writeAuditLog('launcher_launch_token_denied_username', {
        ip,
        uid: verification.uid,
        hwidHash,
        username,
        actualUsername: verification.username || '',
        launcherVersion
      });
      return forbidden(res, 'Username mismatch.');
    }

    const accessCheck = verifyAccessToken(accessToken);
    if (!accessCheck.ok) {
      await writeAuditLog('launcher_launch_token_denied_access', {
        ip,
        uid: verification.uid,
        hwidHash,
        username: verification.username || username || '',
        launcherVersion,
        reason: accessCheck.message || 'invalid_access_token'
      });
      return unauthorized(res, accessCheck.message || 'Access token invalid.');
    }

    const decoded = accessCheck.decoded || {};
    const sessionHash = hashToken(sessionToken);
    if (String(decoded.sub || '') !== String(verification.uid || '')) {
      await writeAuditLog('launcher_launch_token_denied_uid', {
        ip,
        uid: verification.uid,
        hwidHash,
        launcherVersion,
        reason: 'uid_mismatch'
      });
      return forbidden(res, 'Access token user mismatch.');
    }

    if (String(decoded.sid || '') !== sessionHash) {
      await writeAuditLog('launcher_launch_token_denied_sid', {
        ip,
        uid: verification.uid,
        hwidHash,
        launcherVersion,
        reason: 'session_mismatch'
      });
      return forbidden(res, 'Access token session mismatch.');
    }

    const sessionSnapshot = await adminDb.ref(`sessions/${sessionHash}`).get();
    const session = sessionSnapshot.exists() ? (sessionSnapshot.val() || {}) : {};
    if (String(session.deviceId || '') && String(decoded.deviceId || '') !== String(session.deviceId || '')) {
      await writeAuditLog('launcher_launch_token_denied_device', {
        ip,
        uid: verification.uid,
        hwidHash,
        launcherVersion,
        reason: 'device_mismatch'
      });
      return forbidden(res, 'Access token device mismatch.');
    }

    const userSnapshot = await adminDb.ref(`users/${verification.uid}`).get();
    const user = userSnapshot.exists() ? (userSnapshot.val() || {}) : null;
    if (!user) {
      await writeAuditLog('launcher_launch_token_denied_user_missing', {
        ip,
        uid: verification.uid,
        hwidHash,
        launcherVersion
      });
      return unauthorized(res, 'User not found.');
    }

    if (user.banned === true) {
      await writeAuditLog('launcher_launch_token_denied_banned', {
        ip,
        uid: verification.uid,
        hwidHash,
        launcherVersion
      });
      return forbidden(res, 'User is banned.');
    }

    const tokenVersion = Number(user.tokenVersion || 1);
    if (Number(decoded.tv || 1) !== tokenVersion) {
      await writeAuditLog('launcher_launch_token_denied_version', {
        ip,
        uid: verification.uid,
        hwidHash,
        launcherVersion,
        tokenVersion,
        reason: 'token_version_mismatch'
      });
      return forbidden(res, 'Access token version mismatch.');
    }

    const entitlement = await getEntitlement(verification.uid);
    const entitlementState = resolveEntitlementState(user, entitlement);
    if (!entitlementState.active) {
      await writeAuditLog('launcher_launch_token_denied_subscription', {
        ip,
        uid: verification.uid,
        hwidHash,
        launcherVersion,
        subscription: entitlementState.plan || 'none'
      });
      return forbidden(res, 'Subscription inactive.');
    }

    const launch = createLaunchToken({
      uid: verification.uid,
      uidShort: verification.uidShort,
      sid: sessionHash,
      hwidHash,
      deviceId: String(session.deviceId || decoded.deviceId || ''),
      tokenVersion,
      launcherVersion
    });

    await writeAuditLog('launcher_launch_token_issued', {
      ip,
      uid: verification.uid,
      uidShort: verification.uidShort,
      hwidHash,
      launcherVersion,
      subscription: entitlementState.plan || verification.subscription || 'none',
      expiresAt: launch.exp * 1000
    });

    return res.status(200).json({
      ok: true,
      launchToken: launch.token,
      tokenType: 'launch',
      serverIssued: true,
      expiresIn: Math.max(0, launch.exp - launch.iat),
      expiresAtUnix: launch.exp,
      uidShort: verification.uidShort,
      subscription: entitlementState.plan || verification.subscription || 'none'
    });
  } catch (error) {
    console.error('launcher/launch-token error:', error);
    return serverError(res, 'Internal server error.', error?.message);
  }
}
