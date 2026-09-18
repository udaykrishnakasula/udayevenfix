import { supabaseDb } from "./supabaseDb";
import { isSupabaseAdminConfigured } from "./supabaseAdmin";
import crypto from "crypto";

class MaturityWorker {
  private readonly instanceId = `worker-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt: string | null = null;
  private totalMatured = 0;
  private consecutiveErrors = 0;
  private readonly lockKey = "worker_lock:maturity_sweep";
  private readonly lockTtlMs = 90000; // 90-second distributed lease

  /**
   * Checks whether a sweep is due and triggers it asynchronously if enough time has elapsed.
   * Ensures execution even if container CPU throttling or sleep suspended in-process timers.
   */
  public async triggerSweepIfDue(minIntervalMs = 45000): Promise<void> {
    if (this.isRunning) return;
    const now = Date.now();
    const lastRunTime = this.lastRunAt ? new Date(this.lastRunAt).getTime() : 0;
    if (now - lastRunTime >= minIntervalMs) {
      this.runSweep().catch((err) => {
        console.warn("[EasyX Maturity Worker] Autonomous sweep notice:", err?.message || err);
      });
    }
  }

  /**
   * Executes an authoritative, idempotent maturity sweep across all eligible active investments.
   * Coordinates across multiple server instances using distributed locks in Supabase.
   */
  public async runSweep(): Promise<{
    success: boolean;
    matured: number;
    matured_ids: string[];
    durationMs: number;
    lastRunAt: string;
    locked?: boolean;
  }> {
    if (this.isRunning) {
      return {
        success: true,
        matured: 0,
        matured_ids: [],
        durationMs: 0,
        lastRunAt: this.lastRunAt || new Date().toISOString(),
      };
    }

    if (!isSupabaseAdminConfigured()) {
      return {
        success: false,
        matured: 0,
        matured_ids: [],
        durationMs: 0,
        lastRunAt: new Date().toISOString(),
      };
    }

    // 1. Acquire distributed lease lock in Supabase platform_settings
    const hasLock = await supabaseDb.acquireDistributedLock(this.lockKey, this.instanceId, this.lockTtlMs);
    if (!hasLock) {
      // Another server instance holds the active lock
      return {
        success: true,
        matured: 0,
        matured_ids: [],
        durationMs: 0,
        lastRunAt: this.lastRunAt || new Date().toISOString(),
        locked: true,
      };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      // Record running status in Supabase
      await supabaseDb.recordSchedulerHeartbeat("maturity_sweep", {
        status: "running",
        lastRunAt: new Date().toISOString(),
        lastDurationMs: 0,
        lastMaturedCount: 0,
        workerInstanceId: this.instanceId,
      });

      const result = await supabaseDb.runMaturitySweep();
      const durationMs = Date.now() - startTime;
      this.lastRunAt = new Date().toISOString();
      this.totalMatured += result.matured;
      this.consecutiveErrors = 0;

      if (result.matured > 0) {
        console.log(
          `[EasyX Maturity Worker] [${this.instanceId}] Processed ${result.matured} matured investment(s) in ${durationMs}ms.`
        );
      }

      // Record idle/completed status in Supabase
      await supabaseDb.recordSchedulerHeartbeat("maturity_sweep", {
        status: "idle",
        lastRunAt: this.lastRunAt,
        lastDurationMs: durationMs,
        lastMaturedCount: result.matured,
        workerInstanceId: this.instanceId,
      });

      return {
        success: true,
        matured: result.matured,
        matured_ids: result.matured_ids,
        durationMs,
        lastRunAt: this.lastRunAt,
      };
    } catch (err: any) {
      this.consecutiveErrors++;
      const durationMs = Date.now() - startTime;
      console.error(`[EasyX Maturity Worker] Error during maturity sweep:`, err.message || err);

      await supabaseDb.recordSchedulerHeartbeat("maturity_sweep", {
        status: "error",
        lastRunAt: new Date().toISOString(),
        lastDurationMs: durationMs,
        lastMaturedCount: 0,
        lastError: err?.message || String(err),
        workerInstanceId: this.instanceId,
      });

      return {
        success: false,
        matured: 0,
        matured_ids: [],
        durationMs,
        lastRunAt: new Date().toISOString(),
      };
    } finally {
      // Release distributed lock
      await supabaseDb.releaseDistributedLock(this.lockKey, this.instanceId);
      this.isRunning = false;
    }
  }

  /**
   * Starts the background scheduler with an initial startup run and recurring intervals.
   * The initial startup run immediately processes any investments that became mature
   * while the server was offline or restarting.
   */
  public start(intervalMs = 60000): void {
    if (this.timer) return;

    // Immediate startup check after 2 seconds (processes offline/restart backlog)
    setTimeout(() => {
      this.runSweep().catch(() => {});
    }, 2000);

    // Recurring interval
    this.timer = setInterval(() => {
      this.runSweep().catch(() => {});
    }, intervalMs);

    if (this.timer.unref) {
      this.timer.unref();
    }

    console.log(
      `[EasyX Maturity Worker] Started autonomous maturity worker [${this.instanceId}] (${intervalMs / 1000}s interval).`
    );
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getStatus() {
    return {
      instanceId: this.instanceId,
      active: Boolean(this.timer),
      isProcessing: this.isRunning,
      lastRunAt: this.lastRunAt,
      totalMaturedLifetime: this.totalMatured,
      consecutiveErrors: this.consecutiveErrors,
    };
  }
}

export const maturityWorker = new MaturityWorker();

