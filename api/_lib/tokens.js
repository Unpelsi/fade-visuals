import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { adminDb } from './firebase-admin.js';

const ACCESS_TTL_SECONDS = Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 7 * 24 * 60 * 60); // 7 дней
const REFRESH_TTL_SECONDS = Number(process.env.REFRESH_TOKEN_TTL_SECONDS || 90 * 24 * 60 * 60); // 90 дней
const LAUNCH_TTL_SECONDS = Number(process.env.LAUNCH_TOKEN_TTL_SECONDS || 5 * 60); // 5 минут

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function nowMs() {
  return Date.now();
}

function getAccessSecret() {
  return String(
    process.env.ACCESS_TOKEN_SECRET
    || process.env.JWT_SECRET
    || process.env.DOWNLOAD_LINK_SECRET
    || 'aura-access-secret-dev'
  ).trim();
}

function getRefreshSecret() {
  return String(
    process.env.REFRESH_TOKEN_SECRET
    || process.env.ACCESS_TOKEN_SECRET
    || process.env.JWT_SECRET
    || 'aura-refresh-secret-dev'
  ).trim();
}

function getLaunchSecret() {
  return String(
    process.env.LAUNCH_TOKEN_SECRET
    || process.env.ACCESS_TOKEN_SECRET
    || process.env.JWT_SECRET
    || 'aura-launch-secret-dev'
  ).trim();
}

export function createAccessToken({ uid, uidShort, sid, deviceId = '', tokenVersion = 1 }) {
  const secret = getAccessSecret();
  const iat = nowSeconds();
  const exp = iat + ACCESS_TTL_SECONDS;

  const payload = {
    sub: uid,
    uidShort: String(uidShort || ''),
    sid: String(sid || ''),
    deviceId: String(deviceId || ''),
    tv: Number(tokenVersion || 1),
    iat,
    exp,
    iss: String(process.env.TOKEN_ISSUER || process.env.APP_URL || 'aura')
  };

  const token = jwt.sign(payload, secret, {
    algorithm: 'HS256',
    noTimestamp: true
  });

  return { token, iat, exp };
}

export async function createRefreshToken({ uid, sid, deviceId = '', tokenVersion = 1 }) {
  const secret = getRefreshSecret();
  const iat = nowSeconds();
  const exp = iat + REFRESH_TTL_SECONDS;
  const jti = crypto.randomUUID();

  const payload = {
    sub: uid,
    sid: String(sid || ''),
    deviceId: String(deviceId || ''),
    tv: Number(tokenVersion || 1),
    jti,
    iat,
    exp,
    iss: String(process.env.TOKEN_ISSUER || process.env.APP_URL || 'aura')
  };

  const token = jwt.sign(payload, secret, {
    algorithm: 'HS256',
    noTimestamp: true
  });

  const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  await adminDb.ref(`refresh_tokens/${hash}`).set({
    uid,
    sid: String(sid || ''),
    deviceId: String(deviceId || ''),
    tokenVersion: Number(tokenVersion || 1),
    jti,
    used: false,
    issuedAt: iat * 1000,
    expiresAt: exp * 1000
  });

  return { token, iat, exp, hash };
}

export function createLaunchToken({
  uid,
  uidShort,
  sid,
  hwidHash,
  deviceId = '',
  tokenVersion = 1,
  launcherVersion = ''
}) {
  const secret = getLaunchSecret();
  const iat = nowSeconds();
  const exp = iat + LAUNCH_TTL_SECONDS;

  const payload = {
    sub: String(uid || ''),
    uidShort: String(uidShort || ''),
    sid: String(sid || ''),
    hwidHash: String(hwidHash || ''),
    deviceId: String(deviceId || ''),
    tv: Number(tokenVersion || 1),
    lv: String(launcherVersion || ''),
    typ: 'launch',
    iat,
    exp,
    iss: String(process.env.TOKEN_ISSUER || process.env.APP_URL || 'aura')
  };

  const token = jwt.sign(payload, secret, {
    algorithm: 'HS256',
    noTimestamp: true
  });

  return { token, iat, exp };
}

export function verifyAccessToken(token) {
  try {
    const decoded = jwt.verify(String(token || ''), getAccessSecret(), {
      algorithms: ['HS256']
    });
    return { ok: true, decoded };
  } catch (error) {
    return { ok: false, message: error?.message || 'Invalid access token.' };
  }
}

export function verifyRefreshToken(token) {
  try {
    const decoded = jwt.verify(String(token || ''), getRefreshSecret(), {
      algorithms: ['HS256']
    });
    return { ok: true, decoded };
  } catch (error) {
    return { ok: false, message: error?.message || 'Invalid refresh token.' };
  }
}

export function verifyLaunchToken(token) {
  try {
    const decoded = jwt.verify(String(token || ''), getLaunchSecret(), {
      algorithms: ['HS256']
    });
    if (String(decoded?.typ || '') !== 'launch') {
      return { ok: false, message: 'Invalid launch token type.' };
    }
    return { ok: true, decoded };
  } catch (error) {
    return { ok: false, message: error?.message || 'Invalid launch token.' };
  }
}

export async function rotateRefreshToken(refreshToken) {
  const verify = verifyRefreshToken(refreshToken);
  if (!verify.ok) {
    return { ok: false, message: verify.message };
  }

  const decoded = verify.decoded || {};
  const hash = crypto.createHash('sha256').update(String(refreshToken || ''), 'utf8').digest('hex');
  const tokenRef = adminDb.ref(`refresh_tokens/${hash}`);
  const tokenSnapshot = await tokenRef.get();
  if (!tokenSnapshot.exists()) {
    return { ok: false, message: 'Refresh token not found.' };
  }

  const tokenData = tokenSnapshot.val() || {};
  if (tokenData.used === true) {
    return { ok: false, message: 'Refresh token already used.' };
  }
  if (Number(tokenData.expiresAt || 0) <= nowMs()) {
    return { ok: false, message: 'Refresh token expired.' };
  }

  await tokenRef.set({
    ...tokenData,
    used: true,
    rotatedAt: nowMs()
  });

  const uid = String(decoded.sub || tokenData.uid || '').trim();
  const sid = String(decoded.sid || tokenData.sid || '').trim();
  const deviceId = String(decoded.deviceId || tokenData.deviceId || '').trim();
  const tokenVersion = Number(decoded.tv || tokenData.tokenVersion || 1);

  const access = createAccessToken({
    uid,
    uidShort: '',
    sid,
    deviceId,
    tokenVersion
  });
  const refresh = await createRefreshToken({
    uid,
    sid,
    deviceId,
    tokenVersion
  });

  return {
    ok: true,
    uid,
    sid,
    deviceId,
    tokenVersion,
    accessToken: access.token,
    accessExpiresAt: access.exp * 1000,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.exp * 1000
  };
}

export async function revokeRefreshTokensForSession(sid) {
  const target = String(sid || '').trim();
  if (!target) {
    return 0;
  }

  const snapshot = await adminDb.ref('refresh_tokens').get();
  if (!snapshot.exists()) {
    return 0;
  }

  const removals = [];
  snapshot.forEach((child) => {
    const data = child.val() || {};
    if (String(data.sid || '') === target) {
      removals.push(adminDb.ref(`refresh_tokens/${child.key}`).remove());
    }
  });

  await Promise.all(removals);
  return removals.length;
}
