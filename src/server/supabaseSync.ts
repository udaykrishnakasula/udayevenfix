/**
 * Supabase Synchronization Engine (DEPRECATED & DEACTIVATED)
 *
 * Notice: EasyX has migrated to native direct Supabase operations.
 * Supabase is the sole authoritative persistent data source.
 * Local memory to Supabase synchronization is prohibited and deactivated.
 */

export class SupabaseSyncService {
  private static instance: SupabaseSyncService | null = null;

  public static getInstance(): SupabaseSyncService {
    if (!this.instance) {
      this.instance = new SupabaseSyncService();
    }
    return this.instance;
  }

  public async syncUserProfile(_user: any): Promise<void> {
    // No-op: Supabase is directly authoritative
  }

  public async syncWallet(_userId: string, _wallet: any): Promise<void> {
    // No-op: Supabase is directly authoritative
  }

  public async syncTransaction(_tx: any): Promise<void> {
    // No-op: Supabase is directly authoritative
  }

  public async syncDeposit(_dep: any): Promise<void> {
    // No-op: Supabase is directly authoritative
  }

  public async syncWithdrawal(_wd: any): Promise<void> {
    // No-op: Supabase is directly authoritative
  }

  public async syncInvestment(_inv: any): Promise<void> {
    // No-op: Supabase is directly authoritative
  }

  public async syncKyc(_kyc: any): Promise<void> {
    // No-op: Supabase is directly authoritative
  }
}

export const supabaseSync = SupabaseSyncService.getInstance();
