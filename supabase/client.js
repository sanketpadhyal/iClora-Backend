import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

let supabaseClient = null;

export function hasSupabaseConfig() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabaseAdmin() {
  if (supabaseClient) return supabaseClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Supabase is not configured. Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }
  supabaseClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { WebSocket },
    realtime: { transport: WebSocket },
  });
  return supabaseClient;
}
