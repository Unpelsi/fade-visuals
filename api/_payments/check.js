import { badRequest, getBody, methodNotAllowed, serverError } from '../_lib/http.js';
import { adminDb } from '../_lib/firebase-admin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res);
  }

  const body = getBody(req);
  const paymentId = String(body.paymentId || '').trim();
  if (!paymentId) {
    return badRequest(res, 'paymentId is required.');
  }

  try {
    const paymentSnapshot = await adminDb.ref(`payments/${paymentId}`).get();
    if (!paymentSnapshot.exists()) {
      return res.status(404).json({ ok: false, error: 'Payment not found.' });
    }

    const payment = paymentSnapshot.val() || {};
    const status = String(payment.status || 'pending');

    return res.status(200).json({
      ok: true,
      paymentId,
      status,
      paid: status === 'completed',
      subscription: status === 'completed' ? String(payment.tier || 'none') : 'none'
    });
  } catch (error) {
    console.error('payments/check error:', error);
    return serverError(res, 'Internal server error.', error?.message);
  }
}
