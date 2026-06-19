import crypto from 'crypto';
import { webApiKey } from './firebase.js';
import { adminDb } from './firebase-admin.js';

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000);
const HWID_RESET_WINDOW_MS = Number(process.env.HWID_RESET_WINDOW_MS || 30 * 24 * 60 * 60 * 1000);
const FREE_HWID_RESETS_PER_WINDOW = Number(process.env.FREE_HWID_RESETS_PER_WINDOW || 0);

const SUBS_WITHOUT_EXPIRY = new Set(['lifetime', 'beta']);

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nowMs() {
  return Date.now();
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export function normalizeUsername(rawUsername) {
  return String(rawUsername || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24);
}

export function usernameToEmail(username) {
  const normalized = normalizeUsername(username);
  return normalized ? `${normalized}@aura.local` : '';
}

export function emailToUsername(email) {
  const raw = String(email || '').trim().toLowerCase();
  if (!raw) {
    return '';
  }

  if (raw.endsWith('@aura.local')) {
    return normalizeUsername(raw.slice(0, raw.indexOf('@')));
  }

  return normalizeUsername(raw.split('@')[0]);
}

export function hashToken(token) {
  return sha256Hex(token);
}

export function normalizeHwidHash(hwidRaw) {
  const trimmed = String(hwidRaw || '').trim();
  if (!trimmed) {
    return '';
  }

  const asLower = trimmed.toLowerCase();
  if (/^[a-f0-9]{64}$/.test(asLower)) {
    return asLower;
  }

  return sha256Hex(trimmed);
}

export function normalizeUidShort(rawUidShort) {
  const value = String(rawUidShort || '').trim();
  if (!value) {
    return '';
  }

  if (/^\d+$/.test(value)) {
    return String(Number(value));
  }

  const legacyMatch = value.match(/(\d+)/);
  if (legacyMatch) {
    return String(Number(legacyMatch[1]));
  }

  return '';
}

async function allocateSequentialUidShort() {
  const counterRef = adminDb.ref('meta/counters/userUidShort');
  const result = await counterRef.transaction((currentValue) => {
    const currentNumber = Number(currentValue || 0);
    return currentNumber + 1;
  });

  if (!result.committed) {
    throw new Error('Failed to allocate sequential uidShort.');
  }

  return String(Number(result.snapshot.val() || 0));
}

function resolveSubscriptionRaw(user) {
  return String(user?.subscription || 'none').toLowerCase();
}

function resolveExpiresAt(user) {
  return toNumber(user?.subscriptionExpiresAt, 0);
}

export function isSubscriptionActive(user, now = nowMs()) {
  const subscription = resolveSubscriptionRaw(user);
  if (subscription === 'none') {
    return false;
  }

  if (SUBS_WITHOUT_EXPIRY.has(subscription)) {
    return true;
  }

  return resolveExpiresAt(user) > now;
}

export function getSubscriptionState(user, now = nowMs()) {
  const subscription = resolveSubscriptionRaw(user);
  const expiresAt = resolveExpiresAt(user);
  const active = isSubscriptionActive(user, now);

  return {
    active,
    subscription: active ? subscription : 'none',
    subscriptionExpiresAt: expiresAt > 0 ? expiresAt : null
  };
}

export async function signUpEmailPassword(email, password) {
  if (!webApiKey) {
    return { ok: false, message: 'Firebase API key is not configured.' };
  }

  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${webApiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      message: payload?.error?.message || 'Registration failed.'
    };
  }

  return {
    ok: true,
    uid: payload.localId,
    email: payload.email,
    idToken: payload.idToken
  };
}

export async function signUpUsernamePassword(username, password) {
  const email = usernameToEmail(username);
  if (!email) {
    return { ok: false, message: 'Username is required.' };
  }

  const result = await signUpEmailPassword(email, password);
  if (!result.ok) {
    return result;
  }

  return {
    ...result,
    email,
    username: emailToUsername(email)
  };
}

export async function authenticateEmailPassword(email, password) {
  if (!webApiKey) {
    return { ok: false, message: 'Firebase API key is not configured.' };
  }

  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${webApiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      password,
      returnSecureToken: true
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      message: payload?.error?.message || 'Invalid credentials.'
    };
  }

  return {
    ok: true,
    uid: payload.localId,
    email: payload.email,
    idToken: payload.idToken
  };
}

export async function authenticateUsernamePassword(username, password) {
  const email = usernameToEmail(username);
  if (!email) {
    return { ok: false, message: 'Username is required.' };
  }

  const result = await authenticateEmailPassword(email, password);
  if (!result.ok) {
    return result;
  }

  return {
    ...result,
    email,
    username: emailToUsername(email)
  };
}

export async function getUserByUid(uid) {
  const userSnapshot = await adminDb.ref(`users/${uid}`).get();
  if (!userSnapshot.exists()) {
    return null;
  }

  return userSnapshot.val();
}

export async function ensureUserRecord(uid, email, username = '') {
  const userRef = adminDb.ref(`users/${uid}`);
  const entitlementRef = adminDb.ref(`entitlements/${uid}`);
  const snapshot = await userRef.get();
  const normalizedUsername = normalizeUsername(username || emailToUsername(email));

  if (!snapshot.exists()) {
    const now = nowMs();
    const uidShort = await allocateSequentialUidShort();
    const freshUser = {
      email,
      username: normalizedUsername || null,
      role: 'user',
      status: 'active',
      subscription: 'none',
      subscriptionExpiresAt: null,
      hwidHash: null,
      uidShort,
      resetCredits: FREE_HWID_RESETS_PER_WINDOW,
      resetWindowStart: now,
      banned: false,
      createdAt: now,
      lastLoginAt: null
    };

    await userRef.set(freshUser);
    await entitlementRef.set({
      plan: 'none',
      state: 'pending',
      expiresAt: null,
      source: 'init',
      updatedAt: now
    });
    return freshUser;
  }

  const existing = snapshot.val() || {};
  const patch = {};

  if (!existing.email && email) {
    patch.email = email;
  }

  if (!existing.username && normalizedUsername) {
    patch.username = normalizedUsername;
  }

  const normalizedExistingUidShort = normalizeUidShort(existing.uidShort);
  if (!normalizedExistingUidShort) {
    patch.uidShort = await allocateSequentialUidShort();
  } else if (String(existing.uidShort) !== normalizedExistingUidShort) {
    patch.uidShort = normalizedExistingUidShort;
  }

  if (existing.resetCredits === undefined || existing.resetCredits === null) {
    patch.resetCredits = FREE_HWID_RESETS_PER_WINDOW;
  }

  if (!existing.resetWindowStart) {
    patch.resetWindowStart = nowMs();
  }

  if (existing.banned === undefined) {
    patch.banned = false;
  }

  if (Object.keys(patch).length > 0) {
    await userRef.update(patch);
  }

  const entitlementSnapshot = await entitlementRef.get();
  if (!entitlementSnapshot.exists()) {
    await entitlementRef.set({
      plan: resolveSubscriptionRaw(existing),
      state: isSubscriptionActive(existing) ? 'active' : 'pending',
      expiresAt: resolveExpiresAt(existing) || null,
      source: 'legacy_sync',
      updatedAt: nowMs()
    });
  }

  return { ...existing, ...patch };
}

export async function getEntitlement(uid) {
  const snapshot = await adminDb.ref(`entitlements/${uid}`).get();
  if (!snapshot.exists()) {
    return null;
  }
  return snapshot.val() || null;
}

export function resolveEntitlementState(user, entitlement, now = nowMs()) {
  const fromLegacy = getSubscriptionState(user, now);
  const ent = entitlement || {};
  const state = String(ent.state || '').toLowerCase();
  const plan = String(ent.plan || fromLegacy.subscription || 'none').toLowerCase();
  const expiresAt = toNumber(ent.expiresAt, fromLegacy.subscriptionExpiresAt || 0);

  if (state === 'revoked' || state === 'blocked') {
    return { active: false, state: 'revoked', plan: 'none', expiresAt: null };
  }

  if (state === 'active') {
    if (SUBS_WITHOUT_EXPIRY.has(plan) || !expiresAt || expiresAt > now) {
      return { active: true, state: 'active', plan, expiresAt: expiresAt || null };
    }
  }

  if (fromLegacy.active) {
    return {
      active: true,
      state: 'active',
      plan: fromLegacy.subscription,
      expiresAt: fromLegacy.subscriptionExpiresAt
    };
  }

  return { active: false, state: state || 'pending', plan: 'none', expiresAt: expiresAt || null };
}

export function evaluateHwidPolicy(user, hwidHash, now = nowMs()) {
  if (!hwidHash) {
    return { allowed: false, patch: {}, message: 'HWID is required.' };
  }

  if (!user?.hwidHash) {
    return {
      allowed: true,
      patch: {
        hwidHash
      },
      reason: 'bound_first_time'
    };
  }

  if (String(user.hwidHash) === hwidHash) {
    return { allowed: true, patch: {}, reason: 'same_hwid' };
  }

  let resetWindowStart = toNumber(user.resetWindowStart, 0);
  let resetCredits = toNumber(user.resetCredits, FREE_HWID_RESETS_PER_WINDOW);

  if (!resetWindowStart || now - resetWindowStart > HWID_RESET_WINDOW_MS) {
    resetWindowStart = now;
    resetCredits = FREE_HWID_RESETS_PER_WINDOW;
  }

  if (resetCredits > 0) {
    return {
      allowed: false,
      patch: {
        resetCredits,
        resetWindowStart
      },
      message: 'HWID mismatch. Free reset available in website dashboard only.'
    };
  }

  const mismatchStrikes = toNumber(user.mismatchStrikes, 0) + 1;
  const cooldownMs = Math.min(15 * 60 * 1000, Math.pow(2, Math.min(mismatchStrikes, 8)) * 1000);
  return {
    allowed: false,
    patch: {
      resetCredits,
      resetWindowStart,
      mismatchStrikes,
      cooldownUntil: now + cooldownMs
    },
    message: 'HWID mismatch. Free reset exhausted. Buy paid HWID reset.'
  };
}

export async function consumeManualHwidReset(uid, now = nowMs()) {
  const targetUid = String(uid || '').trim();
  if (!targetUid) {
    return { ok: false, message: 'User id is required.' };
  }

  const userRef = adminDb.ref(`users/${targetUid}`);
  const snapshot = await userRef.get();
  if (!snapshot.exists()) {
    return { ok: false, message: 'User not found.' };
  }

  const user = snapshot.val() || {};
  if (!user.hwidHash) {
    return { ok: false, message: 'HWID is not bound.' };
  }

  let resetWindowStart = toNumber(user.resetWindowStart, 0);
  let resetCredits = toNumber(user.resetCredits, FREE_HWID_RESETS_PER_WINDOW);

  if (!resetWindowStart || now - resetWindowStart > HWID_RESET_WINDOW_MS) {
    resetWindowStart = now;
    resetCredits = FREE_HWID_RESETS_PER_WINDOW;
  }

  if (resetCredits <= 0) {
    return { ok: false, message: 'No HWID reset credits available.' };
  }

  resetCredits -= 1;
  await userRef.update({
    hwidHash: null,
    resetCredits,
    resetWindowStart,
    lastHwidResetAt: now,
    mismatchStrikes: 0,
    cooldownUntil: 0
  });

  await revokeAllSessionsForUid(targetUid);

  return {
    ok: true,
    remainingResetCredits: resetCredits,
    resetWindowStart
  };
}

export async function createSession(uid, hwidHash, launcherVersion = 'unknown', deviceId = '', deviceFingerprintHash = '') {
  const issuedAt = nowMs();
  const expiresAt = issuedAt + SESSION_TTL_MS;

  const sessionToken = crypto.randomBytes(32).toString('base64url');
  const sessionTokenHash = hashToken(sessionToken);

  await adminDb.ref(`sessions/${sessionTokenHash}`).set({
    uid,
    deviceId: String(deviceId || '').trim(),
    deviceFingerprintHash: String(deviceFingerprintHash || '').trim(),
    hwidHash,
    issuedAt,
    expiresAt,
    lastSeenAt: issuedAt,
    launcherVersion
  });

  return {
    sessionToken,
    sessionTokenHash,
    sessionExpiresAt: expiresAt
  };
}

export async function revokeAllSessionsForUid(uid) {
  const targetUid = String(uid || '').trim();
  if (!targetUid) {
    return 0;
  }

  const sessionsSnapshot = await adminDb.ref('sessions').get();
  if (!sessionsSnapshot.exists()) {
    return 0;
  }

  const removals = [];
  sessionsSnapshot.forEach((child) => {
    const session = child.val() || {};
    if (String(session.uid || '') === targetUid) {
      removals.push(adminDb.ref(`sessions/${child.key}`).remove());
    }
  });

  if (removals.length > 0) {
    await Promise.all(removals);
  }

  return removals.length;
}

export async function verifySessionToken(sessionToken, hwidHash, options = {}) {
  const token = String(sessionToken || '').trim();
  const hwid = normalizeHwidHash(hwidHash);

  if (!token || !hwid) {
    return { valid: false, message: 'sessionToken and hwidHash are required.' };
  }

  const tokenHash = hashToken(token);
  const now = nowMs();
  const touchSession = options.touchSession !== false;

  const sessionSnapshot = await adminDb.ref(`sessions/${tokenHash}`).get();
  if (!sessionSnapshot.exists()) {
    return { valid: false, message: 'Session not found.' };
  }

  const session = sessionSnapshot.val() || {};
  if (toNumber(session.expiresAt, 0) <= now) {
    return { valid: false, message: 'Session expired.' };
  }

  if (String(session.hwidHash || '') !== hwid) {
    return { valid: false, message: 'HWID mismatch.' };
  }

  const revocationsSnapshot = await adminDb.ref('revocations/global').get();
  if (revocationsSnapshot.exists()) {
    const revocations = revocationsSnapshot.val() || {};
    const minTokenIat = toNumber(revocations.minTokenIat, 0);
    const blockedUids = Array.isArray(revocations.blockedUids) ? revocations.blockedUids.map(String) : [];
    const blockedHwids = Array.isArray(revocations.blockedHwids) ? revocations.blockedHwids.map((item) => normalizeHwidHash(item)) : [];
    if (minTokenIat > 0 && toNumber(session.issuedAt, 0) < minTokenIat) {
      return { valid: false, message: 'Session globally revoked.' };
    }
    if (blockedHwids.includes(hwid)) {
      return { valid: false, message: 'HWID blocked.' };
    }
    if (blockedUids.includes(String(session.uid || ''))) {
      return { valid: false, message: 'User blocked.' };
    }
  }

  const user = await getUserByUid(session.uid);
  if (!user) {
    return { valid: false, message: 'User not found.' };
  }

  if (user.banned === true) {
    await revokeAllSessionsForUid(session.uid);
    return { valid: false, message: 'User is banned.' };
  }

  const entitlement = await getEntitlement(session.uid);
  const entitlementState = resolveEntitlementState(user, entitlement, now);
  if (!entitlementState.active) {
    return { valid: false, message: 'Subscription inactive.' };
  }

  const patch = {};
  const normalizedExistingUidShort = normalizeUidShort(user.uidShort);
  if (!normalizedExistingUidShort) {
    patch.uidShort = await allocateSequentialUidShort();
  } else if (String(user.uidShort) !== normalizedExistingUidShort) {
    patch.uidShort = normalizedExistingUidShort;
  }

  if (Object.keys(patch).length > 0) {
    await adminDb.ref(`users/${session.uid}`).update(patch);
  }

  if (touchSession) {
    await adminDb.ref(`sessions/${tokenHash}`).update({ lastSeenAt: now });
  }

  const uidShort = patch.uidShort || normalizedExistingUidShort;

  return {
    valid: true,
    uid: session.uid,
    uidShort,
    email: user.email || null,
    username: user.username || emailToUsername(user.email),
    subscription: entitlementState.plan,
    sessionExpiresAt: toNumber(session.expiresAt, now)
  };
}

export async function writeAuditLog(eventType, payload = {}) {
  try {
    const dayKey = new Date().toISOString().slice(0, 10);
    const auditRoot = adminDb.ref(`audit/${dayKey}`);
    const eventRef = auditRoot.push();
    await eventRef.set({
      eventType,
      at: nowMs(),
      ...payload
    });
  } catch (error) {
    console.error('Audit log write failed:', error?.message || error);
  }
}

export function normalizeTier(rawTier) {
  const tier = String(rawTier || '').trim().toLowerCase();

  if (tier === '1_month' || tier === 'month' || tier === '1 месяц' || tier === '1 mesyac') {
    return '1_month';
  }
  if (tier === 'lifetime' || tier === 'навсегда') {
    return 'lifetime';
  }
  if (tier === 'beta') {
    return 'beta';
  }
  if (tier === 'hwid_reset' || tier === 'сброс hwid' || tier === 'reset_hwid') {
    return 'hwid_reset';
  }

  return tier;
}

export async function activateSubscriptionFromPayment(userId, tierRaw) {
  const tier = normalizeTier(tierRaw);
  const userRef = adminDb.ref(`users/${userId}`);
  const entitlementRef = adminDb.ref(`entitlements/${userId}`);
  const userSnapshot = await userRef.get();

  if (!userSnapshot.exists()) {
    throw new Error('User for payment not found.');
  }

  const user = userSnapshot.val() || {};
  const now = nowMs();

  if (tier === 'hwid_reset') {
    const currentCredits = toNumber(user.resetCredits, 0);
    await userRef.update({
      resetCredits: currentCredits + 1,
      paidResetCredits: toNumber(user.paidResetCredits, 0) + 1,
      lastPaidResetAt: now
    });
    await entitlementRef.update({
      updatedAt: now
    });
    return { appliedTier: tier, subscription: resolveSubscriptionRaw(user), subscriptionExpiresAt: resolveExpiresAt(user) || null };
  }

  if (tier === '1_month') {
    const currentExpires = resolveExpiresAt(user);
    const startFrom = Math.max(now, currentExpires);
    const newExpiresAt = startFrom + 30 * 24 * 60 * 60 * 1000;

    await userRef.update({
      subscription: '1_month',
      subscriptionExpiresAt: newExpiresAt,
      lastPaymentAt: now
    });
    await entitlementRef.set({
      plan: '1_month',
      state: 'active',
      expiresAt: newExpiresAt,
      source: 'payment',
      updatedAt: now
    });

    return { appliedTier: tier, subscription: '1_month', subscriptionExpiresAt: newExpiresAt };
  }

  if (tier === 'lifetime' || tier === 'beta') {
    await userRef.update({
      subscription: tier,
      subscriptionExpiresAt: null,
      lastPaymentAt: now
    });
    await entitlementRef.set({
      plan: tier,
      state: 'active',
      expiresAt: null,
      source: 'payment',
      updatedAt: now
    });

    return { appliedTier: tier, subscription: tier, subscriptionExpiresAt: null };
  }

  throw new Error(`Unsupported tier: ${tierRaw}`);
}

export async function findUserByHwidHash(hwidHash) {
  const normalized = normalizeHwidHash(hwidHash);
  if (!normalized) {
    return null;
  }

  const usersSnapshot = await adminDb.ref('users').get();
  if (!usersSnapshot.exists()) {
    return null;
  }

  let foundUser = null;
  usersSnapshot.forEach((child) => {
    if (foundUser) {
      return;
    }

    const data = child.val() || {};
    const hwidCandidate = normalizeHwidHash(data.hwidHash || data.hwid || '');
    if (hwidCandidate && hwidCandidate === normalized) {
      foundUser = {
        uid: child.key,
        ...data
      };
    }
  });

  return foundUser;
}
