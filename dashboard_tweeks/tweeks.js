import express from 'express';
import { getFirebaseAdmin } from '../firebase.js';

function normalizeHexColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export default function createDashboardTweaksRouter({ firebaseServiceAccountPath }) {
  const router = express.Router();

  router.get('/me', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const snap = await db.collection('users').doc(uid).get();
      const user = snap.exists ? snap.data() || {} : {};
      const accent = normalizeHexColor(user?.ui?.dashboardAccentColor) || '';

      return res.json({ ok: true, dashboardAccentColor: accent });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Failed to read dashboard tweaks' });
    }
  });

  router.put('/me', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const nextAccent = normalizeHexColor(req.body?.dashboardAccentColor || req.body?.backgroundColor);
      if (!nextAccent) {
        return res.status(400).json({ ok: false, error: 'dashboardAccentColor must be a hex color like #46a935' });
      }

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      await db.collection('users').doc(uid).set(
        {
          ui: {
            dashboardAccentColor: nextAccent,
            dashboardAccentUpdatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );

      return res.json({ ok: true, dashboardAccentColor: nextAccent });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Failed to update dashboard tweaks' });
    }
  });

  return router;
}

