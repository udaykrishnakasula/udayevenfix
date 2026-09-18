/**
 * EasyX In-Process Transaction Lock Manager
 * 
 * Provides robust, dead-lock safe, keyed asynchronous serialization for financial operations:
 * - Investment purchase: locks `user:${userId}`
 * - Deposit decision: locks `deposit:${depositId}` and `user:${userId}`
 * - Maturity payout: locks `investment:${investmentId}` and `user:${userId}`
 * - Withdrawal create/process: locks `withdrawal:${withdrawalId}` and `user:${userId}`
 * 
 * Keys are always acquired in deterministic alphabetical order to prevent deadlocks.
 * Automatic timeout guards against orphaned locks.
 */

type LockRelease = () => void;

class TransactionLockManager {
  private activeLocks = new Map<string, Promise<void>>();

  /**
   * Acquire an exclusive lock on a single key.
   */
  public async acquire(key: string, timeoutMs = 15000): Promise<LockRelease> {
    let releaseCurrent!: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    let timeoutHandle: NodeJS.Timeout | null = null;

    while (this.activeLocks.has(key)) {
      const existing = this.activeLocks.get(key);
      if (existing) {
        // Wait for prior holder with a safety timeout
        const timeoutPromise = new Promise<boolean>((res) => {
          timeoutHandle = setTimeout(() => res(true), timeoutMs);
        });
        const timedOut = await Promise.race([
          existing.then(() => false),
          timeoutPromise,
        ]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (timedOut) {
          console.warn(`[TransactionLockManager] Lock wait timed out on key: ${key}. Forcing lock progression.`);
          break;
        }
      }
    }

    this.activeLocks.set(key, lockPromise);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (this.activeLocks.get(key) === lockPromise) {
        this.activeLocks.delete(key);
      }
      releaseCurrent();
    };
  }

  /**
   * Acquire exclusive locks on multiple keys in deterministic sorted order.
   */
  public async acquireMany(keys: string[], timeoutMs = 15000): Promise<LockRelease> {
    const uniqueSortedKeys = Array.from(new Set(keys.filter(Boolean))).sort();
    const releases: LockRelease[] = [];

    for (const key of uniqueSortedKeys) {
      const release = await this.acquire(key, timeoutMs);
      releases.push(release);
    }

    return () => {
      // Release in reverse order
      for (const release of releases.reverse()) {
        try {
          release();
        } catch (e) {
          // ignore
        }
      }
    };
  }

  /**
   * Execute an async action within a guarded lock scope.
   */
  public async withLock<T>(keys: string | string[], action: () => Promise<T>, timeoutMs = 15000): Promise<T> {
    const keyArray = Array.isArray(keys) ? keys : [keys];
    const release = await this.acquireMany(keyArray, timeoutMs);
    try {
      return await action();
    } finally {
      release();
    }
  }
}

export const transactionLocks = new TransactionLockManager();
