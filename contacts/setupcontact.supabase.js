import express from 'express';
import { getSupabaseAdmin } from '../supabase/client.js';

const ICLORA_SUPPORT_EMAIL = 'icloraofficial@gmail.com';
const ICLORA_SUPPORT_PHONE = '8975659255';

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

function throwIfSupabaseError(result) {
  if (result?.error) throw result.error;
  return result;
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

export default function createSupabaseContactsSetupRouter({ requireSession }) {
  const router = express.Router();

  if (typeof requireSession === 'function') {
    router.use(requireSession);
  }

  router.post('/contacts/setup', async (req, res) => {
    try {
      const { uid, email } = req.session || {};
      if (!uid) return res.status(401).json({ ok: false, error: 'Missing session' });

      const sb = getSupabaseAdmin();
      const now = new Date();
      const activatedOnLabel = formatActivatedOnLabel(now);
      const { data: meta, error: metaError } = await sb
        .from('contacts_meta')
        .select('*')
        .eq('user_id', uid)
        .maybeSingle();
      if (metaError) throw metaError;

      const alreadyActive = meta?.active === true;
      const responseActivatedOnLabel = typeof meta?.activated_on_label === 'string' && meta.activated_on_label.trim()
        ? meta.activated_on_label
        : activatedOnLabel;

      throwIfSupabaseError(await sb.from('contacts_meta').upsert({
        user_id: uid,
        active: true,
        status: 'activate',
        storage_used: Number(meta?.storage_used || 0),
        contacts_count: Math.max(1, Number(meta?.contacts_count || 1)),
        activated_on: meta?.activated_on || now.toISOString(),
        activated_on_label: responseActivatedOnLabel,
        updated_at: now.toISOString(),
      }, { onConflict: 'user_id' }));

      const { data: existingWelcome, error: welcomeReadError } = await sb
        .from('contacts_items')
        .select('id,email,phone,storage_used')
        .eq('user_id', uid)
        .eq('id', 'iclora-support')
        .maybeSingle();
      if (welcomeReadError) throw welcomeReadError;

      const firstName = getFirstName(email, 'there');
      const supportNote = `Hello ${firstName}. Your Contacts Cloud was activated on ${responseActivatedOnLabel}.`;
      const supportStorageUsed = toMb('iClora Support', 'iClora', 'Support', 'iClora', ICLORA_SUPPORT_PHONE, ICLORA_SUPPORT_EMAIL, supportNote);
      if (!existingWelcome) {
        const welcomeResult = await sb.from('contacts_items').insert({
          id: 'iclora-support',
          user_id: uid,
          display_name: 'iClora Support',
          first_name: 'iClora',
          last_name: 'Support',
          company: 'iClora',
          phone: ICLORA_SUPPORT_PHONE,
          email: ICLORA_SUPPORT_EMAIL,
          note: supportNote,
          system: true,
          storage_used: supportStorageUsed,
          created_at_label: activatedOnLabel,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        });
        if (welcomeResult.error?.code !== '23505') {
          throwIfSupabaseError(welcomeResult);
        }
      } else if (existingWelcome.email !== ICLORA_SUPPORT_EMAIL || existingWelcome.phone !== ICLORA_SUPPORT_PHONE || Number(existingWelcome.storage_used || 0) <= 0) {
        throwIfSupabaseError(await sb
          .from('contacts_items')
          .update({
            phone: ICLORA_SUPPORT_PHONE,
            email: ICLORA_SUPPORT_EMAIL,
            note: supportNote,
            storage_used: supportStorageUsed,
            updated_at: now.toISOString(),
          })
          .eq('user_id', uid)
          .eq('id', 'iclora-support'));
      }

      await refreshContactsMeta(sb, uid);

      return res.json({
        ok: true,
        alreadyActive,
        activatedOnLabel: responseActivatedOnLabel,
      });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error?.message || 'Failed to activate contacts' });
    }
  });

  return router;
}
