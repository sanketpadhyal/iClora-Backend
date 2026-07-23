import express from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { getFirebaseAdmin } from '../firebase.js';
import { getSupabaseAdmin } from '../supabase/client.js';
import { assertStorageCapacity, toMbFromBytes } from '../storage/quota.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

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

async function uploadContactImage({ uid, contactId, file }) {
  const uploadResult = await new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: 'iclora/contact-photos',
        public_id: `${uid}-${contactId}-${Date.now()}`,
        overwrite: true,
        resource_type: 'image',
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    uploadStream.end(file.buffer);
  });

  const secureUrl = uploadResult?.secure_url || '';
  const publicId = uploadResult?.public_id || '';
  const bytes = Number(uploadResult?.bytes || file?.size || 0);
  if (!secureUrl || !publicId) throw new Error('Upload failed');
  return { secureUrl, publicId, bytes };
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

function rowStorageUsed(row = {}) {
  const storedTextStorage = Number(row.storage_used);
  const extraPhones = Array.isArray(row.extra_phones) ? row.extra_phones : [];
  const textStorageUsed = Number.isFinite(storedTextStorage) && storedTextStorage > 0
    ? storedTextStorage
    : toMb(row.display_name, row.first_name, row.last_name, row.company, row.phone, ...extraPhones, row.email, row.birthday, row.address, row.note);
  return Number(textStorageUsed || 0) + Number(row.photo_storage_used || 0);
}

function formatFirebaseContact(contactId, data = {}) {
  return {
    id: contactId,
    type: 'contact',
    displayName: data.displayName || 'New Contact',
    firstName: data.firstName || '',
    lastName: data.lastName || '',
    company: data.company || '',
    phone: data.phone || '',
    email: data.email || '',
    note: data.note || '',
    photoUrl: data.photoUrl || '',
    photoPublicId: data.photoPublicId || '',
    system: Boolean(data.system),
    storageUsed: Number(contactStorageUsed(data).toFixed(4)),
    photoStorageUsed: Number(data.photoStorageUsed || 0),
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    createdAtLabel: data.createdAtLabel || '',
  };
}

function formatSupabaseContact(row = {}) {
  return {
    id: row.id,
    type: 'contact',
    displayName: row.display_name || 'New Contact',
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    company: row.company || '',
    phone: row.phone || '',
    email: row.email || '',
    note: row.note || '',
    photoUrl: row.photo_url || '',
    photoPublicId: row.photo_public_id || '',
    system: Boolean(row.system),
    storageUsed: Number(rowStorageUsed(row).toFixed(4)),
    photoStorageUsed: Number(row.photo_storage_used || 0),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    createdAtLabel: row.created_at_label || '',
  };
}

async function destroyPreviousPhoto(previousPublicId, nextPublicId) {
  if (!previousPublicId || previousPublicId === nextPublicId) return;
  try {
    await cloudinary.uploader.destroy(previousPublicId, { resource_type: 'image' });
  } catch {
    // Replacing the photo should not fail because cleanup of the old asset failed.
  }
}

async function refreshSupabaseContactsMeta(sb, uid) {
  const [countResult, storageResult] = await Promise.all([
    sb.from('contacts_items').select('*', { count: 'exact', head: true }).eq('user_id', uid),
    sb
      .from('contacts_items')
      .select('display_name,first_name,last_name,company,phone,extra_phones,email,birthday,address,note,storage_used,photo_storage_used')
      .eq('user_id', uid),
  ]);
  if (countResult?.error) throw countResult.error;
  if (storageResult?.error) throw storageResult.error;

  const storageUsed = Number((storageResult.data || []).reduce((total, row) => total + rowStorageUsed(row), 0).toFixed(4));
  const metaResult = await sb.from('contacts_meta').upsert({
    user_id: uid,
    active: true,
    status: 'activate',
    storage_used: storageUsed,
    contacts_count: countResult.count || 0,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (metaResult?.error) throw metaResult.error;
}

async function refreshFirebaseContactsMeta({ fbAdmin, userRef }) {
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

export default function createContactsPhotoRouter({
  config,
  requireSession,
  useSupabaseForContacts = false,
  useSupabaseForNotes = false,
}) {
  const router = express.Router();
  if (typeof requireSession === 'function') router.use(requireSession);

  router.post('/contacts/:contactId/photo', upload.single('photo'), async (req, res) => {
    try {
      ensureCloudinaryConfigured(config);

      const file = req.file;
      const { uid } = req.session || {};
      const { contactId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!contactId || contactId === 'meta') return res.status(400).json({ ok: false, error: 'Invalid contact' });
      if (!file?.buffer) return res.status(400).json({ ok: false, error: 'Missing photo file' });
      if (!file.mimetype?.startsWith('image/')) return res.status(400).json({ ok: false, error: 'File must be an image' });

      let previousPublicId = '';
      let nextContact = null;

      if (useSupabaseForContacts) {
        const sb = getSupabaseAdmin();
        const { data: current, error: currentError } = await sb
          .from('contacts_items')
          .select('*')
          .eq('user_id', uid)
          .eq('id', contactId)
          .maybeSingle();
        if (currentError) throw currentError;
        if (!current) return res.status(404).json({ ok: false, error: 'Contact not found' });
        if (current.system) return res.status(403).json({ ok: false, error: 'This contact cannot be edited' });
        previousPublicId = current.photo_public_id || '';
        await assertStorageCapacity({
          firebaseServiceAccountPath: config.firebaseServiceAccountPath,
          uid,
          incomingStorageMb: toMbFromBytes(file.size),
          replacingStorageMb: Number(current.photo_storage_used || 0),
          useSupabaseForNotes,
          useSupabaseForContacts: true,
        });

        const { secureUrl, publicId, bytes } = await uploadContactImage({ uid, contactId, file });
        const patch = {
          photo_url: secureUrl,
          photo_public_id: publicId,
          photo_storage_used: toMbFromBytes(bytes),
          updated_at: new Date().toISOString(),
        };
        const { data: updated, error: updateError } = await sb
          .from('contacts_items')
          .update(patch)
          .eq('user_id', uid)
          .eq('id', contactId)
          .select('*')
          .maybeSingle();
        if (updateError) throw updateError;
        if (!updated) return res.status(404).json({ ok: false, error: 'Contact not found' });
        await refreshSupabaseContactsMeta(sb, uid);
        nextContact = formatSupabaseContact(updated);
      } else {
        const fbAdmin = getFirebaseAdmin(config.firebaseServiceAccountPath);
        const db = fbAdmin.firestore();
        const contactRef = db.collection('users').doc(uid).collection('contacts').doc(contactId);
        const snap = await contactRef.get();
        const current = snap.exists ? snap.data() || {} : {};
        if (!snap.exists || current.type !== 'contact') return res.status(404).json({ ok: false, error: 'Contact not found' });
        if (current.system) return res.status(403).json({ ok: false, error: 'This contact cannot be edited' });
        previousPublicId = current.photoPublicId || '';
        await assertStorageCapacity({
          firebaseServiceAccountPath: config.firebaseServiceAccountPath,
          uid,
          userRef: db.collection('users').doc(uid),
          incomingStorageMb: toMbFromBytes(file.size),
          replacingStorageMb: Number(current.photoStorageUsed || 0),
          useSupabaseForNotes,
          useSupabaseForContacts,
        });

        const { secureUrl, publicId, bytes } = await uploadContactImage({ uid, contactId, file });
        const patch = {
          photoUrl: secureUrl,
          photoPublicId: publicId,
          photoStorageUsed: toMbFromBytes(bytes),
          updatedAt: new Date().toISOString(),
        };
        await contactRef.set(patch, { merge: true });
        await refreshFirebaseContactsMeta({ fbAdmin, userRef: db.collection('users').doc(uid) });
        nextContact = formatFirebaseContact(contactId, { ...current, ...patch });
      }

      await destroyPreviousPhoto(previousPublicId, nextContact.photoPublicId);

      return res.json({
        ok: true,
        url: nextContact.photoUrl,
        contact: nextContact,
      });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Contact photo upload failed' });
    }
  });

  return router;
}
