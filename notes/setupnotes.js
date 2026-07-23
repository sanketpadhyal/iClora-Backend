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

function toMb(...parts) {
  const bytes = parts.reduce((total, part) => total + Buffer.byteLength(String(part || ''), 'utf8'), 0);
  return Number((bytes / (1024 * 1024)).toFixed(4));
}

function noteStorageUsed(data = {}) {
  const stored = Number(data.storageUsed);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return toMb(data.title, data.content);
}

async function refreshNotesMeta({ fbAdmin, userRef }) {
  const notesRef = userRef.collection('notes');
  const snapshot = await notesRef.get();
  let notesCount = 0;
  let foldersCount = 0;
  let storageUsed = 0;

  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    if (data.type === 'note') {
      notesCount += 1;
      storageUsed += noteStorageUsed(data);
    }
    if (data.type === 'folder') foldersCount += 1;
  });

  await notesRef.doc('meta').set({
    type: 'meta',
    status: 'activate',
    active: true,
    storageUsed: Number(storageUsed.toFixed(4)),
    notesCount,
    foldersCount: Math.max(1, foldersCount),
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

export default function createNotesSetupRouter({ firebaseServiceAccountPath, requireSession }) {
  const router = express.Router();

  if (typeof requireSession === 'function') {
    router.use(requireSession);
  }

  router.post('/notes/setup', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const notesMetaRef = userRef.collection('notes').doc('meta');
      const defaultFolderRef = userRef.collection('notes').doc('all-notes');
      const welcomeNoteRef = userRef.collection('notes').doc('welcome-iclora');

      const [userSnapshot, metaSnapshot, folderSnapshot, welcomeSnapshot] = await Promise.all([
        userRef.get(),
        notesMetaRef.get(),
        defaultFolderRef.get(),
        welcomeNoteRef.get(),
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
          notes: fbAdmin.firestore.FieldValue.delete(),
        });
      }

      batch.set(
        notesMetaRef,
        {
          type: 'meta',
          status: 'activate',
          active: true,
          storageUsed: typeof metaData?.storageUsed === 'number' ? metaData.storageUsed : 0,
          activatedOn: metaData?.activatedOn || fbAdmin.firestore.FieldValue.serverTimestamp(),
          activatedOnLabel: responseActivatedOnLabel,
          notesCount: typeof metaData?.notesCount === 'number' ? Math.max(1, metaData.notesCount) : 1,
          foldersCount: typeof metaData?.foldersCount === 'number' ? Math.max(1, metaData.foldersCount) : 1,
          updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (!folderSnapshot.exists) {
        batch.set(defaultFolderRef, {
          type: 'folder',
          name: 'Notes',
          system: true,
          createdAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      if (!welcomeSnapshot.exists) {
        const title = 'Welcome to iClora Notes';
        const content = `Hello ${firstName},\n\nYou activated your Notes Cloud on ${responseActivatedOnLabel}.\n\nWelcome to iClora Notes. Your space is ready for thoughts, reminders, and anything you want to keep safe.\n\nGreetings,\niClora`;
        batch.set(welcomeNoteRef, {
          type: 'note',
          title,
          from: 'iClora',
          greeting: `Hello ${firstName}`,
          content,
          preview: `Hello ${firstName}, you activated your Notes Cloud on ${responseActivatedOnLabel}.`,
          folderId: 'all-notes',
          pinned: true,
          locked: true,
          storageUsed: toMb(title, content),
          createdAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          createdAtLabel: activatedOnLabel,
          createdBy: 'iClora',
          system: true,
        });
      }

      await batch.commit();
      await refreshNotesMeta({ fbAdmin, userRef });

      return res.json({
        ok: true,
        alreadyActive,
        activatedOnLabel: responseActivatedOnLabel,
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Failed to activate notes' });
    }
  });

  return router;
}
