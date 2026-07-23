import express from 'express';
import { getSupabaseAdmin } from '../supabase/client.js';

const DEFAULT_FOLDER_ID = 'all-notes';

function getFirstName(value, fallback = 'there') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  return text.split(/\s+/)[0] || fallback;
}

function formatActivatedOnLabel(date) {
  try {
    return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString();
  }
}

function throwIfSupabaseError(result) {
  if (result?.error) throw result.error;
  return result;
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

async function refreshNotesMeta(sb, uid) {
  const [notesResult, foldersResult, storageResult] = await Promise.all([
    sb.from('notes_items').select('*', { count: 'exact', head: true }).eq('user_id', uid),
    sb.from('notes_folders').select('*', { count: 'exact', head: true }).eq('user_id', uid),
    sb.from('notes_items').select('title,content,storage_used').eq('user_id', uid),
  ]);
  throwIfSupabaseError(notesResult);
  throwIfSupabaseError(foldersResult);
  throwIfSupabaseError(storageResult);

  const storageUsed = Number((storageResult.data || []).reduce((sum, row) => sum + noteStorageUsed(row), 0).toFixed(4));
  throwIfSupabaseError(await sb.from('notes_meta').upsert({
    user_id: uid,
    active: true,
    status: 'activate',
    storage_used: storageUsed,
    notes_count: notesResult.count || 0,
    folders_count: Math.max(1, foldersResult.count || 0),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' }));
}

export default function createSupabaseNotesSetupRouter({ requireSession }) {
  const router = express.Router();
  if (typeof requireSession === 'function') router.use(requireSession);

  router.post('/notes/setup', async (req, res) => {
    try {
      const { uid } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });
      const sb = getSupabaseAdmin();

      const now = new Date();
      const activatedOnLabel = formatActivatedOnLabel(now);
      const { data: userMeta, error: metaReadError } = await sb.from('notes_meta').select('*').eq('user_id', uid).maybeSingle();
      if (metaReadError) throw metaReadError;
      const alreadyActive = userMeta?.active === true;

      throwIfSupabaseError(await sb.from('notes_meta').upsert({
        user_id: uid,
        active: true,
        status: 'activate',
        storage_used: Number(userMeta?.storage_used || 0),
        notes_count: Math.max(1, Number(userMeta?.notes_count || 1)),
        folders_count: Math.max(1, Number(userMeta?.folders_count || 1)),
        activated_on: userMeta?.activated_on || now.toISOString(),
        activated_on_label: userMeta?.activated_on_label || activatedOnLabel,
        updated_at: now.toISOString(),
      }, { onConflict: 'user_id' }));

      const { data: existingDefaultFolder, error: folderReadError } = await sb
        .from('notes_folders')
        .select('id')
        .eq('user_id', uid)
        .eq('id', DEFAULT_FOLDER_ID)
        .maybeSingle();
      if (folderReadError) throw folderReadError;
      if (!existingDefaultFolder) {
        const folderResult = await sb.from('notes_folders').insert({
          id: DEFAULT_FOLDER_ID,
          user_id: uid,
          name: 'Notes',
          system: true,
          updated_at: now.toISOString(),
        });
        if (folderResult.error?.code !== '23505') {
          throwIfSupabaseError(folderResult);
        }
      }

      const { data: existingWelcome, error: welcomeReadError } = await sb.from('notes_items').select('id').eq('user_id', uid).eq('id', 'welcome-iclora').maybeSingle();
      if (welcomeReadError) throw welcomeReadError;
      if (!existingWelcome) {
        const firstName = getFirstName(req.session?.email || '', 'there');
        const content = `Hello ${firstName},\n\nYou activated your Notes Cloud on ${userMeta?.activated_on_label || activatedOnLabel}.\n\nWelcome to iClora Notes. Your space is ready for thoughts, reminders, and anything you want to keep safe.\n\nGreetings,\niClora`;
        const title = 'Welcome to iClora Notes';
        const welcomeResult = await sb.from('notes_items').insert({
          id: 'welcome-iclora',
          user_id: uid,
          folder_id: DEFAULT_FOLDER_ID,
          title,
          content,
          preview: `Hello ${firstName}, you activated your Notes Cloud on ${userMeta?.activated_on_label || activatedOnLabel}.`,
          pinned: true,
          locked: true,
          system: true,
          storage_used: toMb(title, content),
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        });
        if (welcomeResult.error?.code !== '23505') {
          throwIfSupabaseError(welcomeResult);
        }
      }

      await refreshNotesMeta(sb, uid);

      return res.json({ ok: true, alreadyActive, activatedOnLabel: userMeta?.activated_on_label || activatedOnLabel });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Failed to activate notes' });
    }
  });

  return router;
}
