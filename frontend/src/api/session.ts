/**
 * @kip
 * @module api
 * @layer platform
 * @owner platform-api
 * @purpose Browser session ports for the canonical authenticated KIP API client.
 *
 * Wires the pure refresh-once/retry-once orchestration to the Supabase browser
 * session. Only the access token is ever handed to a request; refresh tokens and
 * secrets stay inside the Supabase client's own storage.
 */

import { supabase } from '../lib/supabase';
import { SESSION_EXPIRED_MESSAGE } from './session-retry';
import type { SessionPorts } from './session-retry';

/** Login-screen notice key (survives the sign-out redirect; not authority). */
export const SESSION_NOTICE_KEY = 'kip.sessionNotice';

export function createSessionPorts(): SessionPorts {
  return {
    async getToken() {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    },
    async refresh() {
      // Single, explicit refresh attempt — never a retry loop.
      const { data, error } = await supabase.auth.refreshSession();
      if (error) return null;
      return data.session?.access_token ?? null;
    },
    onExpired() {
      try {
        localStorage.setItem(SESSION_NOTICE_KEY, SESSION_EXPIRED_MESSAGE);
      } catch {
        /* storage unavailable — the sign-out below still returns the user to Login */
      }
      void supabase.auth.signOut();
    },
  };
}
