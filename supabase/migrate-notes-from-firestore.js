import dotenv from 'dotenv';
import { getFirebaseAdmin } from '../firebase.js';
import { getSupabaseAdmin, hasSupabaseConfig } from './client.js';

dotenv.config();

const firebaseServiceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './service-account.json';

function asIso(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  return null;
}

async function run() {
  if (!hasSupabaseConfig()) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
  }

  const fbAdmin = getFirebaseAdmin(firebaseServiceAccountPath);
  const db = fbAdmin.firestore();
  const sb = getSupabaseAdmin();

  const usersSnap = await db.collection('users').get();
  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const notesSnap = await db.collection('users').doc(uid).collection('notes').get();

    const folders = [];
    const notes = [];
    let meta = null;

    notesSnap.forEach((doc) => {
      const data = doc.data() || {};
      if (doc.id === 'meta' || data.type === 'meta') {
        meta = {
          user_id: uid,
          active: data.active === true,
          status: data.status || 'activate',
          storage_used: Number(data.storageUsed || 0),
          notes_count: Number(data.notesCount || 0),
          folders_count: Number(data.foldersCount || 0),
          activated_on: asIso(data.activatedOn),
          activated_on_label: data.activatedOnLabel || null,
          updated_at: asIso(data.updatedAt) || new Date().toISOString(),
        };
        return;
      }

      if (data.type === 'folder') {
        folders.push({
          id: doc.id,
          user_id: uid,
          name: data.name || 'Folder',
          system: data.system === true,
          created_at: asIso(data.createdAt) || new Date().toISOString(),
          updated_at: asIso(data.updatedAt) || new Date().toISOString(),
        });
        return;
      }

      if (data.type === 'note') {
        notes.push({
          id: doc.id,
          user_id: uid,
          folder_id: data.folderId || 'all-notes',
          title: data.title || 'Untitled',
          from: data.from || null,
          content: data.content || '',
          preview: data.preview || '',
          pinned: data.pinned === true,
          locked: data.locked === true,
          system: data.system === true,
          storage_used: Number(data.storageUsed || 0),
          created_at_label: data.createdAtLabel || null,
          created_at: asIso(data.createdAt) || new Date().toISOString(),
          updated_at: asIso(data.updatedAt) || new Date().toISOString(),
        });
      }
    });

    if (meta) {
      const { error } = await sb.from('notes_meta').upsert(meta);
      if (error) throw error;
    }
    if (folders.length) {
      const { error } = await sb.from('notes_folders').upsert(folders);
      if (error) throw error;
    }
    if (notes.length) {
      const { error } = await sb.from('notes_items').upsert(notes);
      if (error) throw error;
    }

    // eslint-disable-next-line no-console
    console.log(`Migrated uid=${uid} folders=${folders.length} notes=${notes.length}`);
  }
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
