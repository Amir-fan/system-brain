import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Browser Supabase client. Uses ONLY public browser-safe values:
 *   VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY
 * Never receives SUPABASE_SECRET_KEY or KIP_PLATFORM_ADMIN_TOKEN.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const publishable = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const supabase: SupabaseClient =
  url && publishable
    ? createClient(url, publishable, { auth: { persistSession: true, autoRefreshToken: true } })
    : (null as unknown as SupabaseClient);