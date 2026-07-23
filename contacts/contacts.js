import express from 'express';
import { randomUUID } from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { getFirebaseAdmin } from '../firebase.js';
import { assertStorageCapacity } from '../storage/quota.js';

const ICLORA_SUPPORT_EMAIL = 'icloraofficial@gmail.com';
const ICLORA_SUPPORT_PHONE = '8975659255';

export const CONTACT_FIELD_LIMITS = {
  displayName: 140,
  firstName: 80,
  lastName: 80,
  company: 120,
  phone: 60,
  extraPhones: 4,
  email: 160,
  birthday: 10,
  address: 240,
  note: 1200,
};

function cleanText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function limitText(value, field, fallback = '') {
  const text = cleanText(value, fallback);
  const maxLength = CONTACT_FIELD_LIMITS[field];
  if (text.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or less`);
  return text;
}

function limitRawText(value, field, fallback = '') {
  const text = typeof value === 'string' ? value : fallback;
  const maxLength = CONTACT_FIELD_LIMITS[field];
  if (text.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or less`);
  return text;
}

function normalizeExtraPhones(value, fallback = []) {
  const source = Array.isArray(value) ? value : (Array.isArray(fallback) ? fallback : []);
  return source
    .map((phone) => (typeof phone === 'string' ? phone.trim() : ''))
    .filter(Boolean)
    .slice(0, CONTACT_FIELD_LIMITS.extraPhones)
    .map((phone) => {
      if (phone.length > CONTACT_FIELD_LIMITS.phone) throw new Error(`phone must be ${CONTACT_FIELD_LIMITS.phone} characters or less`);
      return phone;
    });
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

function contactStorageUsed(data = {}) {
  const storedTextStorage = Number(data.storageUsed);
  const textStorageUsed = Number.isFinite(storedTextStorage) && storedTextStorage > 0
    ? storedTextStorage
    : toMb(data.displayName, data.firstName, data.lastName, data.company, data.phone, ...(data.extraPhones || []), data.email, data.birthday, data.address, data.note);
  return Number(textStorageUsed || 0) + Number(data.photoStorageUsed || 0);
}

function displayNameFrom(data = {}) {
  const displayName = cleanText(data.displayName);
  if (displayName) return displayName.slice(0, CONTACT_FIELD_LIMITS.displayName);
  const joined = [data.firstName, data.lastName].map((part) => cleanText(part)).filter(Boolean).join(' ');
  return (joined || cleanText(data.company, 'New Contact')).slice(0, CONTACT_FIELD_LIMITS.displayName);
}

function formatContact(id, data = {}) {
  return {
    id,
    type: 'contact',
    displayName: displayNameFrom(data),
    firstName: typeof data.firstName === 'string' ? data.firstName : '',
    lastName: typeof data.lastName === 'string' ? data.lastName : '',
    company: typeof data.company === 'string' ? data.company : '',
    phone: typeof data.phone === 'string' ? data.phone : '',
    extraPhones: normalizeExtraPhones(data.extraPhones),
    email: typeof data.email === 'string' ? data.email : '',
    birthday: typeof data.birthday === 'string' ? data.birthday : '',
    address: typeof data.address === 'string' ? data.address : '',
    note: typeof data.note === 'string' ? data.note : '',
    photoUrl: typeof data.photoUrl === 'string' ? data.photoUrl : '',
    photoPublicId: typeof data.photoPublicId === 'string' ? data.photoPublicId : '',
    system: Boolean(data.system),
    storageUsed: Number(contactStorageUsed(data).toFixed(4)),
    photoStorageUsed: typeof data.photoStorageUsed === 'number' ? data.photoStorageUsed : 0,
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
    createdAtLabel: typeof data.createdAtLabel === 'string' ? data.createdAtLabel : '',
  };
}

function sortContacts(a, b) {
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
}

async function destroyContactPhoto(config = {}, publicId = '') {
  if (!publicId || !config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) return;
  try {
    cloudinary.config({
      cloud_name: config.cloudinaryCloudName,
      api_key: config.cloudinaryApiKey,
      api_secret: config.cloudinaryApiSecret,
    });
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
  } catch {
    // Deleting the contact should not fail because external image cleanup is delayed.
  }
}

async function ensureContactsCloud({ fbAdmin, userRef }) {
  const contactsRef = userRef.collection('contacts');
  const metaRef = contactsRef.doc('meta');
  const metaSnap = await metaRef.get();
  const meta = metaSnap.exists ? metaSnap.data() || {} : {};
  if (meta.active !== true) return false;

  await metaRef.set({
    type: 'meta',
    status: 'activate',
    active: true,
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return true;
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

async function ensureSupportContact({ fbAdmin, userRef }) {
  const supportRef = userRef.collection('contacts').doc('iclora-support');
  const snapshot = await supportRef.get();
  if (!snapshot.exists) return false;
  const data = snapshot.data() || {};
  if (data.email === ICLORA_SUPPORT_EMAIL && data.phone === ICLORA_SUPPORT_PHONE) return false;
  const patch = {
    phone: ICLORA_SUPPORT_PHONE,
    email: ICLORA_SUPPORT_EMAIL,
    updatedAt: fbAdmin.firestore.FieldValue.serverTimestamp(),
  };
  patch.storageUsed = toMb(
    data.displayName,
    data.firstName,
    data.lastName,
    data.company,
    patch.phone,
    ...(Array.isArray(data.extraPhones) ? data.extraPhones : []),
    patch.email,
    data.birthday,
    data.address,
    data.note
  );
  await supportRef.set(patch, { merge: true });
  return true;
}

export default function createContactsRouter({ firebaseServiceAccountPath, requireSession, config = {} }) {
  const router = express.Router();
  if (typeof requireSession === 'function') router.use(requireSession);

  router.get('/contacts', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureContactsCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Contacts Cloud is not activated' });
      const supportUpdated = await ensureSupportContact({ fbAdmin, userRef });
      if (supportUpdated) await refreshContactsMeta({ fbAdmin, userRef });

      const snapshot = await userRef.collection('contacts').get();
      const contacts = [];
      let meta = {};
      snapshot.forEach((doc) => {
        const data = doc.data() || {};
        if (doc.id === 'meta' || data.type === 'meta') {
          meta = { ...data, updatedAt: toIso(data.updatedAt), activatedOn: toIso(data.activatedOn) };
          return;
        }
        if (data.type === 'contact') contacts.push(formatContact(doc.id, data));
      });

      return res.json({ ok: true, contacts: contacts.sort(sortContacts), meta });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load contacts' });
    }
  });

  router.get('/contacts/preview', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const limitRaw = Number(req.query?.limit);
      const limitSize = Number.isFinite(limitRaw) ? Math.max(1, Math.min(12, Math.floor(limitRaw))) : 3;

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureContactsCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Contacts Cloud is not activated' });
      const supportUpdated = await ensureSupportContact({ fbAdmin, userRef });
      if (supportUpdated) await refreshContactsMeta({ fbAdmin, userRef });

      const snapshot = await userRef.collection('contacts').get();
      const contacts = [];
      let meta = {};
      snapshot.forEach((doc) => {
        const data = doc.data() || {};
        if (doc.id === 'meta' || data.type === 'meta') {
          meta = { ...data, updatedAt: toIso(data.updatedAt), activatedOn: toIso(data.activatedOn) };
          return;
        }
        if (data.type === 'contact') contacts.push(formatContact(doc.id, data));
      });

      return res.json({ ok: true, contacts: contacts.sort(sortContacts).slice(0, limitSize), meta });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load contacts preview' });
    }
  });

  router.post('/contacts', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureContactsCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Contacts Cloud is not activated' });

      const nowIso = new Date().toISOString();
      const nextData = {
        type: 'contact',
        displayName: limitText(req.body?.displayName, 'displayName', 'New Contact'),
        firstName: limitText(req.body?.firstName, 'firstName'),
        lastName: limitText(req.body?.lastName, 'lastName'),
        company: limitText(req.body?.company, 'company'),
        phone: limitText(req.body?.phone, 'phone'),
        extraPhones: normalizeExtraPhones(req.body?.extraPhones),
        email: limitText(req.body?.email, 'email'),
        birthday: limitText(req.body?.birthday, 'birthday'),
        address: limitText(req.body?.address, 'address'),
        note: limitRawText(req.body?.note, 'note'),
        system: false,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      nextData.displayName = displayNameFrom(nextData);
      nextData.storageUsed = toMb(
        nextData.displayName,
        nextData.firstName,
        nextData.lastName,
        nextData.company,
        nextData.phone,
        ...nextData.extraPhones,
        nextData.email,
        nextData.birthday,
        nextData.address,
        nextData.note
      );
      await assertStorageCapacity({
        firebaseServiceAccountPath,
        uid,
        userRef,
        incomingStorageMb: nextData.storageUsed,
      });

      const contactId = `contact-${randomUUID()}`;
      await userRef.collection('contacts').doc(contactId).set(nextData);
      await refreshContactsMeta({ fbAdmin, userRef });
      return res.json({ ok: true, contact: formatContact(contactId, nextData) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to create contact' });
    }
  });

  router.patch('/contacts/:contactId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { contactId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!contactId || contactId === 'meta') return res.status(400).json({ ok: false, error: 'Invalid contact' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureContactsCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Contacts Cloud is not activated' });

      const contactRef = userRef.collection('contacts').doc(contactId);
      const snap = await contactRef.get();
      const current = snap.exists ? snap.data() || {} : {};
      if (!snap.exists || current.type !== 'contact') return res.status(404).json({ ok: false, error: 'Contact not found' });
      if (current.system) return res.status(403).json({ ok: false, error: 'This contact cannot be edited' });

      const nextData = {
        displayName: typeof req.body?.displayName === 'string' ? limitText(req.body.displayName, 'displayName', 'New Contact') : displayNameFrom(current),
        firstName: typeof req.body?.firstName === 'string' ? limitText(req.body.firstName, 'firstName') : (current.firstName || ''),
        lastName: typeof req.body?.lastName === 'string' ? limitText(req.body.lastName, 'lastName') : (current.lastName || ''),
        company: typeof req.body?.company === 'string' ? limitText(req.body.company, 'company') : (current.company || ''),
        phone: typeof req.body?.phone === 'string' ? limitText(req.body.phone, 'phone') : (current.phone || ''),
        extraPhones: Array.isArray(req.body?.extraPhones) ? normalizeExtraPhones(req.body.extraPhones) : normalizeExtraPhones(current.extraPhones),
        email: typeof req.body?.email === 'string' ? limitText(req.body.email, 'email') : (current.email || ''),
        birthday: typeof req.body?.birthday === 'string' ? limitText(req.body.birthday, 'birthday') : (current.birthday || ''),
        address: typeof req.body?.address === 'string' ? limitText(req.body.address, 'address') : (current.address || ''),
        note: typeof req.body?.note === 'string' ? limitRawText(req.body.note, 'note') : (current.note || ''),
        updatedAt: new Date().toISOString(),
      };
      nextData.displayName = displayNameFrom(nextData);
      nextData.storageUsed = toMb(
        nextData.displayName,
        nextData.firstName,
        nextData.lastName,
        nextData.company,
        nextData.phone,
        ...nextData.extraPhones,
        nextData.email,
        nextData.birthday,
        nextData.address,
        nextData.note
      );
      await assertStorageCapacity({
        firebaseServiceAccountPath,
        uid,
        userRef,
        incomingStorageMb: Number(nextData.storageUsed || 0) + Number(current.photoStorageUsed || 0),
        replacingStorageMb: contactStorageUsed(current),
      });

      await contactRef.set(nextData, { merge: true });
      await refreshContactsMeta({ fbAdmin, userRef });
      return res.json({ ok: true, contact: formatContact(contactId, { ...current, ...nextData }) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to update contact' });
    }
  });

  router.delete('/contacts/:contactId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { contactId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!contactId || contactId === 'meta') return res.status(400).json({ ok: false, error: 'Invalid contact' });

      const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
      const db = fbAdmin.firestore();
      const userRef = db.collection('users').doc(uid);
      const active = await ensureContactsCloud({ fbAdmin, userRef });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Contacts Cloud is not activated' });

      const contactRef = userRef.collection('contacts').doc(contactId);
      const snap = await contactRef.get();
      const current = snap.exists ? snap.data() || {} : {};
      if (!snap.exists || current.type !== 'contact') return res.status(404).json({ ok: false, error: 'Contact not found' });
      if (current.system) return res.status(403).json({ ok: false, error: 'This contact cannot be deleted' });

      await contactRef.delete();
      await refreshContactsMeta({ fbAdmin, userRef });
      await destroyContactPhoto(config, current.photoPublicId || '');
      return res.json({ ok: true, deletedId: contactId });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to delete contact' });
    }
  });

  return router;
}
