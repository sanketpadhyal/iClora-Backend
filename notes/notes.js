import express from 'express';
import { randomUUID } from 'crypto';
import { getFirebaseAdmin } from '../firebase.js';
import { assertStorageCapacity } from '../storage/quota.js';

const DEFAULT_FOLDER_ID = 'all-notes';
const MAX_FOLDERS = 50;

function cleanText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function toIso(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  return '';
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

function previewFrom(content = '') {
  const text = String(content || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 120);
}

function isStaleWrite(baseUpdatedAt, currentUpdatedAt) {
  if (typeof baseUpdatedAt !== 'string' || !baseUpdatedAt || !currentUpdatedAt) return false;
  const baseTime = Date.parse(baseUpdatedAt);
  const currentTime = Date.parse(toIso(currentUpdatedAt));
  if (!Number.isFinite(baseTime) || !Number.isFinite(currentTime)) return false;
  return currentTime > baseTime + 1000;
}

function formatNote(id, data = {}) {
  return {
    id,
    type: 'note',
    title: cleanText(data.title, 'Untitled'),
    content: typeof data.content === 'string' ? data.content : '',
    preview: typeof data.preview === 'string' ? data.preview : previewFrom(data.content),
    folderId: cleanText(data.folderId, DEFAULT_FOLDER_ID),
    pinned: Boolean(data.pinned),
    locked: Boolean(data.locked),
    system: Boolean(data.system),
    storageUsed: noteStorageUsed(data),
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
    createdAtLabel: typeof data.createdAtLabel === 'string' ? data.createdAtLabel : '',
    from: typeof data.from === 'string' ? data.from : '',
  };
}

function formatFolder(id, data = {}) {
  return {
    id,
    type: 'folder',
    name: cleanText(data.name, id === DEFAULT_FOLDER_ID ? 'Notes' : 'Folder'),
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
    system: Boolean(data.system),
  };
}

function formatNoteSummary(id, data = {}) {
  return {
    id,
    type: 'note',
    title: cleanText(data.title, 'Untitled'),
    preview: typeof data.preview === 'string' ? data.preview : previewFrom(data.content),
    folderId: cleanText(data.folderId, DEFAULT_FOLDER_ID),
    pinned: Boolean(data.pinned),
    locked: Boolean(data.locked),
    system: Boolean(data.system),
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
  };
}

function sortByUpdatedDesc(a, b) {
  const bTime = Date.parse(b.updatedAt || b.createdAt || '') || 0;
  const aTime = Date.parse(a.updatedAt || a.createdAt || '') || 0;
  return bTime - aTime;
}

async function ensureNotesCloud({ fbAdmin, userRef }) {
  const notesRef = userRef.collection('notes');
  const metaRef = notesRef.doc('meta');
  const defaultFolderRef = notesRef.doc(DEFAULT_FOLDER_ID);
  const welcomeNoteRef = notesRef.doc('welcome-iclora');
  const [metaSnap, folderSnap, welcomeSnap] = await Promise.all([metaRef.get(), defaultFolderRef.get(), welcomeNoteRef.get()]);
  const meta = metaSnap.exists ? metaSnap.data() || {} : {};
  if (meta.active !== true) {
    return false;
  }
  const batch = userRef.firestore.batch();

  if (!folderSnap.exists) {
    batch.set(defaultFolderRef, {
      type: 'folder',
      name: 'Notes',
      system: true,
      createdAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  if (welcomeSnap.exists && welcomeSnap.data()?.type === 'note') {
    batch.set(welcomeNoteRef, {
      folderId: DEFAULT_FOLDER_ID,
      pinned: true,
      locked: true,
      system: true,
    }, { merge: true });
  }

  await batch.commit();
  return true;
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

async function updateNotesMeta({ fbAdmin, userRef, notesDelta = 0, foldersDelta = 0, storageDelta = 0 }) {
  const roundedStorageDelta = Number(Number(storageDelta || 0).toFixed(4));
  await userRef.collection('notes').doc('meta').set({
    type: 'meta',
    status: 'activate',
    active: true,
    storageUsed: fbAdmin.firestore.FieldValue.increment(roundedStorageDelta),
    notesCount: fbAdmin.firestore.FieldValue.increment(notesDelta),
    foldersCount: fbAdmin.firestore.FieldValue.increment(foldersDelta),
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function commitDeletes(db, refs) {
  const chunkSize = 450;
  for (let index = 0; index < refs.length; index += chunkSize) {
    const batch = db.batch();
    refs.slice(index, index + chunkSize).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

export default function createNotesRouter({ firebaseServiceAccountPath, requireSession }) {
  const router = express.Router();

  if (typeof requireSession === 'function') {
    router.use(requireSession);
  }

  router.get('/notes', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureNotesCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Notes Cloud is not activated' });

      const snapshot = await userRef.collection('notes').get();
      const notes = [];
      const folders = [];
      let meta = {};

      snapshot.forEach((doc) => {
        const data = doc.data() || {};
        if (doc.id === 'meta' || data.type === 'meta') {
          meta = { ...data, updatedAt: toIso(data.updatedAt), activatedOn: toIso(data.activatedOn) };
          return;
        }
        if (data.type === 'folder') folders.push(formatFolder(doc.id, data));
        if (data.type === 'note') notes.push(formatNote(doc.id, data));
      });

      if (!folders.some((folder) => folder.id === DEFAULT_FOLDER_ID)) {
        folders.unshift({ id: DEFAULT_FOLDER_ID, type: 'folder', name: 'Notes', system: true, createdAt: '', updatedAt: '' });
      }

      return res.json({
        ok: true,
        folders: folders.sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name)),
        notes: notes.sort(sortByUpdatedDesc),
        meta,
      });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load notes' });
    }
  });

  router.get('/notes/preview', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const limitRaw = Number(req.query?.limit);
      const limitSize = Number.isFinite(limitRaw) ? Math.max(1, Math.min(12, Math.floor(limitRaw))) : 6;
      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureNotesCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Notes Cloud is not activated' });

      const snapshot = await userRef.collection('notes')
        .orderBy('updatedAt', 'desc')
        .limit(Math.max(limitSize * 3, 12))
        .select('type', 'title', 'preview', 'folderId', 'pinned', 'locked', 'system', 'createdAt', 'updatedAt')
        .get();
      const notes = [];
      snapshot.forEach((doc) => {
        const data = doc.data() || {};
        if (data.type === 'note' && notes.length < limitSize) {
          notes.push(formatNoteSummary(doc.id, data));
        }
      });

      const metaSnap = await userRef.collection('notes').doc('meta').get();
      const metaData = metaSnap.exists ? metaSnap.data() || {} : {};
      return res.json({
        ok: true,
        notes,
        meta: { ...metaData, updatedAt: toIso(metaData.updatedAt), activatedOn: toIso(metaData.activatedOn) },
      });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load notes preview' });
    }
  });

  router.post('/notes/folders', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const name = cleanText(req.body?.name, 'New Folder').slice(0, 64);
      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureNotesCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Notes Cloud is not activated' });

      const existingFolders = await userRef.collection('notes').where('type', '==', 'folder').select('type').get();
      if (existingFolders.size >= MAX_FOLDERS) {
        return res.status(400).json({ ok: false, error: `Folder limit reached. You can create up to ${MAX_FOLDERS} folders.` });
      }

      const folderId = `folder-${randomUUID()}`;
      const folderRef = userRef.collection('notes').doc(folderId);
      const nowIso = new Date().toISOString();
      const folderData = {
        type: 'folder',
        name,
        system: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await Promise.all([
        folderRef.set(folderData),
        updateNotesMeta({ fbAdmin, userRef, foldersDelta: 1 }),
      ]);
      return res.json({ ok: true, folder: formatFolder(folderId, folderData) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to create folder' });
    }
  });

  router.patch('/notes/folders/:folderId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { folderId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!folderId || folderId === 'meta' || folderId === DEFAULT_FOLDER_ID) {
        return res.status(400).json({ ok: false, error: 'This folder cannot be renamed' });
      }

      const name = cleanText(req.body?.name, 'Folder').slice(0, 64);
      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureNotesCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Notes Cloud is not activated' });
      const folderRef = userRef.collection('notes').doc(folderId);
      const folderSnap = await folderRef.get();
      const folderData = folderSnap.exists ? folderSnap.data() || {} : {};
      if (!folderSnap.exists || folderData.type !== 'folder') {
        return res.status(404).json({ ok: false, error: 'Folder not found' });
      }
      if (folderData.system) {
        return res.status(403).json({ ok: false, error: 'This folder cannot be renamed' });
      }

      await folderRef.set({
        name,
        updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      const nextSnap = await folderRef.get();
      return res.json({ ok: true, folder: formatFolder(nextSnap.id, nextSnap.data() || {}) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to rename folder' });
    }
  });

  router.delete('/notes/folders/:folderId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { folderId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!folderId || folderId === 'meta' || folderId === DEFAULT_FOLDER_ID) {
        return res.status(400).json({ ok: false, error: 'This folder cannot be deleted' });
      }

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureNotesCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Notes Cloud is not activated' });
      const notesRef = userRef.collection('notes');
      const folderRef = notesRef.doc(folderId);
      const folderSnap = await folderRef.get();
      const folderData = folderSnap.exists ? folderSnap.data() || {} : {};
      if (!folderSnap.exists || folderData.type !== 'folder') {
        return res.status(404).json({ ok: false, error: 'Folder not found' });
      }
      if (folderData.system) {
        return res.status(403).json({ ok: false, error: 'This folder cannot be deleted' });
      }

      const notesInFolder = await notesRef.where('type', '==', 'note').where('folderId', '==', folderId).get();
      const refsToDelete = [folderRef];
      let deletedNotesCount = 0;
      let deletedStorageMb = 0;
      notesInFolder.forEach((doc) => {
        const data = doc.data() || {};
        if (!data.system) {
          refsToDelete.push(doc.ref);
          deletedNotesCount += 1;
          deletedStorageMb += noteStorageUsed(data);
        }
      });
      await commitDeletes(db, refsToDelete);
      await updateNotesMeta({
        fbAdmin,
        userRef,
        foldersDelta: -1,
        notesDelta: -deletedNotesCount,
        storageDelta: -deletedStorageMb,
      });
      return res.json({ ok: true, deletedId: folderId });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to delete folder' });
    }
  });

  router.post('/notes', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const title = cleanText(req.body?.title, 'New Note').slice(0, 160);
      const content = typeof req.body?.content === 'string' ? req.body.content.slice(0, 60000) : '';
      const folderId = cleanText(req.body?.folderId, DEFAULT_FOLDER_ID).slice(0, 96);
      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureNotesCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Notes Cloud is not activated' });

      const noteId = `note-${randomUUID()}`;
      const noteRef = userRef.collection('notes').doc(noteId);
      const nowIso = new Date().toISOString();
      const storageUsed = toMb(title, content);
      await assertStorageCapacity({
        firebaseServiceAccountPath,
        uid,
        userRef,
        incomingStorageMb: storageUsed,
      });
      const noteData = {
        type: 'note',
        title,
        content,
        preview: previewFrom(content),
        folderId,
        pinned: false,
        locked: false,
        system: false,
        storageUsed,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      await Promise.all([
        noteRef.set(noteData),
        updateNotesMeta({ fbAdmin, userRef, notesDelta: 1, storageDelta: storageUsed }),
      ]);
      return res.json({ ok: true, note: formatNote(noteId, noteData) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to create note' });
    }
  });

  router.patch('/notes/:noteId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { noteId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!noteId || noteId === 'meta' || noteId === DEFAULT_FOLDER_ID) {
        return res.status(400).json({ ok: false, error: 'Invalid note' });
      }

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureNotesCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Notes Cloud is not activated' });
      const noteRef = userRef.collection('notes').doc(noteId);
      const noteSnap = await noteRef.get();
      if (!noteSnap.exists || noteSnap.data()?.type !== 'note') {
        return res.status(404).json({ ok: false, error: 'Note not found' });
      }

      const current = noteSnap.data() || {};
      if (current.system || current.locked) {
        return res.status(403).json({ ok: false, error: 'This note is locked and cannot be edited' });
      }
      if (isStaleWrite(req.body?.baseUpdatedAt, current.updatedAt)) {
        return res.status(409).json({
          ok: false,
          conflict: true,
          error: 'A newer version of this note exists',
          note: formatNote(noteId, current),
        });
      }
      const nextTitle = typeof req.body?.title === 'string'
        ? cleanText(req.body.title, 'Untitled').slice(0, 160)
        : cleanText(current.title, 'Untitled');
      const nextContent = typeof req.body?.content === 'string'
        ? req.body.content.slice(0, 60000)
        : (typeof current.content === 'string' ? current.content : '');
      const nextFolderId = typeof req.body?.folderId === 'string'
        ? cleanText(req.body.folderId, DEFAULT_FOLDER_ID).slice(0, 96)
        : cleanText(current.folderId, DEFAULT_FOLDER_ID);
      const nextPinned = typeof req.body?.pinned === 'boolean'
        ? req.body.pinned
        : Boolean(current.pinned);

      const nextStorageUsed = toMb(nextTitle, nextContent);
      const currentStorageUsed = noteStorageUsed(current);
      await assertStorageCapacity({
        firebaseServiceAccountPath,
        uid,
        userRef,
        incomingStorageMb: nextStorageUsed,
        replacingStorageMb: currentStorageUsed,
      });
      const nowIso = new Date().toISOString();
      const nextData = {
        title: nextTitle,
        content: nextContent,
        preview: previewFrom(nextContent),
        folderId: nextFolderId,
        pinned: nextPinned,
        storageUsed: nextStorageUsed,
        updatedAt: nowIso,
      };
      await Promise.all([
        noteRef.set(nextData, { merge: true }),
        updateNotesMeta({ fbAdmin, userRef, storageDelta: nextStorageUsed - currentStorageUsed }),
      ]);
      return res.json({ ok: true, note: formatNote(noteId, { ...current, ...nextData }) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to update note' });
    }
  });

  router.delete('/notes/:noteId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { noteId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!noteId || noteId === 'meta' || noteId === DEFAULT_FOLDER_ID) {
        return res.status(400).json({ ok: false, error: 'Invalid note' });
      }

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureNotesCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Notes Cloud is not activated' });
      const noteRef = userRef.collection('notes').doc(noteId);
      const noteSnap = await noteRef.get();
      const noteData = noteSnap.exists ? noteSnap.data() || {} : {};
      if (!noteSnap.exists || noteData?.type !== 'note') {
        return res.status(404).json({ ok: false, error: 'Note not found' });
      }
      if (noteData.system) {
        return res.status(403).json({ ok: false, error: 'This main note cannot be deleted' });
      }

      const storageUsed = noteStorageUsed(noteData);
      await Promise.all([
        noteRef.delete(),
        updateNotesMeta({ fbAdmin, userRef, notesDelta: -1, storageDelta: -storageUsed }),
      ]);
      return res.json({ ok: true, deletedId: noteId });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to delete note' });
    }
  });

  return router;
}
