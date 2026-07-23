import express from 'express';
import { getFirebaseAdmin } from '../firebase.js';

function getFirstName(value, fallback = 'there') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  return text.split(/\s+/)[0] || fallback;
}

function formatActivatedOnLabel(date) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function toIso(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  return '';
}

export default function createPhotosSetupRouter({ firebaseServiceAccountPath, requireSession }) {
  const router = express.Router();

  router.post('/photos/setup', ...(typeof requireSession === 'function' ? [requireSession] : []), async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const photosMetaRef = userRef.collection('photos').doc('meta');
      const welcomePhotoRef = userRef.collection('photos').doc('welcome-iclora');
      const defaultPhotoRef = userRef.collection('photos').doc('iclora-default-photo');

      const [userSnapshot, metaSnapshot, welcomeSnapshot, defaultPhotoSnapshot] = await Promise.all([
        userRef.get(),
        photosMetaRef.get(),
        welcomePhotoRef.get(),
        defaultPhotoRef.get(),
      ]);

      const user = userSnapshot.exists ? userSnapshot.data() || {} : {};
      const firstName = getFirstName(user?.name, 'there');
      const activatedOnDate = new Date();
      const activatedOnLabel = formatActivatedOnLabel(activatedOnDate);
      const metaData = metaSnapshot.exists ? (metaSnapshot.data() || {}) : null;
      const alreadyActive = metaData?.active === true;
      const responseActivatedOnLabel = (typeof metaData?.activatedOnLabel === 'string' && metaData.activatedOnLabel.trim())
        ? metaData.activatedOnLabel
        : activatedOnLabel;

      const batch = db.batch();
      if (userSnapshot.exists) {
        batch.update(userRef, {
          photos: fbAdmin.firestore.FieldValue.delete(),
        });
      }

      batch.set(
        photosMetaRef,
        {
          type: 'meta',
          status: 'activate',
          active: true,
          storageUsed: typeof metaData?.storageUsed === 'number' ? metaData.storageUsed : 0,
          deletedStorageUsed: typeof metaData?.deletedStorageUsed === 'number' ? metaData.deletedStorageUsed : 0,
          totalStorageUsed: typeof metaData?.totalStorageUsed === 'number'
            ? metaData.totalStorageUsed
            : ((typeof metaData?.storageUsed === 'number' ? metaData.storageUsed : 0) + (typeof metaData?.deletedStorageUsed === 'number' ? metaData.deletedStorageUsed : 0)),
          activatedOn: metaData?.activatedOn || fbAdmin.firestore.FieldValue.serverTimestamp(),
          activatedOnLabel: responseActivatedOnLabel,
          photosCount: typeof metaData?.photosCount === 'number' ? Math.max(1, metaData.photosCount) : 1,
          videosCount: typeof metaData?.videosCount === 'number' ? Math.max(0, metaData.videosCount) : 0,
          itemsCount: typeof metaData?.itemsCount === 'number' ? Math.max(1, metaData.itemsCount) : 1,
          updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (!defaultPhotoSnapshot.exists) {
        batch.set(defaultPhotoRef, {
          type: 'photo',
          title: 'Welcome to iClora',
          publicId: '',
          staticSrc: '/pwa-icon-512.png',
          resourceType: 'image',
          format: 'png',
          mimeType: 'image/png',
          bytes: 0,
          storageUsed: 0,
          width: 512,
          height: 512,
          favourite: false,
          hidden: false,
          deleted: false,
          locked: true,
          system: true,
          date: responseActivatedOnLabel,
          shortDate: responseActivatedOnLabel,
          uploadedAt: toIso(metaData?.activatedOn) || activatedOnDate.toISOString(),
          createdAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          createdBy: 'iClora',
        });
      }

      if (!welcomeSnapshot.exists) {
        batch.set(welcomePhotoRef, {
          type: 'photo-message',
          title: 'Welcome to iClora Photos',
          from: 'iClora',
          greeting: `Hello ${firstName}`,
          content: `Hello ${firstName}, your Photos Cloud was activated on ${activatedOnLabel}. Your gallery is ready and safely set up with iClora.`,
          storageUsed: 0,
          createdAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          createdAtLabel: activatedOnLabel,
          createdBy: 'iClora',
          system: true,
        });
      }

      await batch.commit();

      return res.json({
        ok: true,
        alreadyActive,
        activatedOnLabel: responseActivatedOnLabel,
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Failed to activate photos' });
    }
  });

  return router;
}
