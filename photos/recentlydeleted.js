import express from 'express';
import { v2 as cloudinary } from 'cloudinary';
import { getFirebaseAdmin } from '../firebase.js';

const PRIVATE_UPLOAD_TYPE = 'authenticated';
const RECENTLY_DELETED_TTL_DAYS = 15;
const RECENTLY_DELETED_TTL_MS = RECENTLY_DELETED_TTL_DAYS * 24 * 60 * 60 * 1000;
const MAX_BATCH = 100;

function cleanText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function toIso(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  return '';
}

function daysRemaining(deletedAt) {
  const deletedMs = Date.parse(toIso(deletedAt)) || 0;
  if (!deletedMs) return RECENTLY_DELETED_TTL_DAYS;
  const expireMs = deletedMs + RECENTLY_DELETED_TTL_MS;
  const remaining = Math.ceil((expireMs - Date.now()) / (24 * 60 * 60 * 1000));
  return Math.max(0, remaining);
}

function toMbFromBytes(bytes) {
  const amount = Number(bytes);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number((amount / (1024 * 1024)).toFixed(4));
}

function photoStorageUsed(data = {}) {
  const stored = Number(data.storageUsed);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return toMbFromBytes(data.bytes);
}

function isPhotoStorageItem(data = {}) {
  return data.resourceType !== 'video' && data.type !== 'video';
}

function photoMetaDelta(data = {}, direction = 1) {
  if (!isPhotoStorageItem(data)) {
    return { storage: 0, photos: 0, videos: 0, items: 0 };
  }
  return {
    storage: Number((photoStorageUsed(data) * direction).toFixed(4)),
    photos: direction,
    videos: 0,
    items: direction,
  };
}

function addDelta(total = {}, delta = {}) {
  return {
    storage: Number((Number(total.storage || 0) + Number(delta.storage || 0)).toFixed(4)),
    photos: Number(total.photos || 0) + Number(delta.photos || 0),
    videos: Number(total.videos || 0) + Number(delta.videos || 0),
    items: Number(total.items || 0) + Number(delta.items || 0),
  };
}

function negateDelta(delta = {}) {
  return {
    storage: Number((-Number(delta.storage || 0)).toFixed(4)),
    photos: -Number(delta.photos || 0),
    videos: -Number(delta.videos || 0),
    items: -Number(delta.items || 0),
  };
}

function writePhotosMetaDelta({ fbAdmin, writer, metaRef, active = {}, deleted = {} }) {
  const activeStorage = Number((Number(active.storage || 0)).toFixed(4));
  const deletedStorage = Number((Number(deleted.storage || 0)).toFixed(4));
  const totalStorage = Number((activeStorage + deletedStorage).toFixed(4));
  const patch = {
    type: 'meta',
    status: 'activate',
    active: true,
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  };

  if (activeStorage) patch.storageUsed = fbAdmin.firestore.FieldValue.increment(activeStorage);
  if (deletedStorage) patch.deletedStorageUsed = fbAdmin.firestore.FieldValue.increment(deletedStorage);
  if (totalStorage) patch.totalStorageUsed = fbAdmin.firestore.FieldValue.increment(totalStorage);
  if (active.photos) patch.photosCount = fbAdmin.firestore.FieldValue.increment(active.photos);
  if (active.videos) patch.videosCount = fbAdmin.firestore.FieldValue.increment(active.videos);
  if (active.items) patch.itemsCount = fbAdmin.firestore.FieldValue.increment(active.items);

  writer.set(metaRef, patch, { merge: true });
}

function signedCloudinaryUrl(publicId, options = {}) {
  if (!publicId) return '';
  return cloudinary.url(publicId, {
    secure: true,
    sign_url: true,
    type: PRIVATE_UPLOAD_TYPE,
    resource_type: options.resourceType || 'image',
    transformation: options.transformation,
  });
}

function formatDeletedPhoto(id, data = {}) {
  const resourceType = cleanText(data.resourceType, 'image');
  const publicId = cleanText(data.publicId);
  const staticSrc = cleanText(data.staticSrc);
  const originalUrl = signedCloudinaryUrl(publicId, { resourceType }) || staticSrc;
  const thumbnailSrc = signedCloudinaryUrl(publicId, {
    resourceType,
    transformation: [
      {
        width: 520,
        height: 520,
        crop: 'fill',
        gravity: 'auto',
        quality: 'auto',
        fetch_format: 'auto',
      },
    ],
  }) || originalUrl;

  return {
    id,
    title: cleanText(data.title, data.originalFilename || 'iClora Photo'),
    publicId,
    resourceType,
    thumbnailSrc,
    src: originalUrl,
    originalFilename: cleanText(data.originalFilename),
    syncedBy: cleanText(data.syncedBy),
    syncedByEmail: cleanText(data.syncedByEmail),
    syncedByProvider: cleanText(data.syncedByProvider),
    syncedDeviceName: cleanText(data.syncedDeviceName || data.deviceName),
    syncedDeviceType: cleanText(data.syncedDeviceType || data.deviceType),
    syncedAt: toIso(data.syncedAt),
    bytes: Number(data.bytes || 0),
    width: Number(data.width || 0),
    height: Number(data.height || 0),
    deletedAt: toIso(data.deletedAt),
    daysRemaining: daysRemaining(data.deletedAt),
    // Preserve all original fields for restore
    _original: data._original || {},
  };
}

function ensureCloudinaryConfigured(config) {
  if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) {
    throw new Error('Cloudinary is not configured');
  }
  cloudinary.config({
    cloud_name: config.cloudinaryCloudName,
    api_key: config.cloudinaryApiKey,
    api_secret: config.cloudinaryApiSecret,
  });
}

async function destroyCloudinaryAsset(publicId, resourceType = 'image') {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType || 'image',
      type: PRIVATE_UPLOAD_TYPE,
      invalidate: true,
    });
  } catch {
    // ignore
  }
}

function recentlyDeletedRef(db, uid) {
  return db.collection('recentlyDeleted').doc(uid).collection('photos');
}

async function refreshPhotosMeta({ fbAdmin, db, uid }) {
  const userRef = db.collection('users').doc(uid);
  const photosRef = userRef.collection('photos');
  const [snapshot, recentlyDeletedSnapshot] = await Promise.all([
    photosRef.get(),
    recentlyDeletedRef(db, uid).get(),
  ]);
  let photosCount = 0;
  let videosCount = 0;
  let storageUsed = 0;
  let deletedStorageUsed = 0;

  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    if (doc.id === 'meta' || data.type === 'meta' || data.type === 'photo-message') return;
    if (data.deleted) {
      deletedStorageUsed += photoStorageUsed(data);
      return;
    }
    if (data.resourceType === 'video' || data.type === 'video') return;
    photosCount += 1;
    storageUsed += photoStorageUsed(data);
  });

  recentlyDeletedSnapshot.forEach((doc) => {
    deletedStorageUsed += photoStorageUsed(doc.data() || {});
  });

  const roundedStorageUsed = Number(storageUsed.toFixed(4));
  const roundedDeletedStorageUsed = Number(deletedStorageUsed.toFixed(4));
  await photosRef.doc('meta').set({
    type: 'meta',
    status: 'activate',
    active: true,
    storageUsed: roundedStorageUsed,
    deletedStorageUsed: roundedDeletedStorageUsed,
    totalStorageUsed: Number((roundedStorageUsed + roundedDeletedStorageUsed).toFixed(4)),
    photosCount,
    videosCount,
    itemsCount: photosCount + videosCount,
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    storageUsed: roundedStorageUsed,
    deletedStorageUsed: roundedDeletedStorageUsed,
    totalStorageUsed: Number((roundedStorageUsed + roundedDeletedStorageUsed).toFixed(4)),
    photosCount,
    videosCount,
    itemsCount: photosCount + videosCount,
  };
}

async function ensurePhotosMetaInitialized({ fbAdmin, db, uid }) {
  const metaRef = db.collection('users').doc(uid).collection('photos').doc('meta');
  const metaSnap = await metaRef.get();
  const meta = metaSnap.exists ? metaSnap.data() || {} : {};
  if (
    typeof meta.deletedStorageUsed !== 'number'
    || typeof meta.totalStorageUsed !== 'number'
  ) {
    return refreshPhotosMeta({ fbAdmin, db, uid });
  }
  return meta;
}

// Purge expired entries (older than 15 days) silently
async function purgeExpired({ fbAdmin, db, uid, config }) {
  try {
    const photosRef = recentlyDeletedRef(db, uid);
    const cutoff = new Date(Date.now() - RECENTLY_DELETED_TTL_MS);
    const snapshot = await photosRef.where('deletedAt', '<=', cutoff.toISOString()).get();
    if (snapshot.empty) return;

    await ensurePhotosMetaInitialized({ fbAdmin, db, uid });
    ensureCloudinaryConfigured(config);
    const batch = db.batch();
    const assets = [];
    let deletedDelta = {};
    snapshot.forEach((doc) => {
      const data = doc.data() || {};
      if (data.publicId) assets.push({ publicId: data.publicId, resourceType: data.resourceType });
      deletedDelta = addDelta(deletedDelta, negateDelta(photoMetaDelta(data, 1)));
      batch.delete(doc.ref);
    });
    writePhotosMetaDelta({
      fbAdmin,
      writer: batch,
      metaRef: db.collection('users').doc(uid).collection('photos').doc('meta'),
      deleted: deletedDelta,
    });
    await batch.commit();
    await Promise.all(assets.map((a) => destroyCloudinaryAsset(a.publicId, a.resourceType)));
  } catch {
    // silent — don't block the user
  }
}

export default function createRecentlyDeletedRouter({
  firebaseServiceAccountPath,
  requireSession,
  config,
}) {
  const router = express.Router();

  if (typeof requireSession === 'function') router.use(requireSession);

  // GET /photos/recently-deleted — list all
  router.get('/photos/recently-deleted', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();

      // Purge expired in background (don't await to keep response fast)
      purgeExpired({ fbAdmin, db, uid, config });

      const snapshot = await recentlyDeletedRef(db, uid).orderBy('deletedAt', 'desc').limit(200).get();
      const photos = [];
      const now = Date.now();

      snapshot.forEach((doc) => {
        const data = doc.data() || {};
        const deletedMs = Date.parse(toIso(data.deletedAt)) || 0;
        // Skip already-expired entries (frontend safety net)
        if (deletedMs && now - deletedMs > RECENTLY_DELETED_TTL_MS) return;
        photos.push(formatDeletedPhoto(doc.id, data));
      });

      return res.json({ ok: true, photos });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load recently deleted photos' });
    }
  });

  // POST /photos/recently-deleted/restore — restore one or many
  router.post('/photos/recently-deleted/restore', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const ids = Array.from(new Set(
        Array.isArray(req.body?.ids) ? req.body.ids : [cleanText(req.body?.id)],
      )).filter((id) => id && id !== 'meta').slice(0, MAX_BATCH);

      if (!ids.length) return res.status(400).json({ ok: false, error: 'No photos selected' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const trashRef = recentlyDeletedRef(db, uid);
      const photosRef = db.collection('users').doc(uid).collection('photos');
      await ensurePhotosMetaInitialized({ fbAdmin, db, uid });

      const restoredIds = await db.runTransaction(async (transaction) => {
        const refs = ids.map((id) => trashRef.doc(id));
        const snaps = await Promise.all(refs.map((ref) => transaction.get(ref)));
        const restored = [];
        let activeDelta = {};
        let deletedDelta = {};

        snaps.forEach((snap) => {
          if (!snap.exists) return;
          const data = snap.data() || {};
          const original = data._original || {};
          const delta = photoMetaDelta(data, 1);
          activeDelta = addDelta(activeDelta, delta);
          deletedDelta = addDelta(deletedDelta, negateDelta(delta));
          transaction.set(photosRef.doc(snap.id), {
            ...original,
            deleted: false,
            updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.delete(snap.ref);
          restored.push(snap.id);
        });

        if (!restored.length) return [];
        writePhotosMetaDelta({
          fbAdmin,
          writer: transaction,
          metaRef: photosRef.doc('meta'),
          active: activeDelta,
          deleted: deletedDelta,
        });
        return restored;
      });

      if (!restoredIds.length) return res.status(404).json({ ok: false, error: 'Photos not found in Recently Deleted' });
      const meta = await ensurePhotosMetaInitialized({ fbAdmin, db, uid });

      return res.json({ ok: true, restoredIds, meta });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to restore photos' });
    }
  });

  // DELETE /photos/recently-deleted/:photoId — permanent delete
  router.delete('/photos/recently-deleted/:photoId', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { uid } = req.session || {};
      const { photoId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!photoId || photoId === 'meta') return res.status(400).json({ ok: false, error: 'Invalid photo' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const docRef = recentlyDeletedRef(db, uid).doc(photoId);
      await ensurePhotosMetaInitialized({ fbAdmin, db, uid });

      const data = await db.runTransaction(async (transaction) => {
        const snap = await transaction.get(docRef);
        if (!snap.exists) {
          const error = new Error('Photo not found in Recently Deleted');
          error.status = 404;
          throw error;
        }
        const current = snap.data() || {};
        transaction.delete(docRef);
        writePhotosMetaDelta({
          fbAdmin,
          writer: transaction,
          metaRef: db.collection('users').doc(uid).collection('photos').doc('meta'),
          deleted: negateDelta(photoMetaDelta(current, 1)),
        });
        return current;
      });
      const meta = await ensurePhotosMetaInitialized({ fbAdmin, db, uid });
      await destroyCloudinaryAsset(data.publicId, data.resourceType);

      return res.json({ ok: true, deletedId: photoId, meta });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to permanently delete photo' });
    }
  });

  // POST /photos/recently-deleted/delete-all — permanent delete all
  router.post('/photos/recently-deleted/delete-all', async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const snapshot = await recentlyDeletedRef(db, uid).get();
      if (snapshot.empty) return res.json({ ok: true, deletedIds: [] });
      await ensurePhotosMetaInitialized({ fbAdmin, db, uid });

      const { assets, deletedIds } = await db.runTransaction(async (transaction) => {
        const snaps = await Promise.all(snapshot.docs.map((doc) => transaction.get(doc.ref)));
        const nextAssets = [];
        const nextDeletedIds = [];
        let deletedDelta = {};

        snaps.forEach((doc) => {
          if (!doc.exists) return;
          const data = doc.data() || {};
          if (data.publicId) nextAssets.push({ publicId: data.publicId, resourceType: data.resourceType });
          deletedDelta = addDelta(deletedDelta, negateDelta(photoMetaDelta(data, 1)));
          transaction.delete(doc.ref);
          nextDeletedIds.push(doc.id);
        });

        if (nextDeletedIds.length) {
          writePhotosMetaDelta({
            fbAdmin,
            writer: transaction,
            metaRef: db.collection('users').doc(uid).collection('photos').doc('meta'),
            deleted: deletedDelta,
          });
        }

        return { assets: nextAssets, deletedIds: nextDeletedIds };
      });

      const meta = await ensurePhotosMetaInitialized({ fbAdmin, db, uid });
      await Promise.all(assets.map((a) => destroyCloudinaryAsset(a.publicId, a.resourceType)));

      return res.json({ ok: true, deletedIds, meta });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to clear Recently Deleted' });
    }
  });

  return router;
}
