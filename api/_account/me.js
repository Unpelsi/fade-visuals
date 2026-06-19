/**
 * GET /api/account/me
 *
 * Returns the authenticated user's profile and subscription state.
 *
 * Uses Firebase REST API with the user's own ID token, so RTDB Security Rules
 * are satisfied (the request is made as the authenticated user). No Admin SDK
 * or service-account key required.
 */

import { verifyRequestAuth } from '../_lib/auth.js';
import { resolveEntitlementState } from '../_lib/license.js';
import { methodNotAllowed, serverError, unauthorized, extractBearerToken } from '../_lib/http.js';

const DATABASE_URL = String(
  process.env.FIREBASE_DATABASE_URL ||
  'https://fade-client-default-rtdb.firebaseio.com'
).replace(/\/$/, '');

/**
 * Read a RTDB node via REST API, authenticated as the requesting user.
 * Returns the parsed value, or null if not found / on any error.
 */
async function rtdbGet(path, idToken) {
  try {
    const url = `${DATABASE_URL}/${path}.json?auth=${encodeURIComponent(idToken)}`;
    const res = await fetch(url, { method: 'GET' });
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      return null;
    }
    if (!res.ok) {
      console.warn(`account/me: rtdbGet("${path}") returned ${res.status}`);
      return null;
    }
    const data = await res.json().catch(() => null);
    return data; // may be null if node doesn't exist
  } catch (err) {
    console.warn(`account/me: rtdbGet("${path}") failed:`, err?.message || err);
    return null;
  }
}

/**
 * Write / patch a RTDB node via REST API (PATCH = update, PUT = set).
 * Failures are silently ignored (non-fatal).
 */
async function rtdbPatch(path, data, idToken) {
  try {
    const url = `${DATABASE_URL}/${path}.json?auth=${encodeURIComponent(idToken)}`;
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (err) {
    console.warn(`account/me: rtdbPatch("${path}") failed:`, err?.message || err);
  }
}

/**
 * Allocate a sequential uidShort by running a conditional update loop.
 * Returns a string number, or '' on failure.
 */
async function allocateUidShort(idToken) {
  try {
    // Counter node — needs write access; may fail under restrictive rules, that's OK
    const url = `${DATABASE_URL}/meta/counters/userUidShort.json?auth=${encodeURIComponent(idToken)}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const getRes = await fetch(url);
      const current = (await getRes.json().catch(() => 0)) || 0;
      const next = Number(current) + 1;
      // Conditional write: only succeeds if value hasn't changed
      const putRes = await fetch(url + `&condition=true`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next)
      });
      if (putRes.ok) {
        return String(next);
      }
    }
    return '';
  } catch (_) {
    return '';
  }
}

/**
 * Ensure a user record exists in RTDB. Non-fatal — failures are silently ignored.
 */
async function ensureUserRecord(uid, email, username, idToken) {
  try {
    const existing = await rtdbGet(`users/${uid}`, idToken);
    if (existing === null || existing === undefined) {
      // Create fresh record
      const uidShort = await allocateUidShort(idToken);
      const now = Date.now();
      await fetch(`${DATABASE_URL}/users/${uid}.json?auth=${encodeURIComponent(idToken)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email || null,
          username: username || null,
          role: 'user',
          status: 'active',
          subscription: 'none',
          subscriptionExpiresAt: null,
          hwidHash: null,
          uidShort: uidShort || null,
          resetCredits: 0,
          resetWindowStart: now,
          banned: false,
          createdAt: now,
          lastLoginAt: null
        })
      });
      // Create entitlement record
      await fetch(`${DATABASE_URL}/entitlements/${uid}.json?auth=${encodeURIComponent(idToken)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: 'none',
          state: 'pending',
          expiresAt: null,
          source: 'init',
          updatedAt: now
        })
      });
    } else {
      // Patch missing fields
      const patch = {};
      if (!existing.email && email) patch.email = email;
      if (!existing.username && username) patch.username = username;
      if (existing.banned === undefined || existing.banned === null) patch.banned = false;
      if (existing.resetCredits === undefined || existing.resetCredits === null) patch.resetCredits = 0;
      if (!existing.uidShort) {
        const uidShort = await allocateUidShort(idToken);
        if (uidShort) patch.uidShort = uidShort;
      }
      if (Object.keys(patch).length > 0) {
        await rtdbPatch(`users/${uid}`, patch, idToken);
      }
    }
  } catch (err) {
    console.warn('account/me: ensureUserRecord failed (non-fatal):', err?.message || err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  try {
    // Verify the Firebase ID token
    const auth = await verifyRequestAuth(req);
    if (!auth.ok) {
      return unauthorized(res, auth.message || 'Unauthorized.');
    }

    // Keep the raw ID token for subsequent REST API calls
    const idToken = extractBearerToken(req);

    // Ensure user record exists (non-fatal)
    await ensureUserRecord(auth.uid, auth.email || null, auth.username || null, idToken);

    // Read the user profile
    const user = (await rtdbGet(`users/${auth.uid}`, idToken)) || {};

    // Read entitlement
    const entitlement = await rtdbGet(`entitlements/${auth.uid}`, idToken);

    const subState = resolveEntitlementState(user, entitlement);
    const role = String(user.role || '').toLowerCase() === 'admin' ? 'admin' : 'user';

    // Read payments — try user-scoped path first (`userPayments/{uid}`)
    const payments = [];
    const userPaymentsData = await rtdbGet(`userPayments/${auth.uid}`, idToken);
    if (userPaymentsData && typeof userPaymentsData === 'object') {
      for (const [key, data] of Object.entries(userPaymentsData)) {
        if (!data) continue;
        payments.push({
          paymentId: key,
          tier: data.tier || null,
          amount: data.amount ?? null,
          status: data.status || 'pending',
          providerTxId: data.providerTxId || null,
          createdAt: data.createdAt || null,
          processedAt: data.processedAt || null
        });
      }
    }

    payments.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

    return res.status(200).json({
      ok: true,
      uid: auth.uid,
      username: user.username || auth.username || null,
      email: user.email || auth.email || null,
      role,
      uidShort: user.uidShort || null,
      subscription: subState.plan,
      subscriptionExpiresAt: subState.expiresAt,
      entitlementState: subState.state,
      banned: user.banned === true,
      canDownloadLauncher: user.banned !== true && subState.active === true,
      hwidHash: user.hwidHash || user.hwid || null,
      resetCredits: Number(user.resetCredits || 0),
      paidResetCredits: Number(user.paidResetCredits || 0),
      lastHwidResetAt: user.lastHwidResetAt || null,
      payments: payments.slice(0, 10)
    });
  } catch (error) {
    console.error('account/me error:', error);
    return serverError(res, 'Internal server error.', error?.message);
  }
}
