import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Client-side environment variables
const env = (import.meta as any).env || {};
const DEFAULT_SUPABASE_URL = "";
const DEFAULT_SUPABASE_ANON_KEY = "";

export function getResolvedClientUrl(): string {
  const env = (import.meta as any).env || {};
  const rawUrl = (
    env.VITE_SUPABASE_URL ||
    (typeof window !== "undefined" && (window as any).__EASYX_SUPABASE_URL__) ||
    DEFAULT_SUPABASE_URL
  ).trim();
  return rawUrl.replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");
}

export function getResolvedClientAnonKey(): string {
  const env = (import.meta as any).env || {};
  return (
    env.VITE_SUPABASE_ANON_KEY ||
    (typeof window !== "undefined" && (window as any).__EASYX_SUPABASE_ANON_KEY__) ||
    DEFAULT_SUPABASE_ANON_KEY
  ).trim();
}

export const isSupabaseConfigured = (): boolean => {
  const url = getResolvedClientUrl();
  const anonKey = getResolvedClientAnonKey();
  return Boolean(
    url &&
    anonKey &&
    url.startsWith("https://") &&
    anonKey.length > 20
  );
};

let clientInstance: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) {
    return null;
  }
  const url = getResolvedClientUrl();
  const anonKey = getResolvedClientAnonKey();
  if (!clientInstance) {
    clientInstance = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    });
  }
  return clientInstance;
}

export const supabase = getSupabaseClient();

/**
 * Realtime subscription helper for user-specific events (e.g. notifications, balance updates)
 */
export function subscribeToUserEvents(
  userId: string,
  onUpdate: (payload: any) => void
) {
  const client = getSupabaseClient();
  if (!client || !userId) return () => {};

  const channel = client
    .channel(`user-events-${userId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "notifications",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => onUpdate({ type: "notification", data: payload })
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "wallets",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => onUpdate({ type: "wallet", data: payload })
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "withdrawals",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => onUpdate({ type: "withdrawal", data: payload })
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "kyc_records",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => onUpdate({ type: "kyc", data: payload })
    )
    .subscribe();

  return () => {
    client.removeChannel(channel);
  };
}

/**
 * Realtime subscription helper for administrative queue changes
 */
export function subscribeToAdminEvents(onUpdate: (payload: any) => void) {
  const client = getSupabaseClient();
  if (!client) return () => {};

  const channel = client
    .channel("admin-operational-events")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "payment_deposits",
      },
      (payload) => onUpdate({ type: "deposit", data: payload })
    )
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "withdrawals",
      },
      (payload) => onUpdate({ type: "withdrawal", data: payload })
    )
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "kyc_records",
      },
      (payload) => onUpdate({ type: "kyc", data: payload })
    )
    .subscribe();

  return () => {
    client.removeChannel(channel);
  };
}
