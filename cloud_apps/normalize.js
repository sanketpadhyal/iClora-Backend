import express from 'express';
import { getFirebaseAdmin } from '../firebase.js';

export default function createCloudAppsNormalizeRouter({ firebaseServiceAccountPath, requireSession }) {
  const router = express.Router();

  if (typeof requireSession === 'function') {
    router.use(requireSession);
  }

  router.post('/cloud-apps/normalize', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const userSnapshot = await userRef.get();

      if (!userSnapshot.exists) {
        return res.json({ ok: true, cleaned: false });
      }

      await userRef.update({
        notes: fbAdmin.firestore.FieldValue.delete(),
        photos: fbAdmin.firestore.FieldValue.delete(),
        contacts: fbAdmin.firestore.FieldValue.delete(),
        storageused: fbAdmin.firestore.FieldValue.delete(),
      });

      return res.json({ ok: true, cleaned: true });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Failed to normalize cloud apps' });
    }
  });

  return router;
}
