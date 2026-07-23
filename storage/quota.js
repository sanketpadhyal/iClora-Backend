import { getFirebaseAdmin } from '../firebase.js';
import { getSupabaseAdmin } from '../supabase/client.js';

const APP_STORAGE_SOURCES = ['photos', 'notes', 'contacts'];
const DEFAULT_STORAGE_LIMIT_MB = 1024;
const STORAGE_EPSILON_MB = 0.0001;

export function normalizeStorageMb(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

export function toMbFromBytes(bytes) {
  const amount = Number(bytes);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number((amount / (1024 * 1024)).toFixed(4));
}

function textStorageMb(...parts) {
  const bytes = parts.reduce((total, part) => total + Buffer.byteLength(String(part || ''), 'utf8'), 0);
  return Number((bytes / (1024 * 1024)).toFixed(4));
}

function storageLimitMb(user = {}) {
  const storage = Number(user.storage);
  return Number.isFinite(storage) && storage > 0 ? storage : DEFAULT_STORAGE_LIMIT_MB;
}

function profilePhotoStorageMb(user = {}) {
  return toMbFromBytes(user?.profilePhoto?.bytes);
}

function photoStorageMb(data = {}) {
  const stored = Number(data.storageUsed);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return toMbFromBytes(data.bytes);
}

async function readDeletedPhotosStorage(db, uid) {
  const [trashSnapshot, legacyDeletedSnapshot] = await Promise.all([
    db.collection('recentlyDeleted').doc(uid).collection('photos').get(),
    db.collection('users').doc(uid).collection('photos').where('deleted', '==', true).get(),
  ]);
  const trashStorage = trashSnapshot.docs.reduce((total, doc) => total + photoStorageMb(doc.data() || {}), 0);
  const legacyStorage = legacyDeletedSnapshot.docs.reduce((total, doc) => total + photoStorageMb(doc.data() || {}), 0);
  return normalizeStorageMb(trashStorage + legacyStorage);
}

function noteRowStorageMb(row = {}) {
  const stored = Number(row.storage_used);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return textStorageMb(row.title, row.content);
}

function contactRowStorageMb(row = {}) {
  const storedTextStorage = Number(row.storage_used);
  const extraPhones = Array.isArray(row.extra_phones) ? row.extra_phones : [];
  const textStorageUsed = Number.isFinite(storedTextStorage) && storedTextStorage > 0
    ? storedTextStorage
    : textStorageMb(row.display_name, row.first_name, row.last_name, row.company, row.phone, ...extraPhones, row.email, row.birthday, row.address, row.note);
  return Number(textStorageUsed || 0) + Number(row.photo_storage_used || 0);
}

async function readSupabaseNotesStorage(uid) {
  const sb = getSupabaseAdmin();
  const result = await sb.from('notes_items').select('title,content,storage_used').eq('user_id', uid);
  if (result.error) throw result.error;
  return normalizeStorageMb((result.data || []).reduce((total, row) => total + noteRowStorageMb(row), 0));
}

async function readSupabaseContactsStorage(uid) {
  const sb = getSupabaseAdmin();
  const result = await sb
    .from('contacts_items')
    .select('display_name,first_name,last_name,company,phone,extra_phones,email,birthday,address,note,storage_used,photo_storage_used')
    .eq('user_id', uid);
  if (result.error) throw result.error;
  return normalizeStorageMb((result.data || []).reduce((total, row) => total + contactRowStorageMb(row), 0));
}

export async function readAccountStorageUsage({
  firebaseServiceAccountPath,
  uid,
  userRef: providedUserRef,
  user: providedUser,
  useSupabaseForNotes = false,
  useSupabaseForContacts = false,
} = {}) {
  if (!uid) {
    const error = new Error('Missing session');
    error.status = 401;
    throw error;
  }

  const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
  const db = providedUserRef?.firestore || fbAdmin.firestore();
  const userRef = providedUserRef || db.collection('users').doc(uid);
  const user = providedUser || ((await userRef.get()).data() || {});
  const [snapshots, deletedPhotosStorage, supabaseNotesStorage, supabaseContactsStorage] = await Promise.all([
    Promise.all(APP_STORAGE_SOURCES.map((app) => userRef.collection(app).doc('meta').get())),
    readDeletedPhotosStorage(db, uid),
    useSupabaseForNotes ? readSupabaseNotesStorage(uid) : Promise.resolve(null),
    useSupabaseForContacts ? readSupabaseContactsStorage(uid) : Promise.resolve(null),
  ]);

  const appStorage = APP_STORAGE_SOURCES.reduce((total, app, index) => {
    if (app === 'notes' && supabaseNotesStorage !== null) return total + supabaseNotesStorage;
    if (app === 'contacts' && supabaseContactsStorage !== null) return total + supabaseContactsStorage;
    const data = snapshots[index].exists ? snapshots[index].data() || {} : {};
    const storageUsed = normalizeStorageMb(data.storageUsed);
    return total + storageUsed + (app === 'photos' ? deletedPhotosStorage : 0);
  }, 0);

  const usedMb = Number((appStorage + profilePhotoStorageMb(user)).toFixed(4));
  const limitMb = storageLimitMb(user);
  return {
    user,
    userRef,
    usedMb,
    limitMb,
    availableMb: Number(Math.max(0, limitMb - usedMb).toFixed(4)),
  };
}

export async function assertStorageCapacity({
  firebaseServiceAccountPath,
  uid,
  userRef,
  user,
  incomingStorageMb = 0,
  replacingStorageMb = 0,
  useSupabaseForNotes = false,
  useSupabaseForContacts = false,
} = {}) {
  const usage = await readAccountStorageUsage({
    firebaseServiceAccountPath,
    uid,
    userRef,
    user,
    useSupabaseForNotes,
    useSupabaseForContacts,
  });
  const incoming = normalizeStorageMb(incomingStorageMb);
  const replacing = normalizeStorageMb(replacingStorageMb);
  const nextUsedMb = Number((Math.max(0, usage.usedMb - replacing) + incoming).toFixed(4));
  if (nextUsedMb > usage.limitMb + STORAGE_EPSILON_MB) {
    const error = new Error(`Storage full. You have ${usage.availableMb} MB available.`);
    error.status = 413;
    error.code = 'STORAGE_LIMIT_REACHED';
    error.storage = {
      limitMb: usage.limitMb,
      usedMb: usage.usedMb,
      availableMb: usage.availableMb,
      incomingMb: incoming,
    };
    throw error;
  }
  return { ...usage, nextUsedMb };
}
