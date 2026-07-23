import express from 'express';
import { randomUUID } from 'crypto';
import { getSupabaseAdmin } from '../supabase/client.js';
import { assertStorageCapacity } from '../storage/quota.js';

const DEFAULT_FOLDER_ID = 'all-notes';
const MAX_FOLDERS = 50;

function cleanText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function toMb(...parts) {
  const bytes = parts.reduce((total, part) => total + Buffer.byteLength(String(part || ''), 'utf8'), 0);
  return Number((bytes / (1024 * 1024)).toFixed(4));
}

function noteStorageUsed(row = {}) {
  const stored = Number(row.storage_used);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return toMb(row.title, row.content);
}

function previewFrom(content = '') {
  const text = String(content || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 120);
}

function formatNote(row = {}) {
  return {
    id: row.id,
    type: 'note',
    title: cleanText(row.title, 'Untitled'),
    content: typeof row.content === 'string' ? row.content : '',
    preview: typeof row.preview === 'string' ? row.preview : previewFrom(row.content),
    folderId: cleanText(row.folder_id, DEFAULT_FOLDER_ID),
    pinned: Boolean(row.pinned),
    locked: Boolean(row.locked),
    system: Boolean(row.system),
    storageUsed: noteStorageUsed(row),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    createdAtLabel: typeof row.created_at_label === 'string' ? row.created_at_label : '',
    from: typeof row.from === 'string' ? row.from : '',
  };
}

function formatFolder(row = {}) {
  return {
    id: row.id,
    type: 'folder',
    name: cleanText(row.name, row.id === DEFAULT_FOLDER_ID ? 'Notes' : 'Folder'),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    system: Boolean(row.system),
  };
}

function throwIfSupabaseError(result) {
  if (result?.error) throw result.error;
  return result;
}

function isStaleWrite(baseUpdatedAt, currentUpdatedAt) {
  if (typeof baseUpdatedAt !== 'string' || !baseUpdatedAt || !currentUpdatedAt) return false;
  const baseTime = Date.parse(baseUpdatedAt);
  const currentTime = Date.parse(currentUpdatedAt);
  if (!Number.isFinite(baseTime) || !Number.isFinite(currentTime)) return false;
  return currentTime > baseTime + 1000;
}

async function ensureNotesCloud({ sb, uid }) {
  const { data: meta, error: metaError } = await sb.from('notes_meta').select('*').eq('user_id', uid).maybeSingle();
  if (metaError) throw metaError;
  if (!meta?.active) return false;

  const { data: defaultFolder, error: folderError } = await sb.from('notes_folders').select('id').eq('user_id', uid).eq('id', DEFAULT_FOLDER_ID).maybeSingle();
  if (folderError) throw folderError;
  if (!defaultFolder) {
    const folderResult = await sb.from('notes_folders').insert({
      id: DEFAULT_FOLDER_ID,
      user_id: uid,
      name: 'Notes',
      system: true,
    });
    if (folderResult.error?.code !== '23505') {
      throwIfSupabaseError(folderResult);
    }
  }
  return true;
}

async function recalcMeta(sb, uid) {
  const [notesResult, foldersResult, storageResult] = await Promise.all([
    sb.from('notes_items').select('*', { count: 'exact', head: true }).eq('user_id', uid),
    sb.from('notes_folders').select('*', { count: 'exact', head: true }).eq('user_id', uid),
    sb.from('notes_items').select('title,content,storage_used').eq('user_id', uid),
  ]);

  throwIfSupabaseError(notesResult);
  throwIfSupabaseError(foldersResult);
  throwIfSupabaseError(storageResult);

  const notesCount = notesResult.count;
  const foldersCount = foldersResult.count;
  const storageRows = storageResult.data;
  const storageUsed = Number((storageRows || []).reduce((sum, row) => sum + noteStorageUsed(row), 0).toFixed(4));
  throwIfSupabaseError(await sb.from('notes_meta').upsert({
    user_id: uid,
    active: true,
    status: 'activate',
    storage_used: storageUsed,
    notes_count: notesCount || 0,
    folders_count: Math.max(1, foldersCount || 0),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' }));
}

export default function createSupabaseNotesRouter({ requireSession, firebaseServiceAccountPath }) {
  const router = express.Router();
  if (typeof requireSession === 'function') router.use(requireSession);

  router.get('/notes', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const sb = getSupabaseAdmin();
      const active = await ensureNotesCloud({ sb, uid });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Notes Cloud is not activated' });

      const [foldersResult, notesResult, metaResult] = await Promise.all([
        sb.from('notes_folders').select('*').eq('user_id', uid),
        sb.from('notes_items').select('*').eq('user_id', uid).order('updated_at', { ascending: false }),
        sb.from('notes_meta').select('*').eq('user_id', uid).maybeSingle(),
      ]);
      throwIfSupabaseError(foldersResult);
      throwIfSupabaseError(notesResult);
      throwIfSupabaseError(metaResult);

      const folders = foldersResult.data || [];
      const notes = notesResult.data || [];
      const meta = metaResult.data || {};
      const mappedFolders = (folders || []).map(formatFolder);
      if (!mappedFolders.some((folder) => folder.id === DEFAULT_FOLDER_ID)) {
        mappedFolders.unshift({ id: DEFAULT_FOLDER_ID, type: 'folder', name: 'Notes', system: true, createdAt: '', updatedAt: '' });
      }
      return res.json({ ok: true, folders: mappedFolders, notes: (notes || []).map(formatNote), meta });
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
      const sb = getSupabaseAdmin();
      const active = await ensureNotesCloud({ sb, uid });
      if (!active) return res.status(403).json({ ok: false, needsSetup: true, error: 'Notes Cloud is not activated' });

      const [notesResult, metaResult] = await Promise.all([
        sb.from('notes_items').select('id,title,preview,folder_id,pinned,locked,system,created_at,updated_at').eq('user_id', uid).order('updated_at', { ascending: false }).limit(limitSize),
        sb.from('notes_meta').select('*').eq('user_id', uid).maybeSingle(),
      ]);
      throwIfSupabaseError(notesResult);
      throwIfSupabaseError(metaResult);
      return res.json({ ok: true, notes: (notesResult.data || []).map(formatNote), meta: metaResult.data || {} });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to load notes preview' });
    }
  });

  router.post('/notes/folders', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const name = cleanText(req.body?.name, 'New Folder').slice(0, 64);
      const sb = getSupabaseAdmin();

      const { count, error: countError } = await sb.from('notes_folders').select('*', { count: 'exact', head: true }).eq('user_id', uid);
      if (countError) throw countError;
      if ((count || 0) >= MAX_FOLDERS) {
        return res.status(400).json({ ok: false, error: `Folder limit reached. You can create up to ${MAX_FOLDERS} folders.` });
      }

      const row = { id: `folder-${randomUUID()}`, user_id: uid, name, system: false };
      const { error } = await sb.from('notes_folders').insert(row);
      if (error) throw error;
      await recalcMeta(sb, uid);
      return res.json({ ok: true, folder: formatFolder(row) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to create folder' });
    }
  });

  router.patch('/notes/folders/:folderId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { folderId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!folderId || folderId === DEFAULT_FOLDER_ID) return res.status(400).json({ ok: false, error: 'This folder cannot be renamed' });
      const name = cleanText(req.body?.name, 'Folder').slice(0, 64);
      const sb = getSupabaseAdmin();

      const { data: folder, error: folderError } = await sb.from('notes_folders').select('*').eq('user_id', uid).eq('id', folderId).maybeSingle();
      if (folderError) throw folderError;
      if (!folder) return res.status(404).json({ ok: false, error: 'Folder not found' });
      if (folder.system) return res.status(403).json({ ok: false, error: 'This folder cannot be renamed' });

      const updatedAt = new Date().toISOString();
      throwIfSupabaseError(await sb.from('notes_folders').update({ name, updated_at: updatedAt }).eq('user_id', uid).eq('id', folderId));
      return res.json({ ok: true, folder: formatFolder({ ...folder, name, updated_at: updatedAt }) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to rename folder' });
    }
  });

  router.delete('/notes/folders/:folderId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { folderId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!folderId || folderId === DEFAULT_FOLDER_ID) return res.status(400).json({ ok: false, error: 'This folder cannot be deleted' });
      const sb = getSupabaseAdmin();

      const { data: folder, error: folderError } = await sb.from('notes_folders').select('*').eq('user_id', uid).eq('id', folderId).maybeSingle();
      if (folderError) throw folderError;
      if (!folder) return res.status(404).json({ ok: false, error: 'Folder not found' });
      if (folder.system) return res.status(403).json({ ok: false, error: 'This folder cannot be deleted' });

      throwIfSupabaseError(await sb.from('notes_items').delete().eq('user_id', uid).eq('folder_id', folderId).eq('system', false));
      throwIfSupabaseError(await sb.from('notes_folders').delete().eq('user_id', uid).eq('id', folderId));
      await recalcMeta(sb, uid);
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
      const sb = getSupabaseAdmin();

      const row = {
        id: `note-${randomUUID()}`,
        user_id: uid,
        folder_id: folderId,
        title,
        content,
        preview: previewFrom(content),
        pinned: false,
        locked: false,
        system: false,
        storage_used: toMb(title, content),
      };
      await assertStorageCapacity({
        firebaseServiceAccountPath,
        uid,
        incomingStorageMb: row.storage_used,
        useSupabaseForNotes: true,
        useSupabaseForContacts: true,
      });
      const { error } = await sb.from('notes_items').insert(row);
      if (error) throw error;
      await recalcMeta(sb, uid);
      return res.json({ ok: true, note: formatNote(row) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to create note' });
    }
  });

  router.patch('/notes/:noteId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { noteId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!noteId) return res.status(400).json({ ok: false, error: 'Invalid note' });
      const sb = getSupabaseAdmin();

      const { data: current, error: currentError } = await sb.from('notes_items').select('*').eq('user_id', uid).eq('id', noteId).maybeSingle();
      if (currentError) throw currentError;
      if (!current) return res.status(404).json({ ok: false, error: 'Note not found' });
      if (current.system || current.locked) return res.status(403).json({ ok: false, error: 'This note is locked and cannot be edited' });
      if (isStaleWrite(req.body?.baseUpdatedAt, current.updated_at)) {
        return res.status(409).json({
          ok: false,
          conflict: true,
          error: 'A newer version of this note exists',
          note: formatNote(current),
        });
      }

      const nextTitle = typeof req.body?.title === 'string' ? cleanText(req.body.title, 'Untitled').slice(0, 160) : cleanText(current.title, 'Untitled');
      const nextContent = typeof req.body?.content === 'string' ? req.body.content.slice(0, 60000) : (typeof current.content === 'string' ? current.content : '');
      const nextFolderId = typeof req.body?.folderId === 'string' ? cleanText(req.body.folderId, DEFAULT_FOLDER_ID).slice(0, 96) : cleanText(current.folder_id, DEFAULT_FOLDER_ID);
      const nextPinned = typeof req.body?.pinned === 'boolean' ? req.body.pinned : Boolean(current.pinned);
      const patch = {
        title: nextTitle,
        content: nextContent,
        preview: previewFrom(nextContent),
        folder_id: nextFolderId,
        pinned: nextPinned,
        storage_used: toMb(nextTitle, nextContent),
        updated_at: new Date().toISOString(),
      };
      await assertStorageCapacity({
        firebaseServiceAccountPath,
        uid,
        incomingStorageMb: patch.storage_used,
        replacingStorageMb: noteStorageUsed(current),
        useSupabaseForNotes: true,
        useSupabaseForContacts: true,
      });
      const { error } = await sb.from('notes_items').update(patch).eq('user_id', uid).eq('id', noteId);
      if (error) throw error;
      await recalcMeta(sb, uid);
      return res.json({ ok: true, note: formatNote({ ...current, ...patch, id: noteId }) });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to update note' });
    }
  });

  router.delete('/notes/:noteId', async (req, res) => {
    try {
      const { uid } = req.session || {};
      const { noteId } = req.params || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      if (!noteId) return res.status(400).json({ ok: false, error: 'Invalid note' });
      const sb = getSupabaseAdmin();

      const { data: note, error: noteError } = await sb.from('notes_items').select('*').eq('user_id', uid).eq('id', noteId).maybeSingle();
      if (noteError) throw noteError;
      if (!note) return res.status(404).json({ ok: false, error: 'Note not found' });
      if (note.system) return res.status(403).json({ ok: false, error: 'This main note cannot be deleted' });

      throwIfSupabaseError(await sb.from('notes_items').delete().eq('user_id', uid).eq('id', noteId));
      await recalcMeta(sb, uid);
      return res.json({ ok: true, deletedId: noteId });
    } catch (error) {
      return res.status(error?.status || 400).json({ ok: false, error: error?.message || 'Failed to delete note' });
    }
  });

  return router;
}
