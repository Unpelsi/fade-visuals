import { adminDb } from '../_lib/firebase-admin.js';
import {
  authenticateUsernamePassword,
  signUpUsernamePassword,
  createSession,
  ensureUserRecord,
  evaluateHwidPolicy,
  getEntitlement,
  resolveEntitlementState,
  normalizeHwidHash,
  normalizeUsername,
  writeAuditLog
} from '../_lib/license.js';
import { createAccessToken, createRefreshToken } from '../_lib/tokens.js';
import {
  badRequest,
  methodNotAllowed,
  serverError,
  tooManyRequests,
  unauthorized,
  getBody
} from '../_lib/http.js';
import { checkRateLimit, getClientIp } from '../_lib/rate-limit.js';
import { createDownloadToken, buildArtifactDownloadUrl } from '../_lib/download-links.js';

const LOGIN_LIMIT = Number(process.env.LAUNCHER_LOGIN_RATE_LIMIT || 12);
const LOGIN_WINDOW_MS = Number(process.env.LAUNCHER_LOGIN_WINDOW_MS || 10 * 60 * 1000);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res);
  }

  const ip = getClientIp(req);
  const limit = checkRateLimit(`launcher-login:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS);
  if (!limit.allowed) {
    return tooManyRequests(res, limit.retryAfterMs);
  }

  const body = getBody(req);
  const username = normalizeUsername(body.username || body.login || body.email || '');
  const password = String(body.password || '');
  const launcherVersion = String(body.launcherVersion || 'unknown').trim();
  const hwidHash = normalizeHwidHash(body.hwidHash || body.hwid || '');
  const deviceId = String(body.deviceId || '').trim().slice(0, 128) || hwidHash.slice(0, 16);
  const deviceFingerprintHash = normalizeHwidHash(body.deviceProof || body.deviceFingerprintHash || '');

  if (!username || !password || !hwidHash) {
    return badRequest(res, 'username, password and hwidHash are required.');
  }

  try {
    let auth = await authenticateUsernamePassword(username, password);
    if (!auth.ok) {
      if (auth.message === 'EMAIL_NOT_FOUND') {
        const reg = await signUpUsernamePassword(username, password);
        if (reg.ok) {
          auth = reg;
        } else {
          await writeAuditLog('launcher_registration_auto_failed', { ip, username, reason: reg.message });
          return unauthorized(res, reg.message || 'Auto-registration failed.');
        }
      } else {
        await writeAuditLog('launcher_login_failed', { ip, username, reason: auth.message || 'auth_failed' });
        return unauthorized(res, auth.message || 'Invalid credentials.');
      }
    }

    const user = await ensureUserRecord(auth.uid, auth.email || '', auth.username || username);
    if (user.banned === true) {
      await writeAuditLog('launcher_login_blocked_banned', {
        ip,
        uid: auth.uid,
        username
      });
      return res.status(403).json({ ok: false, error: 'User is banned.' });
    }

    const entitlement = await getEntitlement(auth.uid);
    const entitlementState = resolveEntitlementState(user, entitlement);
    if (!entitlementState.active) {
      await writeAuditLog('launcher_login_blocked_subscription', {
        ip,
        uid: auth.uid,
        username,
        subscription: entitlementState.plan || user.subscription || 'none'
      });
      return res.status(403).json({ ok: false, error: 'Subscription inactive.' });
    }

    const cooldownUntil = Number(user.cooldownUntil || 0);
    if (cooldownUntil > Date.now()) {
      return res.status(429).json({
        ok: false,
        error: 'Too many risky login attempts.',
        retryAfterMs: cooldownUntil - Date.now()
      });
    }

    const hwidDecision = evaluateHwidPolicy(user, hwidHash);
    if (Object.keys(hwidDecision.patch).length > 0) {
      await adminDb.ref(`users/${auth.uid}`).update(hwidDecision.patch);
    }

    if (!hwidDecision.allowed) {
      await writeAuditLog('launcher_login_blocked_hwid', {
        ip,
        uid: auth.uid,
        username,
        hwidHash,
        reason: hwidDecision.message
      });
      return res.status(403).json({ ok: false, error: hwidDecision.message });
    }

    const session = await createSession(auth.uid, hwidHash, launcherVersion, deviceId, deviceFingerprintHash);
    await adminDb.ref(`users/${auth.uid}`).update({
      lastLoginAt: Date.now(),
      mismatchStrikes: 0,
      cooldownUntil: 0
    });
    const uidShort = (hwidDecision.patch.uidShort || user.uidShort || 'AURA-000000').toUpperCase();
    const tokenVersion = Number(user.tokenVersion || 1);
    const access = createAccessToken({
      uid: auth.uid,
      uidShort,
      sid: session.sessionTokenHash,
      deviceId,
      tokenVersion
    });
    const refresh = await createRefreshToken({
      uid: auth.uid,
      sid: session.sessionTokenHash,
      deviceId,
      tokenVersion
    });

    await writeAuditLog('launcher_login_success', {
      ip,
      uid: auth.uid,
      username,
      hwidHash,
      launcherVersion,
      uidShort,
      sessionExpiresAt: session.sessionExpiresAt
    });

    const dlToken = createDownloadToken({
      type: 'client',
      uid: auth.uid,
      ip
    });

    return res.status(200).json({
      ok: true,
      sessionToken: session.sessionToken,
      uidShort,
      subscription: entitlementState.plan,
      sessionExpiresAt: session.sessionExpiresAt,
      accessToken: access.token,
      refreshToken: refresh.token,
      accessTokenExpiresAt: access.exp * 1000,
      refreshTokenExpiresAt: refresh.exp * 1000,
      clientDownloadUrl: buildArtifactDownloadUrl(req, dlToken.token),
      user: {
        uid: auth.uid,
        email: auth.email || null,
        username: user.username || auth.username || username
      },
      device: {
        deviceId
      }
    });
  } catch (error) {
    console.error('launcher/login error:', error);
    return serverError(res, 'Internal server error.', error?.message);
  }
}
