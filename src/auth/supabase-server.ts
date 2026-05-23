import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../server/config.js";

let _client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (_client) return _client;

  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_KEY) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set to verify auth tokens.",
    );
  }

  _client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return _client;
}
