import express from 'express';
import { randomUUID } from 'crypto';
import { v2 as cloudinary } from 'cloudinary';
import { getSupabaseAdmin } from '../supabase/client.js';
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

function toMb(...parts) {
  const bytes = parts.reduce((total, part) => total + Buffer.byteLength(String(part || ''), 'utf8'), 0);
  return Number((bytes / (1024 * 1024)).toFixed(4));
}

function rowStorageUsed(row = {}) {
  const storedTextStorage = Number(row.storage_used);
  const extraPhones = Array.isArray(row.extra_phones) ? row.extra_phones : [];
  const textStorageUsed = Number.isFinite(storedTextStorage) && storedTextStorage > 0
    ? storedTextStorage
    : toMb(row.display_name, row.first_name, row.last_name, row.company, row.phone, ...extraPhones, row.email, row.birthday, row.address, row.note);
  return Number(textStorageUsed || 0) + Number(row.photo_storage_used || 0);
}

function displayNameFrom(data = {}) {
  const displayName = cleanText(data.display_name ?? data.displayName);
  if (displayName) return displayName.slice(0, CONTACT_FIELD_LIMITS.displayName);
  const firstName = cleanText(data.first_name ?? data.firstName);
  const lastName = cleanText(data.last_name ?? data.lastName);
  const joined = [firstName, lastName].filter(Boolean).join(' ');
  return (joined || cleanText(data.company, 'New Contact')).slice(0, CONTACT_FIELD_LIMITS.displayName);
}

function formatContact(row = {}) {
  return {
    id: row.id,
    type: 'contact',
    displayName: displayNameFrom(row),
    firstName: typeof row.first_name === 'string' ? row.first_name : '',
    lastName: typeof row.last_name === 'string' ? row.last_name : '',
    company: typeof row.company === 'string' ? row.company : '',
    phone: typeof row.phone === 'string' ? row.phone : '',
    extraPhones: normalizeExtraPhones(row.extra_phones),
    email: typeof row.email === 'string' ? row.email : '',
    birthday: typeof row.birthday === 'string' ? row.birthday : '',
    address: typeof row.address === 'string' ? row.address : '',
    note: typeof row.note === 'string' ? row.note : '',
    photoUrl: typeof row.photo_url === 'string' ? row.photo_url : '',
    photoPublicId: typeof row.photo_public_id === 'string' ? row.photo_public_id : '',
    system: Boolean(row.system),
    storageUsed: Number(rowStorageUsed(row).toFixed(4)),
    photoStorageUsed: Number(row.photo_storage_used || 0),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    createdAtLabel: typeof row.created_at_label === 'string' ? row.created_at_label : '',
  };
}

function throwIfSupabaseError(result) {
  if (result?.error) throw result.error;
  return result;
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
    // Storage metadata must stay correct even if external asset cleanup is delayed.
  }
}

async function ensureContactsCloud({ sb, uid }) {
  const { data, error } = await sb
    .from('contacts_meta')
    .select('active')
    .eq('user_id', uid)
    .maybeSingle();
  if (error) throw error;
  return data?.active === true;
}

async function refreshContactsMeta(sb, uid) {
  const [countResult, storageResult] = await Promise.all([
    sb.from('contacts_items').select('*', { count: 'exact', head: true }).eq('user_id', uid),
    sb
      .from('contacts_items')
      .select('display_name,first_name,last_name,company,phone,extra_phones,email,birthday,address,note,storage_used,photo_storage_used')
      .eq('user_id', uid),
  ]);
  throwIfSupabaseError(countResult);
  throwIfSupabaseError(storageResult);

  const storageUsed = Number((storageResult.data || []).reduce((total, row) => total + rowStorageUsed(row), 0).toFixed(4));
  throwIfSupabaseError(await sb.from('contacts_meta').upsert({
    user_id: uid,
    active: true,
    status: 'activate',
    storage_used: storageUsed,
    contacts_count: countResult.count || 0,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' }));
}

async function ensureSupportContact({ sb, uid }) {
  const { data, error } = await sb
    .from('contacts_items')
    .select('id,display_name,first_name,last_name,company,phone,extra_phones,email,birthday,address,note,storage_used,photo_storage_used')
    .eq('user_id', uid)
    .eq('id', 'iclora-support')
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  if (data.email === ICLORA_SUPPORT_EMAIL && data.phone === ICLORA_SUPPORT_PHONE) return false;
  const patch = {
    phone: ICLORA_SUPPORT_PHONE,
    email: ICLORA_SUPPORT_EMAIL,
    updated_at: new Date().toISOString(),
  };
  patch.storage_used = toMb(
    data.display_name,
    data.first_name,
    data.last_name,
    data.company,
    patch.phone,
    ...(Array.isArray(data.extra_phones) ? data.extra_phones : []),
    patch.email,
    data.birthday,
    data.address,
    data.note
  );
  throwIfSupabaseError(await sb
    .from('contacts_items')
    .update(patch)
    .eq('user_id', uid)
    .eq('id', 'iclora-support'));
  return true;
}

function contactPayloadFromBody(body = {}, fallback = {}) {
  const payload = {
    display_name: typeof body.displayName === 'string'
      ? limitText(body.displayName, 'displayName', 'New Contact')
      : displayNameFrom(fallback),
    first_name: typeof body.firstName === 'string'
      ? limitText(body.firstName, 'firstName')
      : (fallback.first_name || ''),
    last_name: typeof body.lastName === 'string'
      ? limitText(body.lastName, 'lastName')
      : (fallback.last_name || ''),
    company: typeof body.company === 'string'
      ? limitText(body.company, 'company')
      : (fallback.company || ''),
    phone: typeof body.phone === 'string'
      ? limitText(body.phone, 'phone')
      : (fallback.phone || ''),
    extra_phones: Array.isArray(body.extraPhones)
      ? normalizeExtraPhones(body.extraPhones)
      : normalizeExtraPhones(fallback.extra_phones),
    email: typeof body.email === 'string'
      ? limitText(body.email, 'email')
      : (fallback.email || ''),
    birthday: typeof body.birthday === 'string'
      ? limitText(body.birthday, 'birthday')
      : (fallback.birthday || ''),
    address: typeof body.address === 'string'
      ? limitText(body.address, 'address')
      : (fallback.address || ''),
    note: typeof body.note === 'string'
      ? limitRawText(body.note, 'note')
      : (fallback.note || ''),
  };
  payload.display_name = displayNameFrom(payload);
  payload.storage_used = toMb(
    payload.display_name,
    payload.first_name,
    payload.last_name,
    payload.company,
    payload.phone,
    ...(payload.extra_phones || []),
    payload.email,
    payload.birthday,
    payload.address,
    payload.note
  );
  return payload;
}

export default function createSupabaseContactsRouter({ requireSession, config = {}, firebaseServiceAccountPath }) {
  const router = express.Router();
  if (typeof requireSession === 'function') router.use(requireSession);

  router.get('/contacts', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const sb = getSupabaseAdmin();
      const active = await ensureContactsCloud({ sb, uid });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Contacts Cloud is not activated' });
      const supportUpdated = await ensureSupportContact({ sb, uid });
      if (supportUpdated) await refreshContactsMeta(sb, uid);

      const [contactsResult, metaResult] = await Promise.all([
        sb.from('contacts_items').select('*').eq('user_id', uid).order('display_name', { ascending: true }),
        sb.from('contacts_meta').select('*').eq('user_id', uid).maybeSingle(),
      ]);
      throwIfSupabaseError(contactsResult);
      throwIfSupabaseError(metaResult);

      return res.json({
        ok: true,
        contacts: (contactsResult.data || []).map(formatContact),
        meta: metaResult.data || {},
      });
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
      const sb = getSupabaseAdmin();
      const active = await ensureContactsCloud({ sb, uid });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Contacts Cloud is not activated' });
      const supportUpdated = await ensureSupportContact({ sb, uid });
      if (supportUpdated) await refreshContactsMeta(sb, uid);

      const [contactsResult, metaResult] = await Promise.all([
        sb
          .from('contacts_items')
          .select('id,display_name,first_name,last_name,company,phone,email,photo_url,system,created_at,updated_at')
          .eq('user_id', uid)
          .order('display_name', { ascending: true })
          .limit(limitSize),
        sb.from('contacts_meta').select('*').eq('user_id', uid).maybeSingle(),
      ]);
      throwIfSupabaseError(contactsResult);
      throwIfSupabaseError(metaResult);

      return res.json({
        ok: true,
        contacts: (contactsResult.data || []).map(formatContact),
        meta: metaResult.data || {},
      });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load contacts preview' });
    }
  });

  router.post('/contacts', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const sb = getSupabaseAdmin();
      const active = await ensureContactsCloud({ sb, uid });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Contacts Cloud is not activated' });

      const now = new Date().toISOString();
      const row = {
        id: `contact-${randomUUID()}`,
        user_id: uid,
        ...contactPayloadFromBody(req.body, {}),
        system: false,
        created_at: now,
        updated_at: now,
      };
      await assertStorageCapacity({
        firebaseServiceAccountPath,
        uid,
        incomingStorageMb: rowStorageUsed(row),
        useSupabaseForNotes: true,
        useSupabaseForContacts: true,
      });
      throwIfSupabaseError(await sb.from('contacts_items').insert(row));
      await refreshContactsMeta(sb, uid);
      return res.json({ ok: true, contact: formatContact(row) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to create contact' });
    }
  });

  router.patch('/contacts/:contactId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { contactId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!contactId) return res.status(400).json({ ok: false, error: 'Invalid contact' });
      const sb = getSupabaseAdmin();
      const active = await ensureContactsCloud({ sb, uid });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Contacts Cloud is not activated' });

      const { data: current, error: currentError } = await sb
        .from('contacts_items')
        .select('*')
        .eq('user_id', uid)
        .eq('id', contactId)
        .maybeSingle();
      if (currentError) throw currentError;
      if (!current) return res.status(404).json({ ok: false, error: 'Contact not found' });
      if (current.system) return res.status(403).json({ ok: false, error: 'This contact cannot be edited' });

      const patch = {
        ...contactPayloadFromBody(req.body, current),
        updated_at: new Date().toISOString(),
      };
      await assertStorageCapacity({
        firebaseServiceAccountPath,
        uid,
        incomingStorageMb: Number(patch.storage_used || 0) + Number(current.photo_storage_used || 0),
        replacingStorageMb: rowStorageUsed(current),
        useSupabaseForNotes: true,
        useSupabaseForContacts: true,
      });
      throwIfSupabaseError(await sb.from('contacts_items').update(patch).eq('user_id', uid).eq('id', contactId));
      await refreshContactsMeta(sb, uid);
      return res.json({ ok: true, contact: formatContact({ ...current, ...patch }) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to update contact' });
    }
  });

  router.delete('/contacts/:contactId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { contactId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!contactId) return res.status(400).json({ ok: false, error: 'Invalid contact' });
      const sb = getSupabaseAdmin();
      const active = await ensureContactsCloud({ sb, uid });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Contacts Cloud is not activated' });

      const { data: current, error: currentError } = await sb
        .from('contacts_items')
        .select('id,system,photo_public_id')
        .eq('user_id', uid)
        .eq('id', contactId)
        .maybeSingle();
      if (currentError) throw currentError;
      if (!current) return res.status(404).json({ ok: false, error: 'Contact not found' });
      if (current.system) return res.status(403).json({ ok: false, error: 'This contact cannot be deleted' });

      throwIfSupabaseError(await sb.from('contacts_items').delete().eq('user_id', uid).eq('id', contactId));
      await refreshContactsMeta(sb, uid);
      await destroyContactPhoto(config, current.photo_public_id || '');
      return res.json({ ok: true, deletedId: contactId });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to delete contact' });
    }
  });

  return router;
}
