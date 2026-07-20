import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireConfig } from '../config.js';

let client: SupabaseClient | null = null;

/**
 * Service-role Supabase client. Bypasses RLS by design — this backend is the only
 * component permitted to read/write these tables. Never expose this key to a browser.
 */
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(
      requireConfig('SUPABASE_URL'),
      requireConfig('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return client;
}
