import { Request, Response, NextFunction } from "express";
import { getSupabaseAdmin, isSupabaseAdminConfigured, getResolvedSupabaseUrl } from "./supabaseAdmin";

export interface DatabaseHealthStatus {
  ready: boolean;
  error?: string;
  latencyMs?: number;
  timestamp: string;
  tablesVerified?: string[];
}

let cachedStatus: DatabaseHealthStatus | null = null;
let lastCheckTime = 0;
const CACHE_TTL_MS = 10000; // 10 seconds cache

/**
 * Checks connectivity and verifies access to authoritative tables in Supabase PostgreSQL
 */
export async function checkDatabaseReadiness(forceCheck = false): Promise<DatabaseHealthStatus> {
  const now = Date.now();
  if (!forceCheck && cachedStatus && now - lastCheckTime < CACHE_TTL_MS) {
    return cachedStatus;
  }

  const startTime = Date.now();

  // 1. Verify required environment variables and admin client configuration
  if (!isSupabaseAdminConfigured()) {
    const status: DatabaseHealthStatus = {
      ready: false,
      error: "Supabase environment variables (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY) are missing or misconfigured.",
      timestamp: new Date().toISOString(),
    };
    cachedStatus = status;
    lastCheckTime = now;
    return status;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    const status: DatabaseHealthStatus = {
      ready: false,
      error: "Supabase administrative client failed to initialize.",
      timestamp: new Date().toISOString(),
    };
    cachedStatus = status;
    lastCheckTime = now;
    return status;
  }

  // 2. Perform live queries to verify that PostgreSQL is reachable and core schema tables exist
  try {
    const [plansRes, walletsRes, profilesRes, invsRes, depositsRes, withdrawalsRes] = await Promise.all([
      supabase.from("investment_plans").select("key").limit(1),
      supabase.from("wallets").select("id").limit(1),
      supabase.from("profiles").select("id").limit(1),
      supabase.from("investments").select("id").limit(1),
      supabase.from("payment_deposits").select("id").limit(1),
      supabase.from("withdrawals").select("id").limit(1),
    ]);

    if (plansRes.error) {
      throw new Error(`Failed to query investment_plans: ${plansRes.error.message}`);
    }
    if (walletsRes.error) {
      throw new Error(`Failed to query wallets: ${walletsRes.error.message}`);
    }
    if (profilesRes.error) {
      throw new Error(`Failed to query profiles: ${profilesRes.error.message}`);
    }
    if (invsRes.error) {
      throw new Error(`Failed to query investments: ${invsRes.error.message}`);
    }
    if (depositsRes.error) {
      throw new Error(`Failed to query payment_deposits: ${depositsRes.error.message}`);
    }
    if (withdrawalsRes.error) {
      throw new Error(`Failed to query withdrawals: ${withdrawalsRes.error.message}`);
    }

    const latencyMs = Date.now() - startTime;
    const status: DatabaseHealthStatus = {
      ready: true,
      latencyMs,
      timestamp: new Date().toISOString(),
      tablesVerified: ["investment_plans", "wallets", "profiles", "investments", "payment_deposits", "withdrawals"],
    };

    cachedStatus = status;
    lastCheckTime = now;
    return status;
  } catch (err: any) {
    console.warn("[EasyX Health] Supabase database unreachable or unhealthy:", err?.message || err);
    const status: DatabaseHealthStatus = {
      ready: false,
      error: `Database unavailable: ${err.message || String(err)}`,
      timestamp: new Date().toISOString(),
    };
    cachedStatus = status;
    lastCheckTime = now;
    return status;
  }
}

/**
 * Invalidate cache immediately when a database failure is detected in runtime operations
 */
export function markDatabaseUnhealthy(errorMessage: string): void {
  cachedStatus = {
    ready: false,
    error: errorMessage,
    timestamp: new Date().toISOString(),
  };
  lastCheckTime = Date.now();
}

/**
 * Express middleware that enforces FAIL-CLOSED behavior.
 * If Supabase PostgreSQL is unreachable or unready, blocks access with 503.
 */
export async function requireDatabaseHealthy(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const status = await checkDatabaseReadiness(false);
    if (!status.ready) {
      res.status(503).json({
        code: "database_unavailable",
        detail: "Server temporarily unavailable. Please try again later.",
        error: process.env.NODE_ENV === "development" ? status.error : undefined,
      });
      return;
    }
    next();
  } catch (err: any) {
    res.status(503).json({
      code: "database_unavailable",
      detail: "Server temporarily unavailable. Please try again later.",
    });
  }
}
