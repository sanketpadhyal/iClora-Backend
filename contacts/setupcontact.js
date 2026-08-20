import express from 'express';
import { getFirebaseAdmin } from '../firebase.js';

const ICLORA_SUPPORT_EMAIL = 'icloraofficial@gmail.com';
const ICLORA_SUPPORT_PHONE = '8975659255';

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

function toMb(...parts) {
  const bytes = parts.reduce((total, part) => total + Buffer.byteLength(String(part || ''), 'utf8'), 0);
  return Number((bytes / (1024 * 1024)).toFixed(4));
}

function contactStorageUsed(data = {}) {
  const storedTextStorage = Number(data.storageUsed);
  const textStorageUsed = Number.isFinite(storedTextStorage) && storedTextStorage > 0
    ? storedTextStorage
    : toMb(data.displayName, data.firstName, data.lastName, data.company, data.phone, ...(data.extraPhones || []), data.email, data.birthday, data.address, data.note);
  return Number(textStorageUsed || 0) + Number(data.photoStorageUsed || 0);
}

async function refreshContactsMeta({ fbAdmin, userRef }) {
  const snapshot = await userRef.collection('contacts').get();
  let contactsCount = 0;
  let storageUsed = 0;

  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    if (data.type !== 'contact') return;
    contactsCount += 1;
    storageUsed += contactStorageUsed(data);
  });

  await userRef.collection('contacts').doc('meta').set({
    type: 'meta',
    status: 'activate',
    active: true,
    storageUsed: Number(storageUsed.toFixed(4)),
    contactsCount,
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

export default function createContactsSetupRouter({ firebaseServiceAccountPath, requireSession }) {
  const router = express.Router();

  if (typeof requireSession === 'function') {
    router.use(requireSession);
  }

  router.post('/contacts/setup', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const contactsMetaRef = userRef.collection('contacts').doc('meta');
      const welcomeContactRef = userRef.collection('contacts').doc('iclora-support');

      const [userSnapshot, metaSnapshot, welcomeSnapshot] = await Promise.all([
        userRef.get(),
        contactsMetaRef.get(),
        welcomeContactRef.get(),
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
          contacts: fbAdmin.firestore.FieldValue.delete(),
        });
      }

      batch.set(
        contactsMetaRef,
        {
          type: 'meta',
          status: 'activate',
          active: true,
          storageUsed: typeof metaData?.storageUsed === 'number' ? metaData.storageUsed : 0,
          activatedOn: metaData?.activatedOn || fbAdmin.firestore.FieldValue.serverTimestamp(),
          activatedOnLabel: responseActivatedOnLabel,
          contactsCount: typeof metaData?.contactsCount === 'number' ? Math.max(1, metaData.contactsCount) : 1,
          updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      const supportNote = `Your Contacts Cloud was activated on ${responseActivatedOnLabel}. iClora added this first contact to welcome you.`;
      const supportStorageUsed = toMb('iClora Support', 'iClora', 'Support', 'iClora', ICLORA_SUPPORT_PHONE, ICLORA_SUPPORT_EMAIL, supportNote);
      if (!welcomeSnapshot.exists) {
        batch.set(welcomeContactRef, {
          type: 'contact',
          displayName: 'iClora Support',
          firstName: 'iClora',
          lastName: 'Support',
          company: 'iClora',
          phone: ICLORA_SUPPORT_PHONE,
          email: ICLORA_SUPPORT_EMAIL,
          greeting: `Hello ${firstName}`,
          note: supportNote,
          source: 'iClora',
          createdAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          createdAtLabel: activatedOnLabel,
          storageUsed: supportStorageUsed,
          system: true,
        });
      } else {
        const welcomeData = welcomeSnapshot.data() || {};
        if (welcomeData.email !== ICLORA_SUPPORT_EMAIL || welcomeData.phone !== ICLORA_SUPPORT_PHONE || Number(welcomeData.storageUsed || 0) <= 0) {
          batch.set(welcomeContactRef, {
            phone: ICLORA_SUPPORT_PHONE,
            email: ICLORA_SUPPORT_EMAIL,
            note: supportNote,
            storageUsed: supportStorageUsed,
            updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      }

      await batch.commit();
      await refreshContactsMeta({ fbAdmin, userRef });

      return res.json({
        ok: true,
        alreadyActive,
        activatedOnLabel: responseActivatedOnLabel,
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Failed to activate contacts' });
    }
  });

  return router;
}
