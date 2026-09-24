import {
  getSupabaseAdmin,
  isSupabaseAdminConfigured,
  isSupabaseServerConfigured,
  getSupabaseServerClient,
  getResolvedSupabaseUrl,
  getResolvedAnonKey,
  isAdminKeyVerified,
  markAdminKeyInvalid,
} from "./supabaseAdmin";
import { transactionLocks } from "./transactionLocks";
import * as crypto from "crypto";

export interface CleanUserProfile {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: "admin" | "user";
  status: "active" | "suspended" | "banned";
  email_verified: boolean;
  kyc_status: "none" | "pending" | "under_review" | "approved" | "rejected";
  referral_code: string;
  referred_by: string | null;
  two_factor_enabled: boolean;
  created_at: string;
  last_login_at: string | null;
  permanent_address?: string | null;
  address?: string | null;
  id_number_masked?: string | null;
}

export interface WalletSummary {
  currency: string;
  available_balance: string;
  locked_investment: string;
  total_portfolio: string;
  total_invested: string;
  total_earned: string;
}

function fmt(n: number | string | null | undefined): string {
  const num = Number(n || 0);
  return isNaN(num) ? "0.00" : num.toFixed(2);
}

export const isUuid = (str: any): boolean => {
  if (!str || typeof str !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
};

function createNoopSupabaseClient(): any {
  const defaultRes = { data: null, error: null, count: 0 };
  const promiseTarget = Promise.resolve(defaultRes);

  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === "then") return promiseTarget.then.bind(promiseTarget);
      if (prop === "catch") return promiseTarget.catch.bind(promiseTarget);
      if (prop === "finally") return promiseTarget.finally.bind(promiseTarget);
      if (prop === "auth") {
        return {
          admin: {
            createUser: async () => ({ data: { user: null }, error: null }),
            updateUserById: async () => ({ data: null, error: null }),
            deleteUser: async () => ({ data: null, error: null }),
            getUserById: async () => ({ data: { user: null }, error: null }),
            listUsers: async () => ({ data: { users: [] }, error: null }),
          },
          signInWithPassword: async () => ({ data: { user: null, session: null }, error: null }),
          getUser: async () => ({ data: { user: null }, error: null }),
        };
      }
      if (prop === "storage") {
        return {
          from: () => ({
            upload: async () => ({ data: { path: "local-proof" }, error: null }),
            createSignedUrl: async () => ({ data: { signedUrl: "" }, error: null }),
            getPublicUrl: () => ({ data: { publicUrl: "" } }),
          }),
        };
      }
      return (..._args: any[]) => new Proxy(promiseTarget, handler);
    },
    apply(_target, _thisArg, _argArray) {
      return new Proxy(promiseTarget, handler);
    },
  };

  return new Proxy(promiseTarget, handler);
}

export class SupabaseDbService {
  private static instance: SupabaseDbService | null = null;
  private inMemoryLocks = new Map<string, { holderId: string; lockedUntil: number }>();
  private inMemorySchedulerStates = new Map<string, any>();

  public static getInstance(): SupabaseDbService {
    if (!this.instance) {
      this.instance = new SupabaseDbService();
    }
    return this.instance;
  }

  public isUuid(str: any): boolean {
    return isUuid(str);
  }

  public isConfigured(): boolean {
    return isSupabaseServerConfigured();
  }

  private getClient(): any {
    const client = getSupabaseAdmin() || getSupabaseServerClient();
    if (!client) {
      return createNoopSupabaseClient();
    }
    return client;
  }

  /* -------------------------------------------------------------------------- */
  /*                            PROFILES & AUTH                                 */
  /* -------------------------------------------------------------------------- */

  public async getProfileById(userId: string): Promise<any | null> {
    if (!userId || typeof userId !== "string" || !isUuid(userId) || !this.isConfigured()) {
      return null;
    }
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      console.error("[SupabaseDb] Error fetching profile by id:", error.message);
      return null;
    }
    return data;
  }

  public async getProfileByEmail(email: string): Promise<any | null> {
    if (!email || !this.isConfigured()) return null;
    const supabase = this.getClient();
    const cleanEmail = email.trim().toLowerCase();
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .ilike("email", cleanEmail)
      .maybeSingle();

    if (error) {
      console.error("[SupabaseDb] Error fetching profile by email:", error.message);
      return null;
    }
    return data;
  }

  public async getProfileByPhone(phone: string): Promise<any | null> {
    if (!phone || !this.isConfigured()) return null;
    const supabase = this.getClient();
    const cleanPhone = phone.replace(/[^0-9]/g, "");
    const last10 = cleanPhone.slice(-10);

    const { data, error } = await supabase
      .from("profiles")
      .select("*");

    if (error || !data) return null;
    return data.find((p: any) => {
      if (!p.phone) return false;
      const num = p.phone.replace(/[^0-9]/g, "");
      return num.slice(-10) === last10;
    }) || null;
  }

  public async getProfileByReferralCode(code: string): Promise<any | null> {
    if (!code || !this.isConfigured()) return null;
    const supabase = this.getClient();
    const cleanCode = code.trim().toUpperCase();
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .ilike("referral_code", cleanCode)
      .maybeSingle();

    if (error) return null;
    return data;
  }

  public async registerUser(params: {
    email: string;
    password: string;
    name: string;
    phone: string;
    referralCode?: string | null;
  }): Promise<{ user: CleanUserProfile; session?: any }> {
    const cleanEmail = params.email.trim().toLowerCase();
    const cleanPhone = params.phone.trim();
    const cleanName = params.name.trim();

    if (!this.isConfigured()) {
      throw new Error("Supabase is not configured. Authoritative registration unavailable.");
    }

    const supabase = this.getClient();

    // 1. Check if referral code is valid if provided
    let referrer: any = null;
    if (params.referralCode) {
      referrer = await this.getProfileByReferralCode(params.referralCode);
      if (!referrer) {
        throw new Error("Invalid referral code.");
      }
    }

    // 2. Create user in Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: cleanEmail,
      password: params.password,
      email_confirm: true,
      user_metadata: {
        name: cleanName,
        phone: cleanPhone,
      },
    });

    if (authError || !authData?.user) {
      throw new Error(authError?.message || "Failed to create user in Supabase Auth.");
    }

    const userId = authData.user.id;

    // 3. Ensure profile and wallet exist (the trigger on_auth_user_created handles this,
    // but we ensure fields like phone, name, referral are accurately up-to-date)
    await new Promise((r) => setTimeout(r, 200));

    let profile = await this.getProfileById(userId);
    if (!profile) {
      // Upsert profile if trigger did not finish yet
      const genRef = "EX" + crypto.randomBytes(3).toString("hex").toUpperCase();
      const { data: pData, error: pErr } = await supabase
        .from("profiles")
        .upsert({
          id: userId,
          name: cleanName,
          email: cleanEmail,
          phone: cleanPhone,
          role: "user",
          status: "active",
          email_verified: true,
          kyc_status: "none",
          referral_code: genRef,
          referred_by: referrer ? referrer.id : null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (!pErr && pData) profile = pData;
    } else if (referrer && !profile.referred_by) {
      // Update referred_by
      await supabase
        .from("profiles")
        .update({ referred_by: referrer.id, phone: cleanPhone, name: cleanName })
        .eq("id", userId);
      profile.referred_by = referrer.id;
    }

    // 4. Ensure wallet exists
    const { data: existingWallet } = await supabase
      .from("wallets")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();

    if (!existingWallet) {
      await supabase.from("wallets").insert({
        user_id: userId,
        available_balance: 0,
        total_invested: 0,
        total_profit: 0,
        total_deposited: 0,
        total_withdrawn: 0,
        pending_withdrawal: 0,
      });
    }

    // 5. Record referral relationship if referred
    if (referrer) {
      try {
        await supabase.from("referrals").insert({
          referrer_id: referrer.id,
          referee_id: userId,
          referral_code: referrer.referral_code || params.referralCode,
          status: "active",
        });
      } catch (err: any) {
        console.warn("[SupabaseDb] Referral record notice:", err.message);
      }
    }

    // 6. Send welcome notification
    await this.createNotification({
      userId,
      type: "system",
      channel: "both",
      title: "Welcome to EasyX!",
      body: "Your investment account is active. Explore verified high-yield staking plans or fund your wallet.",
      actionUrl: "/investments",
      actionText: "Explore Plans",
    });

    const clean = this.formatProfile(profile || {
      id: userId,
      name: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      role: "user",
      status: "active",
      email_verified: true,
      kyc_status: "none",
      referral_code: "EX" + userId.slice(0, 6).toUpperCase(),
      referred_by: referrer ? referrer.id : null,
      two_factor_enabled: false,
      created_at: new Date().toISOString(),
      last_login_at: new Date().toISOString(),
    });

    return { user: clean };
  }

  public async authenticateUser(params: {
    email: string;
    password: string;
  }): Promise<{ user: CleanUserProfile; session?: any }> {
    if (!this.isConfigured()) {
      return null as any;
    }
    const rawUrl = getResolvedSupabaseUrl();
    const anonKey = getResolvedAnonKey();
    const cleanEmail = params.email.trim().toLowerCase();

    // Authenticate using Supabase Auth signInWithPassword
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(rawUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: authData, error: authErr } = await client.auth.signInWithPassword({
      email: cleanEmail,
      password: params.password,
    });

    if (authErr || !authData?.user) {
      throw new Error(authErr?.message || "Invalid email or password.");
    }

    const userId = authData.user.id;
    let profile = await this.getProfileById(userId);

    if (!profile) {
      // Fallback fetch/create profile
      const supabase = this.getClient();
      const meta = authData.user.user_metadata || {};
      const { data: newProfile } = await supabase
        .from("profiles")
        .upsert({
          id: userId,
          name: meta.name || "Investor",
          email: cleanEmail,
          phone: meta.phone || null,
          role: "user",
          status: "active",
          email_verified: Boolean(authData.user.email_confirmed_at),
          kyc_status: "none",
          referral_code: "EX" + crypto.randomBytes(3).toString("hex").toUpperCase(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();
      profile = newProfile;
    }

    // Update last_login_at
    const nowStr = new Date().toISOString();
    await this.getClient()
      .from("profiles")
      .update({ last_login_at: nowStr, updated_at: nowStr })
      .eq("id", userId);

    if (profile) profile.last_login_at = nowStr;

    return {
      user: this.formatProfile(profile),
      session: authData.session,
    };
  }

  public async changePassword(params: {
    userId: string;
    email: string;
    currentPassword: string;
    newPassword: string;
  }): Promise<{ success: boolean }> {
    if (!this.isConfigured()) {
      throw new Error("Supabase is not configured. Authoritative password update unavailable.");
    }
    const cleanEmail = params.email.trim().toLowerCase();
    const rawUrl = getResolvedSupabaseUrl();
    const anonKey = getResolvedAnonKey();
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(rawUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 1. Verify current password directly against Supabase Auth
    const { error: authErr } = await client.auth.signInWithPassword({
      email: cleanEmail,
      password: params.currentPassword,
    });
    if (authErr) {
      throw new Error("INCORRECT_CURRENT_PASSWORD");
    }

    // 2. Update password in Supabase Auth via Admin client
    const admin = getSupabaseAdmin();
    if (!admin) {
      throw new Error("Supabase Admin client is unavailable.");
    }
    const { error: updateErr } = await admin.auth.admin.updateUserById(params.userId, {
      password: params.newPassword,
    });
    if (updateErr) {
      throw new Error(updateErr.message || "Failed to update password in Supabase Auth.");
    }

    return { success: true };
  }

  public async updateProfile(userId: string, updates: Partial<any>): Promise<CleanUserProfile> {
    if (!this.isConfigured()) {
      return { id: userId, ...updates } as any;
    }
    const supabase = this.getClient();
    const nowStr = new Date().toISOString();
    const payload = { ...updates, updated_at: nowStr };
    delete (payload as any).id;

    const { data, error } = await supabase
      .from("profiles")
      .update(payload)
      .eq("id", userId)
      .select()
      .single();

    if (error) {
      throw new Error("Failed to update profile: " + error.message);
    }
    return this.formatProfile(data);
  }

  public async listAllUsers(): Promise<CleanUserProfile[]> {
    if (!this.isConfigured()) return [];
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: false });

    if (error || !data) return [];
    return data.map((p) => this.formatProfile(p));
  }

  public formatProfile(p: any): CleanUserProfile {
    return {
      id: p.id,
      name: p.name || "Investor",
      email: p.email || "",
      phone: p.phone || "",
      role: p.role === "admin" ? "admin" : "user",
      status: p.status || "active",
      email_verified: Boolean(p.email_verified),
      kyc_status: p.kyc_status || "none",
      referral_code: p.referral_code || "EX" + p.id?.slice(0, 6).toUpperCase(),
      referred_by: p.referred_by || null,
      two_factor_enabled: Boolean(p.two_factor_enabled),
      created_at: p.created_at || new Date().toISOString(),
      last_login_at: p.last_login_at || null,
      permanent_address: p.permanent_address || p.address || null,
      address: p.address || p.permanent_address || null,
      id_number_masked: p.id_number_masked || null,
    };
  }

  /* -------------------------------------------------------------------------- */
  /*                            WALLETS & BALANCES                              */
  /* -------------------------------------------------------------------------- */

  public async getWallet(userId: string): Promise<any> {
    if (!isSupabaseAdminConfigured()) {
      throw new Error("Supabase is not configured. Authoritative wallet access unavailable.");
    }
    if (!userId || !isUuid(userId)) {
      throw new Error(`Invalid user ID for wallet lookup: ${userId}`);
    }
    const supabase = this.getClient();
    let { data: wallet, error } = await supabase
      .from("wallets")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (!wallet) {
      const { data: created } = await supabase
        .from("wallets")
        .insert({
          user_id: userId,
          available_balance: 0,
          total_invested: 0,
          total_profit: 0,
          total_deposited: 0,
          total_withdrawn: 0,
          pending_withdrawal: 0,
        })
        .select()
        .single();
      wallet = created;
    }

    // Authoritative Ledger Reconciliation:
    // Ensure wallet balances reflect all completed transactions from the double-entry ledger.
    if (wallet && wallet.id) {
      const { data: txs } = await supabase
        .from("wallet_transactions")
        .select("type, direction, amount, status")
        .eq("user_id", userId)
        .eq("status", "completed");

      if (txs && txs.length > 0) {
        let ledgerBalance = 0;
        let ledgerDeposited = 0;
        for (const t of txs) {
          const amt = Number(t.amount || 0);
          if (t.direction === "credit") {
            ledgerBalance += amt;
            if (t.type === "DEPOSIT") {
              ledgerDeposited += amt;
            }
          } else if (t.direction === "debit") {
            ledgerBalance -= amt;
          }
        }

        const currentAvail = Number(wallet.available_balance || 0);
        const currentDeposited = Number(wallet.total_deposited || 0);

        if (Math.abs(currentAvail - ledgerBalance) > 0.001 || ledgerDeposited > currentDeposited) {
          const reconciledAvail = ledgerBalance;
          const reconciledDeposited = Math.max(currentDeposited, ledgerDeposited);
          await supabase
            .from("wallets")
            .update({
              available_balance: reconciledAvail,
              total_deposited: reconciledDeposited,
              updated_at: new Date().toISOString(),
            })
            .eq("id", wallet.id);

          wallet.available_balance = reconciledAvail;
          wallet.total_deposited = reconciledDeposited;
        }
      }
    }

    return wallet;
  }

  public async getWalletSummary(userId: string): Promise<WalletSummary> {
    if (!isSupabaseAdminConfigured()) {
      throw new Error("Supabase is not configured. Authoritative wallet summary unavailable.");
    }
    if (!userId || !isUuid(userId)) {
      throw new Error(`Invalid user ID for wallet summary: ${userId}`);
    }
    const supabase = this.getClient();
    const wallet = await this.getWallet(userId);

    // Compute locked amount from active investments
    const { data: activeInvs } = await supabase
      .from("investments")
      .select("principal")
      .eq("user_id", userId)
      .eq("status", "active");

    const locked = (activeInvs || []).reduce((acc: number, inv: any) => acc + Number(inv.principal || 0), 0);
    const available = Number(wallet?.available_balance || 0);
    const totalInvested = Number(wallet?.total_invested || 0);
    const totalProfit = Number(wallet?.total_profit || 0);

    return {
      currency: "USDT",
      available_balance: fmt(available),
      locked_investment: fmt(locked),
      total_portfolio: fmt(available + locked),
      total_invested: fmt(totalInvested),
      total_earned: fmt(totalProfit),
    };
  }

  public async creditWallet(params: {
    userId: string;
    amount: number;
    type: string;
    note?: string;
    refType?: string;
    refId?: string;
    createdBy?: string;
    isDeposit?: boolean;
    isProfit?: boolean;
    idempotencyKey?: string;
  }): Promise<any> {
    if (!this.isConfigured() || !params.userId || !isUuid(params.userId)) return null;
    const supabase = this.getClient();

    return transactionLocks.withLock(`user:${params.userId}`, async () => {
      // 1. Idempotency Key Guard
      const cleanIdem = params.idempotencyKey ? String(params.idempotencyKey).trim() : undefined;
      if (cleanIdem) {
        const { data: existingIdemTx } = await supabase
          .from("wallet_transactions")
          .select("id, balance_after")
          .eq("user_id", params.userId)
          .eq("idempotency_key", cleanIdem)
          .eq("status", "completed")
          .maybeSingle();

        if (existingIdemTx) {
          console.warn(`[creditWallet] Transaction already exists with idempotency_key: ${cleanIdem}. Skipping duplicate credit.`);
          return this.getWallet(params.userId);
        }
      }

      // 2. Duplicate transaction protection by reference
      if (params.refType && params.refId) {
        let query = supabase
          .from("wallet_transactions")
          .select("id, balance_after")
          .eq("user_id", params.userId)
          .eq("ref_type", params.refType)
          .eq("ref_id", params.refId)
          .eq("status", "completed");

        if (params.type) {
          query = query.eq("type", params.type);
        }

        const { data: existingTx } = await query.maybeSingle();

        if (existingTx) {
          console.warn(`[creditWallet] Transaction already exists for ${params.refType}:${params.refId} (${params.type}). Skipping duplicate credit.`);
          return this.getWallet(params.userId);
        }
      }

      const creditAmt = Math.abs(Number(params.amount));
      if (creditAmt <= 0) {
        return this.getWallet(params.userId);
      }

      // 3. Optimistic Concurrency Control (OCC) retry loop on wallets table
      let updatedWallet: any = null;
      let newAvail = 0;
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        attempts++;
        const currentWallet = await this.getWallet(params.userId);
        const currentAvail = Number(currentWallet.available_balance || 0);
        newAvail = currentAvail + creditAmt;
        const newDeposited = params.isDeposit ? Number(currentWallet.total_deposited || 0) + creditAmt : Number(currentWallet.total_deposited || 0);
        const newProfit = params.isProfit ? Number(currentWallet.total_profit || 0) + creditAmt : Number(currentWallet.total_profit || 0);

        const { data: uData, error: uErr } = await supabase
          .from("wallets")
          .update({
            available_balance: newAvail,
            total_deposited: newDeposited,
            total_profit: newProfit,
            updated_at: new Date().toISOString(),
          })
          .eq("id", currentWallet.id)
          .eq("available_balance", currentAvail)
          .select()
          .maybeSingle();

        if (!uErr && uData) {
          updatedWallet = uData;
          break;
        }

        if (attempts >= maxAttempts) {
          throw new Error("Failed to credit wallet due to concurrent balance conflict: " + (uErr?.message || "OCC conflict"));
        }
        await new Promise((r) => setTimeout(r, 40));
      }

      // 4. Insert wallet transaction with idempotency key
      const { error: txErr } = await supabase.from("wallet_transactions").insert({
        wallet_id: updatedWallet.id,
        user_id: params.userId,
        type: params.type as any,
        direction: "credit",
        amount: creditAmt,
        balance_after: newAvail,
        ref_type: params.refType || null,
        ref_id: params.refId && params.refId.length === 36 ? params.refId : null,
        status: "completed",
        idempotency_key: cleanIdem || null,
        note: params.note || null,
        created_by: params.createdBy && params.createdBy.length === 36 ? params.createdBy : null,
        created_at: new Date().toISOString(),
      });

      if (txErr) {
        console.warn(`[creditWallet] Warning inserting ledger entry for user ${params.userId}:`, txErr.message);
      }

      return updatedWallet;
    });
  }

  public async debitWallet(params: {
    userId: string;
    amount: number;
    type: string;
    note?: string;
    refType?: string;
    refId?: string;
    createdBy?: string;
    isInvestment?: boolean;
    idempotencyKey?: string;
  }): Promise<any> {
    if (!this.isConfigured() || !params.userId || !isUuid(params.userId)) return null;
    const supabase = this.getClient();

    return transactionLocks.withLock(`user:${params.userId}`, async () => {
      // 1. Idempotency Key Guard
      const cleanIdem = params.idempotencyKey ? String(params.idempotencyKey).trim() : undefined;
      if (cleanIdem) {
        const { data: existingIdemTx } = await supabase
          .from("wallet_transactions")
          .select("id, balance_after")
          .eq("user_id", params.userId)
          .eq("idempotency_key", cleanIdem)
          .eq("status", "completed")
          .maybeSingle();

        if (existingIdemTx) {
          console.warn(`[debitWallet] Transaction already exists with idempotency_key: ${cleanIdem}. Skipping duplicate debit.`);
          return this.getWallet(params.userId);
        }
      }

      // 2. Duplicate transaction protection by reference
      if (params.refType && params.refId) {
        let query = supabase
          .from("wallet_transactions")
          .select("id, balance_after")
          .eq("user_id", params.userId)
          .eq("ref_type", params.refType)
          .eq("ref_id", params.refId)
          .eq("status", "completed");

        if (params.type) {
          query = query.eq("type", params.type);
        }

        const { data: existingTx } = await query.maybeSingle();

        if (existingTx) {
          console.warn(`[debitWallet] Transaction already exists for ${params.refType}:${params.refId} (${params.type}). Skipping duplicate debit.`);
          return this.getWallet(params.userId);
        }
      }

      const debitAmt = Math.abs(Number(params.amount));
      if (debitAmt <= 0) {
        return this.getWallet(params.userId);
      }

      // 3. Optimistic Concurrency Control (OCC) retry loop on wallets table
      let updatedWallet: any = null;
      let newAvail = 0;
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        attempts++;
        const currentWallet = await this.getWallet(params.userId);
        const currentAvail = Number(currentWallet.available_balance || 0);

        if (currentAvail < debitAmt) {
          throw new Error(`Insufficient available balance. Required: $${debitAmt.toFixed(2)}, Available: $${currentAvail.toFixed(2)}`);
        }

        newAvail = currentAvail - debitAmt;
        const newInvested = params.isInvestment ? Number(currentWallet.total_invested || 0) + debitAmt : Number(currentWallet.total_invested || 0);

        const { data: uData, error: uErr } = await supabase
          .from("wallets")
          .update({
            available_balance: newAvail,
            total_invested: newInvested,
            updated_at: new Date().toISOString(),
          })
          .eq("id", currentWallet.id)
          .eq("available_balance", currentAvail)
          .select()
          .maybeSingle();

        if (!uErr && uData) {
          updatedWallet = uData;
          break;
        }

        if (attempts >= maxAttempts) {
          throw new Error("Failed to debit wallet due to concurrent balance conflict: " + (uErr?.message || "OCC conflict"));
        }
        await new Promise((r) => setTimeout(r, 40));
      }

      // 4. Insert wallet transaction with idempotency key
      const { error: txErr } = await supabase.from("wallet_transactions").insert({
        wallet_id: updatedWallet.id,
        user_id: params.userId,
        type: params.type as any,
        direction: "debit",
        amount: debitAmt,
        balance_after: newAvail,
        ref_type: params.refType || null,
        ref_id: params.refId && params.refId.length === 36 ? params.refId : null,
        status: "completed",
        idempotency_key: cleanIdem || null,
        note: params.note || null,
        created_by: params.createdBy && params.createdBy.length === 36 ? params.createdBy : null,
        created_at: new Date().toISOString(),
      });

      if (txErr) {
        console.warn(`[debitWallet] Warning inserting ledger entry for user ${params.userId}:`, txErr.message);
      }

      return updatedWallet;
    });
  }

  public async getTransactions(userId: string, limit: number = 50): Promise<any[]> {
    if (!userId || !isUuid(userId) || !isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("wallet_transactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data.map((t) => ({
      id: t.id,
      user_id: t.user_id,
      type: t.type,
      direction: t.direction,
      amount: fmt(t.amount),
      balance_after: fmt(t.balance_after),
      ref_type: t.ref_type,
      ref_id: t.ref_id,
      status: t.status,
      note: t.note,
      description: t.note,
      created_at: t.created_at,
    }));
  }

  public async getAllTransactions(options?: {
    userId?: string;
    type?: string;
    direction?: string;
    limit?: number;
  }): Promise<any[]> {
    if (!isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    let query = supabase
      .from("wallet_transactions")
      .select("*, profiles:user_id(name, email, phone)")
      .order("created_at", { ascending: false })
      .limit(options?.limit || 300);

    if (options?.userId && isUuid(options.userId)) {
      query = query.eq("user_id", options.userId);
    }
    if (options?.type) {
      query = query.eq("type", options.type);
    }
    if (options?.direction) {
      query = query.eq("direction", options.direction);
    }

    const { data, error } = await query;
    if (error || !data) return [];
    return data.map((t) => {
      const uName = (t as any).profiles?.name || null;
      const uEmail = (t as any).profiles?.email || null;
      const uPhone = (t as any).profiles?.phone || null;
      return {
        id: t.id,
        user_id: t.user_id,
        type: t.type,
        direction: t.direction,
        amount: fmt(t.amount),
        balance_after: fmt(t.balance_after),
        ref_type: t.ref_type,
        ref_id: t.ref_id,
        status: t.status,
        note: t.note,
        description: t.note,
        created_at: t.created_at,
        user: { id: t.user_id, name: uName, email: uEmail, phone: uPhone },
      };
    });
  }

  /* -------------------------------------------------------------------------- */
  /*                         INVESTMENT PLANS & STAKING                         */
  /* -------------------------------------------------------------------------- */

  public async getInvestmentPlans(): Promise<any[]> {
    if (!isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("investment_plans")
      .select("*")
      .order("sort_order", { ascending: true });

    if (error || !data) {
      return [];
    }
    return data;
  }

  public async getInvestmentPlanByKey(key: string): Promise<any | null> {
    if (!key || !isSupabaseAdminConfigured()) return null;
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("investment_plans")
      .select("*")
      .eq("key", key.toLowerCase().trim())
      .maybeSingle();

    if (error) return null;
    return data;
  }

  public async updateInvestmentPlan(params: {
    key: string;
    name?: string;
    price?: number | string;
    profit_percentage?: number | string;
    maturity_percentage?: number | string;
    lock_days?: number;
    is_active?: boolean;
    adminId: string;
    adminEmail?: string;
  }): Promise<any> {
    if (!isSupabaseAdminConfigured()) throw new Error("Supabase is not configured.");
    const supabase = this.getClient();
    const cleanKey = params.key.toLowerCase().trim();

    const { data: existing, error: eErr } = await supabase
      .from("investment_plans")
      .select("*")
      .eq("key", cleanKey)
      .maybeSingle();

    if (eErr || !existing) throw new Error("Plan not found in authoritative database.");

    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };
    if (params.name !== undefined) updates.name = String(params.name).trim();
    if (params.price !== undefined) updates.price = Number(params.price);
    if (params.profit_percentage !== undefined) updates.profit_percentage = Number(params.profit_percentage);
    if (params.maturity_percentage !== undefined) updates.maturity_percentage = Number(params.maturity_percentage);
    if (params.lock_days !== undefined) updates.lock_days = Number(params.lock_days);
    if (params.is_active !== undefined) updates.is_active = Boolean(params.is_active);

    const { data: updated, error: uErr } = await supabase
      .from("investment_plans")
      .update(updates)
      .eq("key", cleanKey)
      .select()
      .single();

    if (uErr) throw new Error("Failed to update plan: " + uErr.message);

    await this.logAudit({
      adminId: params.adminId,
      adminEmail: params.adminEmail || "admin@easyx.trade",
      action: "plan.update",
      targetType: "investment_plan",
      targetId: cleanKey,
      details: { before: existing, updates },
    });

    return updated;
  }

  public async getPlanHistory(planKey: string): Promise<any[]> {
    if (!isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    const { data } = await supabase
      .from("audit_logs")
      .select("*")
      .eq("target_type", "investment_plan")
      .eq("target_id", planKey.toLowerCase().trim())
      .order("created_at", { ascending: false });

    return (data || []).map((log) => ({
      id: log.id,
      plan_key: log.target_id,
      admin_id: log.admin_id,
      admin_email: log.admin_email,
      changes: log.details,
      created_at: log.created_at,
    }));
  }

  public async getPlansState(userId: string): Promise<any[]> {
    if (!isSupabaseAdminConfigured()) return [];
    const plans = await this.getInvestmentPlans();
    const userInvs = await this.getUserInvestments(userId);

    return plans.map((plan: any) => {
      const invsForPlan = userInvs.filter((i: any) => i.plan_key === plan.key || i.plan_id === plan.key);
      const activeInvs = invsForPlan.filter((i: any) => i.status === "active");
      const unlocked = invsForPlan.length > 0;

      const totalInvested = invsForPlan.reduce((acc: number, i: any) => acc + Number(i.principal || i.amount || 0), 0);
      const expectedProfit = activeInvs.reduce((acc: number, i: any) => acc + Number(i.expected_profit || i.profit_amount || 0), 0);
      const expectedMaturity = activeInvs.reduce((acc: number, i: any) => acc + Number(i.expected_payout || i.maturity_amount || 0), 0);
      const nextMaturity = activeInvs.length > 0
        ? activeInvs.map((i: any) => i.maturity_at).filter(Boolean).sort()[0]
        : null;

      const price = Number(plan.min_amount || plan.price || 300);
      const profitPct = Number(plan.profit_percentage || 60);
      const maturityPct = Number(plan.maturity_percentage || 160);
      const profitAmount = (price * profitPct) / 100;
      const maturityAmount = (price * maturityPct) / 100;

      const sortedInvs = [...invsForPlan].sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const sortedActive = sortedInvs.filter((i: any) => i.status === "active");
      const latestInv = sortedActive[0] || sortedInvs[0] || null;

      return {
        key: plan.key,
        name: plan.name,
        display_order: plan.sort_order || plan.display_order || 1,
        price: fmt(price),
        min_amount: fmt(price),
        max_amount: plan.max_amount ? fmt(plan.max_amount) : null,
        lock_days: Number(plan.lock_days || 60),
        profit_percentage: fmt(profitPct),
        maturity_percentage: fmt(maturityPct),
        profit_amount: fmt(profitAmount),
        maturity_amount: fmt(maturityAmount),
        unlocked,
        cards: invsForPlan.length,
        active_investments: activeInvs.length,
        total_invested: fmt(totalInvested),
        expected_profit: fmt(expectedProfit),
        expected_maturity: fmt(expectedMaturity),
        next_maturity: nextMaturity,
        latest_investment: latestInv,
        investments: sortedInvs,
      };
    });
  }

  public async createInvestment(params: {
    userId: string;
    planKey: string;
    amount?: number;
    idempotencyKey?: string;
  }): Promise<any> {
    if (!this.isConfigured() || !isUuid(params.userId)) return null;

    return transactionLocks.withLock(`user:${params.userId}`, async () => {
      const supabase = this.getClient();
      const plan = await this.getInvestmentPlanByKey(params.planKey);
      if (!plan || !plan.is_active) {
        throw new Error("Invalid or inactive investment plan: " + params.planKey);
      }

      const principal = params.amount ? Number(params.amount) : Number(plan.min_amount);
      if (isNaN(principal) || principal < Number(plan.min_amount)) {
        throw new Error(`Minimum investment for ${plan.name} is $${plan.min_amount}`);
      }
      if (plan.max_amount && principal > Number(plan.max_amount)) {
        throw new Error(`Maximum investment for ${plan.name} is $${plan.max_amount}`);
      }

      // Idempotency check: if request was already completed, return existing investment
      const cleanIdem = params.idempotencyKey ? String(params.idempotencyKey).trim() : undefined;
      if (cleanIdem) {
        const { data: existingTx } = await supabase
          .from("wallet_transactions")
          .select("id, ref_id")
          .eq("user_id", params.userId)
          .eq("idempotency_key", cleanIdem)
          .eq("status", "completed")
          .maybeSingle();

        if (existingTx?.ref_id) {
          const { data: existingInv } = await supabase
            .from("investments")
            .select("*")
            .eq("id", existingTx.ref_id)
            .maybeSingle();

          if (existingInv) {
            console.log(`[createInvestment] Idempotent request detected (${cleanIdem}). Returning existing investment ${existingInv.id}`);
            return this.serializeInvestment(existingInv);
          }
        }
      }

      // Check user wallet
      const wallet = await this.getWallet(params.userId);
      if (Number(wallet.available_balance || 0) < principal) {
        throw new Error(`Insufficient wallet balance ($${fmt(wallet.available_balance)}). Required: $${fmt(principal)}.`);
      }

      const profitPercentage = Number(plan.profit_percentage || 60);
      const maturityPercentage = Number(plan.maturity_percentage || 160);
      const expectedProfit = (principal * profitPercentage) / 100;
      const expectedPayout = (principal * maturityPercentage) / 100;
      const lockDays = Number(plan.lock_days || 60);

      const startDate = new Date();
      const maturityDate = new Date(startDate.getTime() + lockDays * 86400000);
      const investmentId = crypto.randomUUID();
      const debitIdemKey = cleanIdem || `inv-purchase:${investmentId}`;

      // 1. Debit user wallet with deterministic pre-generated refId
      await this.debitWallet({
        userId: params.userId,
        amount: principal,
        type: "PLAN_PURCHASE",
        note: `Investment in ${plan.name} (${lockDays} days lockup, ${profitPercentage}% profit)`,
        refType: "investments",
        refId: investmentId,
        idempotencyKey: debitIdemKey,
        isInvestment: true,
      });

      // 2. Insert investment record with the same deterministic ID
      let investment: any = null;
      try {
        const { data: inv, error: iErr } = await supabase
          .from("investments")
          .insert({
            id: investmentId,
            user_id: params.userId,
            plan_key: plan.key,
            plan_name: plan.name,
            principal,
            profit_percentage: profitPercentage,
            maturity_percentage: maturityPercentage,
            expected_profit: expectedProfit,
            expected_payout: expectedPayout,
            lock_days: lockDays,
            start_at: startDate.toISOString(),
            maturity_at: maturityDate.toISOString(),
            status: "active",
            payout_status: "locked",
            created_at: startDate.toISOString(),
            updated_at: startDate.toISOString(),
          })
          .select()
          .single();

        if (iErr || !inv) {
          throw new Error("Failed to create investment record: " + (iErr?.message || "Unknown error"));
        }
        investment = inv;
      } catch (insertErr: any) {
        // Rollback debit atomically if investment insert failed
        console.error(`[createInvestment] Investment insert failed. Rolling back debit for user ${params.userId}:`, insertErr.message);
        try {
          await this.creditWallet({
            userId: params.userId,
            amount: principal,
            type: "ADMIN_ADJUSTMENT",
            note: "Automatic refund for uncommitted investment purchase",
            refType: "investments",
            refId: investmentId,
            idempotencyKey: `inv-rollback:${investmentId}`,
          });
        } catch (rbErr: any) {
          console.error(`[createInvestment] CRITICAL: Failed to rollback debit for investment ${investmentId}:`, rbErr.message);
        }
        throw new Error("Failed to create investment record: " + insertErr.message);
      }

      // 3. Check for direct referral affiliate commission (10%) with deduplication
      try {
        const profile = await this.getProfileById(params.userId);
        if (profile?.referred_by && profile.referred_by !== params.userId) {
          const commissionRate = 10.0; // 10%
          const commissionAmount = Math.round(((principal * commissionRate) / 100) * 100) / 100;

          if (commissionAmount > 0) {
            // Guard against duplicate commission record for this investment
            const { data: existingComm } = await supabase
              .from("referral_commissions")
              .select("id")
              .eq("investment_id", investment.id)
              .maybeSingle();

            if (!existingComm) {
              await supabase.from("referral_commissions").insert({
                referrer_id: profile.referred_by,
                referee_id: params.userId,
                investment_id: investment.id,
                tier_percentage: commissionRate,
                commission_amount: commissionAmount,
                status: "credited",
                created_at: new Date().toISOString(),
              });

              // Credit referrer's wallet with dedicated idempotency key
              await this.creditWallet({
                userId: profile.referred_by,
                amount: commissionAmount,
                type: "REFERRAL_COMMISSION",
                note: `Affiliate referral bonus (${commissionRate}%) from investor plan purchase`,
                refType: "referral_commissions",
                refId: investment.id,
                idempotencyKey: `ref-commission:${investment.id}`,
                isProfit: true,
              });

              // Send notification to referrer
              await this.createNotification({
                userId: profile.referred_by,
                type: "referral",
                channel: "both",
                title: "Referral Commission Earned! 🎉",
                body: `You received a $${commissionAmount.toFixed(2)} USDT commission from your referral's investment.`,
                actionUrl: "/wallet",
                actionText: "View Balance",
              });
            }
          }
        }
      } catch (refErr: any) {
        console.warn("[SupabaseDb] Referral commission processing notice:", refErr.message);
      }

      // 4. Send investment confirmation notification to investor
      await this.createNotification({
        userId: params.userId,
        type: "investment",
        channel: "both",
        title: `Plan Activated: ${plan.name}`,
        body: `Your investment of $${fmt(principal)} USDT is now active. Locked for ${lockDays} days with expected total return of $${fmt(expectedPayout)} USDT.`,
        actionUrl: "/investments",
        actionText: "View Investment",
      });

      return this.serializeInvestment(investment);
    });
  }

  public async getUserInvestments(userId: string, planKey?: string): Promise<any[]> {
    if (!userId || !isUuid(userId) || !isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    let query = supabase
      .from("investments")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (planKey && planKey !== "all") {
      query = query.eq("plan_key", planKey.toLowerCase().trim());
    }

    const { data, error } = await query;
    if (error || !data) return [];
    return data.map((inv) => this.serializeInvestment(inv));
  }

  public async getAllInvestments(options?: { status?: string; query?: string }): Promise<any[]> {
    if (!isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    let query = supabase
      .from("investments")
      .select("*, profiles:user_id(name, email)")
      .order("created_at", { ascending: false });

    if (options?.status && options.status !== "all") {
      query = query.eq("status", options.status.toLowerCase());
    }

    const { data, error } = await query;
    if (error || !data) return [];
    let results = data.map((inv) => {
      const uName = (inv as any).profiles?.name || "Investor";
      const uEmail = (inv as any).profiles?.email || "";
      return {
        ...this.serializeInvestment(inv),
        user_name: uName,
        user_email: uEmail,
        user: { name: uName, email: uEmail },
      };
    });

    if (options?.query) {
      const q = options.query.trim().toLowerCase();
      results = results.filter(
        (i: any) =>
          i.id.toLowerCase().includes(q) ||
          (i.plan_key && i.plan_key.toLowerCase().includes(q)) ||
          (i.user_name && i.user_name.toLowerCase().includes(q)) ||
          (i.user_email && i.user_email.toLowerCase().includes(q))
      );
    }

    return results;
  }

  public async getInvestmentById(id: string): Promise<any | null> {
    if (!id || !isSupabaseAdminConfigured()) return null;
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("investments")
      .select("*, profiles:user_id(name, email)")
      .eq("id", id)
      .maybeSingle();

    if (error || !data) return null;
    const uName = (data as any).profiles?.name || "Investor";
    const uEmail = (data as any).profiles?.email || "";
    return {
      ...this.serializeInvestment(data),
      user_name: uName,
      user_email: uEmail,
      user: { name: uName, email: uEmail },
    };
  }

  public serializeInvestment(inv: any): any {
    const now = Date.now();
    const start = new Date(inv.start_at || inv.created_at).getTime();
    const lockDays = Number(inv.lock_days || 60);
    const maturity = inv.maturity_at ? new Date(inv.maturity_at).getTime() : start + lockDays * 86400000;

    const totalMs = Math.max(1000, maturity - start);
    const elapsedMs = Math.max(0, now - start);
    const remainingMs = Math.max(0, maturity - now);

    const elapsedDays = Math.max(0, Math.floor(elapsedMs / 86400000));
    const remainingDays = inv.status === "matured" ? 0 : Math.max(0, Math.ceil(remainingMs / 86400000));
    const progress = inv.status === "matured" ? 100 : Math.min(100, Math.max(0, Math.round((elapsedMs / totalMs) * 100)));

    const principal = Number(inv.principal || 0);
    const expectedProfit = Number(inv.expected_profit || (principal * Number(inv.profit_percentage || 60)) / 100);
    const expectedPayout = Number(inv.expected_payout || principal + expectedProfit);
    const accruedProfit = inv.status === "matured" ? expectedProfit : Math.round((expectedProfit * (progress / 100)) * 100) / 100;

    return {
      id: inv.id,
      user_id: inv.user_id,
      plan_key: inv.plan_key,
      plan_id: inv.plan_key,
      plan_name: inv.plan_name,
      principal: fmt(principal),
      amount: fmt(principal),
      profit_percentage: Number(inv.profit_percentage || 60),
      maturity_percentage: Number(inv.maturity_percentage || 160),
      expected_profit: fmt(expectedProfit),
      expected_payout: fmt(expectedPayout),
      profit_amount: fmt(expectedProfit),
      maturity_amount: fmt(expectedPayout),
      accrued_profit: fmt(accruedProfit),
      lock_days: lockDays,
      start_at: inv.start_at,
      maturity_at: inv.maturity_at,
      status: inv.status || "active",
      payout_status: inv.payout_status || "locked",
      progress_pct: progress,
      progress_percentage: progress,
      days_elapsed: elapsedDays,
      days_remaining: remainingDays,
      created_at: inv.created_at,
    };
  }

  public async acquireDistributedLock(
    lockKey: string,
    holderId: string,
    ttlMs: number = 90000
  ): Promise<boolean> {
    if (!isSupabaseAdminConfigured()) return false;
    const now = Date.now();
    const lockedUntil = now + ttlMs;

    // 1. Process-level lock lease check
    const localLock = this.inMemoryLocks.get(lockKey);
    if (localLock && localLock.holderId !== holderId && localLock.lockedUntil > now) {
      return false;
    }

    // 2. If Supabase admin service role key is verified, coordinate distributed lock via platform_settings
    if (isAdminKeyVerified()) {
      const supabase = this.getClient();
      try {
        const { data: currentLock, error } = await supabase
          .from("platform_settings")
          .select("value, updated_at")
          .eq("key", lockKey)
          .maybeSingle();

        if (!error && currentLock?.value) {
          const val = currentLock.value as { locked_by?: string; locked_until?: number };
          const remoteUntil = Number(val.locked_until || 0);
          if (val.locked_by && val.locked_by !== holderId && remoteUntil > now) {
            return false;
          }
        }

        const { error: upsertErr } = await supabase
          .from("platform_settings")
          .upsert({
            key: lockKey,
            value: {
              locked_by: holderId,
              locked_until: lockedUntil,
              acquired_at: new Date(now).toISOString(),
              last_heartbeat: new Date(now).toISOString(),
            },
            description: `Distributed lock for ${lockKey}`,
            updated_at: new Date(now).toISOString(),
          });

        if (upsertErr) {
          if (
            upsertErr.message.includes("row-level security policy") ||
            upsertErr.message.includes("permission denied")
          ) {
            // Service key doesn't bypass RLS on platform_settings; gracefully switch to in-process lease lock
            markAdminKeyInvalid(`platform_settings write blocked by RLS (${upsertErr.message})`);
            this.inMemoryLocks.set(lockKey, { holderId, lockedUntil });
            return true;
          }
          console.warn(`[SupabaseDb] Failed to acquire lock ${lockKey}:`, upsertErr.message);
          return false;
        }

        this.inMemoryLocks.set(lockKey, { holderId, lockedUntil });
        return true;
      } catch {
        // Fallback to in-process lock lease
        this.inMemoryLocks.set(lockKey, { holderId, lockedUntil });
        return true;
      }
    }

    // 3. Operating in standard mode: acquire local in-process lease safely
    this.inMemoryLocks.set(lockKey, { holderId, lockedUntil });
    return true;
  }

  public async releaseDistributedLock(lockKey: string, holderId: string): Promise<void> {
    const localLock = this.inMemoryLocks.get(lockKey);
    if (localLock?.holderId === holderId) {
      this.inMemoryLocks.delete(lockKey);
    }

    if (!isSupabaseAdminConfigured() || !isAdminKeyVerified()) return;

    const supabase = this.getClient();
    try {
      const { data: currentLock } = await supabase
        .from("platform_settings")
        .select("value")
        .eq("key", lockKey)
        .maybeSingle();

      if (currentLock?.value?.locked_by === holderId) {
        await supabase
          .from("platform_settings")
          .update({
            value: {
              locked_by: null,
              locked_until: 0,
              released_at: new Date().toISOString(),
            },
            updated_at: new Date().toISOString(),
          })
          .eq("key", lockKey);
      }
    } catch {
      // Non-critical; lock lease TTL will naturally expire
    }
  }

  public async recordSchedulerHeartbeat(
    workerName: string,
    meta: {
      status: "idle" | "running" | "error";
      lastRunAt: string;
      lastDurationMs: number;
      lastMaturedCount: number;
      lastError?: string;
      workerInstanceId: string;
    }
  ): Promise<void> {
    this.inMemorySchedulerStates.set(workerName, {
      ...meta,
      updated_at: new Date().toISOString(),
    });

    if (!isSupabaseAdminConfigured() || !isAdminKeyVerified()) return;

    const supabase = this.getClient();
    try {
      await supabase.from("platform_settings").upsert({
        key: `scheduler_state:${workerName}`,
        value: {
          ...meta,
          updated_at: new Date().toISOString(),
        },
        description: `Autonomous state and telemetry for ${workerName} scheduler`,
        updated_at: new Date().toISOString(),
      });
    } catch {
      // Best-effort telemetry
    }
  }

  public async getSchedulerState(workerName: string): Promise<any | null> {
    if (isSupabaseAdminConfigured() && isAdminKeyVerified()) {
      const supabase = this.getClient();
      try {
        const { data } = await supabase
          .from("platform_settings")
          .select("value")
          .eq("key", `scheduler_state:${workerName}`)
          .maybeSingle();
        if (data?.value) return data.value;
      } catch {
        // Fallback to in-memory state
      }
    }
    return this.inMemorySchedulerStates.get(workerName) || null;
  }

  public async matureInvestment(investmentId: string): Promise<any | null> {
    if (!isSupabaseAdminConfigured()) return null;
    const supabase = this.getClient();

    return transactionLocks.withLock(`maturity:${investmentId}`, async () => {
      const { data: inv, error: fErr } = await supabase
        .from("investments")
        .select("*")
        .eq("id", investmentId)
        .maybeSingle();

      if (fErr || !inv) return null;

      const principal = Number(inv.principal || 0);
      const profitPercentage = Number(inv.profit_percentage || 60);
      const profit = Number(inv.expected_profit || (principal * profitPercentage) / 100);

      // 0. Double-credit guard: Check if maturity ledger transactions already exist for this investment
      const { data: existingPrincipalTx } = await supabase
        .from("wallet_transactions")
        .select("id")
        .eq("ref_type", "investments")
        .eq("ref_id", inv.id)
        .eq("type", "INVESTMENT_MATURITY")
        .eq("status", "completed")
        .maybeSingle();

      let existingProfitTx = null;
      if (profit > 0) {
        const { data: pTx } = await supabase
          .from("wallet_transactions")
          .select("id")
          .eq("ref_type", "investments")
          .eq("ref_id", inv.id)
          .eq("type", "PROFIT")
          .eq("status", "completed")
          .maybeSingle();
        existingProfitTx = pTx;
      }

      const allPaid = Boolean(existingPrincipalTx && (profit <= 0 || existingProfitTx));

      if (allPaid) {
        // Both principal and profit were already credited in prior execution; ensure status is synced to matured
        if (inv.status !== "matured" || (inv.payout_status !== "paid" && inv.payout_status !== "paid_out")) {
          await supabase
            .from("investments")
            .update({
              status: "matured",
              payout_status: "paid_out",
              payout_released_at: new Date().toISOString(),
              matured_at: inv.matured_at || new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", inv.id);
        }
        return this.serializeInvestment({ ...inv, status: "matured", payout_status: "paid_out" });
      }

      if (inv.status !== "active" && inv.payout_status !== "processing") {
        return this.serializeInvestment(inv);
      }

      const nowStr = new Date().toISOString();

      // Multi-instance safe row claim via Optimistic Concurrency Control (OCC)
      if (inv.status === "active") {
        if (inv.payout_status === "processing") {
          const lastUpdatedMs = inv.updated_at ? new Date(inv.updated_at).getTime() : 0;
          const isStale = Date.now() - lastUpdatedMs > 180000; // 3 minutes stale lease
          if (!isStale) {
            // Another live worker is actively processing this investment
            return this.serializeInvestment(inv);
          }
        }

        const { data: lockedInv, error: lockErr } = await supabase
          .from("investments")
          .update({
            payout_status: "processing",
            updated_at: nowStr,
          })
          .eq("id", inv.id)
          .eq("status", "active")
          .eq("updated_at", inv.updated_at)
          .select()
          .maybeSingle();

        if (lockErr || !lockedInv) {
          // Another worker won the race and claimed/updated this investment
          return this.serializeInvestment(inv);
        }
      }

      // 1. Credit principal back to user wallet if not already credited
      if (principal > 0 && !existingPrincipalTx) {
        await this.creditWallet({
          userId: inv.user_id,
          amount: principal,
          type: "INVESTMENT_MATURITY",
          note: `${inv.plan_name} principal returned at maturity`,
          refType: "investments",
          refId: inv.id,
          idempotencyKey: `maturity-principal:${inv.id}`,
        });
      }

      // 2. Credit profit to user wallet if not already credited
      if (profit > 0 && !existingProfitTx) {
        await this.creditWallet({
          userId: inv.user_id,
          amount: profit,
          type: "PROFIT",
          note: `${inv.plan_name} profit credited at maturity`,
          refType: "investments",
          refId: inv.id,
          idempotencyKey: `maturity-profit:${inv.id}`,
          isProfit: true,
        });
      }

      // 3. Mark investment matured and paid_out
      const finalizedTime = new Date().toISOString();
      const { data: finalizedInv } = await supabase
        .from("investments")
        .update({
          status: "matured",
          payout_status: "paid_out",
          payout_released_at: finalizedTime,
          matured_at: inv.matured_at || finalizedTime,
          updated_at: finalizedTime,
        })
        .eq("id", inv.id)
        .select()
        .single();

      // 4. Send user notification
      const total = principal + profit;
      await this.createNotification({
        userId: inv.user_id,
        type: "investment",
        channel: "both",
        title: "Investment Matured! 💰",
        body: `Your ${inv.plan_name} has matured. $${fmt(total)} USDT credited to your wallet (principal $${fmt(principal)} + profit $${fmt(profit)}).`,
        actionUrl: "/wallet",
        actionText: "View Wallet",
      });

      return this.serializeInvestment(
        finalizedInv || {
          ...inv,
          status: "matured",
          payout_status: "paid_out",
          payout_released_at: finalizedTime,
          matured_at: inv.matured_at || finalizedTime,
        }
      );
    });
  }

  public async runMaturitySweep(): Promise<{ matured: number; ran_at: string; matured_ids: string[] }> {
    if (!isSupabaseAdminConfigured()) {
      return { matured: 0, ran_at: new Date().toISOString(), matured_ids: [] };
    }
    const supabase = this.getClient();
    const nowStr = new Date().toISOString();
    const maturedIds: string[] = [];

    // Query all investments that are due for maturity across all users
    const { data: activeList, error } = await supabase
      .from("investments")
      .select("id, status, maturity_at, payout_status, updated_at")
      .eq("status", "active")
      .lte("maturity_at", nowStr)
      .order("maturity_at", { ascending: true });

    if (error) {
      console.error("[SupabaseDb] Error querying matured investments:", error.message);
      throw new Error(`Database error querying matured investments: ${error.message}`);
    }

    if (Array.isArray(activeList) && activeList.length > 0) {
      for (const item of activeList) {
        try {
          const res = await this.matureInvestment(item.id);
          if (res && res.status === "matured") {
            maturedIds.push(item.id);
          }
        } catch (err: any) {
          console.error(`[SupabaseDb] Error maturing investment ${item.id}:`, err?.message);
        }
      }
    }

    return { matured: maturedIds.length, ran_at: nowStr, matured_ids: maturedIds };
  }

  /* -------------------------------------------------------------------------- */
  /*                         DEPOSITS & SUPABASE STORAGE                        */
  /* -------------------------------------------------------------------------- */

  public async uploadDepositProof(
    userId: string,
    fileBuffer: Buffer,
    mimeType: string = "image/jpeg",
    index: number = 1
  ): Promise<string> {
    if (!this.isConfigured()) {
      return "data:" + mimeType + ";base64," + fileBuffer.toString("base64");
    }
    const supabase = this.getClient();
    const ext = mimeType.includes("png") ? "png" : mimeType.includes("pdf") ? "pdf" : "jpg";
    const filePath = `deposits/${userId}/${crypto.randomUUID()}_proof${index}.${ext}`;

    const { data, error } = await supabase.storage
      .from("deposit-proofs")
      .upload(filePath, fileBuffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (error || !data) {
      throw new Error("Failed to upload deposit proof to Supabase Storage: " + (error?.message || "unknown"));
    }

    return filePath;
  }

  public async getDepositProofSignedUrl(storagePath: string): Promise<string> {
    if (!storagePath) return "";
    if (!this.isConfigured() || storagePath.startsWith("data:") || storagePath.startsWith("http://") || storagePath.startsWith("https://")) {
      return storagePath;
    }
    const supabase = this.getClient();
    const { data, error } = await supabase.storage
      .from("deposit-proofs")
      .createSignedUrl(storagePath, 3600); // 1 hour

    return data?.signedUrl || "";
  }

  public async createDeposit(params: {
    userId: string;
    network: "TRC20" | "BEP20" | "ERC20" | "POLYGON";
    amount: number;
    txHash?: string;
    toAddress?: string;
    proofFiles?: Array<{ buffer: Buffer; mimeType: string }>;
    proofImages?: string[]; // base64 strings if uploaded via legacy payload
  }): Promise<any> {
    if (!this.isConfigured()) return null;
    const supabase = this.getClient();
    const storedPaths: string[] = [];

    // Process files if provided as buffers
    if (params.proofFiles && params.proofFiles.length > 0) {
      for (let i = 0; i < params.proofFiles.length; i++) {
        const file = params.proofFiles[i];
        const path = await this.uploadDepositProof(params.userId, file.buffer, file.mimeType, i + 1);
        storedPaths.push(path);
      }
    } else if (params.proofImages && params.proofImages.length > 0) {
      // Process base64 data URLs
      for (let i = 0; i < params.proofImages.length; i++) {
        const raw = params.proofImages[i];
        if (!raw) continue;
        const matches = raw.match(/^data:([^;]+);base64,(.+)$/);
        const mimeType = matches ? matches[1] : "image/jpeg";
        const base64Data = matches ? matches[2] : raw;
        const buffer = Buffer.from(base64Data, "base64");
        const path = await this.uploadDepositProof(params.userId, buffer, mimeType, i + 1);
        storedPaths.push(path);
      }
    }

    const proofFileUrl = storedPaths.join(",");

    const { data: deposit, error } = await supabase
      .from("payment_deposits")
      .insert({
        user_id: params.userId,
        network: params.network,
        amount: Number(params.amount),
        to_address: params.toAddress || "EasyX Vault",
        tx_hash: params.txHash || null,
        proof_file_url: proofFileUrl,
        status: "pending",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error || !deposit) {
      throw new Error("Failed to create deposit record: " + error?.message);
    }

    // Send notification
    await this.createNotification({
      userId: params.userId,
      type: "deposit",
      channel: "both",
      title: "Deposit Submitted for Verification",
      body: `Your deposit of $${fmt(params.amount)} (${params.network}) has been received and is awaiting administrator verification.`,
      actionUrl: "/wallet",
      actionText: "View Wallet",
    });

    return this.serializeDeposit(deposit);
  }

  public async getUserDeposits(userId: string): Promise<any[]> {
    if (!userId || !isUuid(userId) || !isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("payment_deposits")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error || !data) return [];
    const results = [];
    for (const d of data) {
      results.push(await this.serializeDeposit(d));
    }
    return results;
  }

  public async getAllDeposits(status?: string): Promise<any[]> {
    if (!isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    let query = supabase
      .from("payment_deposits")
      .select("*, profiles:user_id(name, email)")
      .order("created_at", { ascending: false });

    if (status && status !== "all") {
      query = query.eq("status", status.toLowerCase());
    }

    const { data, error } = await query;
    if (error || !data) return [];
    const results = [];
    for (const d of data) {
      const serialized = await this.serializeDeposit(d);
      const uName = (d as any).profiles?.name || "Investor";
      const uEmail = (d as any).profiles?.email || "";
      results.push({
        ...serialized,
        user_name: uName,
        user_email: uEmail,
        user: { name: uName, email: uEmail },
      });
    }
    return results;
  }

  public async serializeDeposit(dep: any): Promise<any> {
    const paths = (dep.proof_file_url || "").split(",").map((s: string) => s.trim()).filter(Boolean);
    const proofEndpoints: string[] = [];
    const proofSignedUrls: string[] = [];
    for (let i = 0; i < paths.length; i++) {
      if (dep.id) {
        proofEndpoints.push(`/api/deposits/proof/${dep.id}?index=${i}`);
      }
      const signed = await this.getDepositProofSignedUrl(paths[i]);
      if (signed) proofSignedUrls.push(signed);
    }

    const proofList = proofEndpoints.length > 0 ? proofEndpoints : proofSignedUrls;

    return {
      id: dep.id,
      user_id: dep.user_id,
      network: dep.network,
      amount: fmt(dep.amount),
      approved_amount: dep.approved_amount ? fmt(dep.approved_amount) : null,
      to_address: dep.to_address,
      tx_hash: dep.tx_hash,
      proof_images: proofList,
      proof_signed_urls: proofSignedUrls,
      proof_file_url: proofList[0] || null,
      status: dep.status,
      admin_note: dep.admin_note,
      decided_by: dep.decided_by,
      decided_at: dep.decided_at,
      created_at: dep.created_at,
      updated_at: dep.updated_at,
    };
  }

  public async adminDecideDeposit(params: {
    depositId: string;
    action?: "approve" | "reject";
    decision?: "approve" | "reject";
    adminId: string;
    adminEmail?: string;
    note?: string;
    adminNote?: string;
    approvedAmount?: number;
  }): Promise<any> {
    if (!isSupabaseAdminConfigured()) return null;
    const supabase = this.getClient();

    const { data: dep, error: fErr } = await supabase
      .from("payment_deposits")
      .select("*")
      .eq("id", params.depositId)
      .single();

    if (fErr || !dep) {
      throw new Error("Deposit record not found: " + params.depositId);
    }

    const lockKeys = [`deposit:${params.depositId}`, `user:${dep.user_id}`];
    return transactionLocks.withLock(lockKeys, async () => {
      // Re-fetch under lock to guarantee fresh status
      const { data: freshDep } = await supabase
        .from("payment_deposits")
        .select("*")
        .eq("id", params.depositId)
        .single();

      const currentDep = freshDep || dep;
      if (currentDep.status !== "pending") {
        throw new Error(`Deposit has already been decided. Current status: ${currentDep.status}.`);
      }

      const nowStr = new Date().toISOString();
      const finalDecision = params.decision || params.action || "approve";
      const finalNote = params.adminNote || params.note || (finalDecision === "approve" ? "Approved by administrator" : "Rejected by administrator");

      if (finalDecision === "approve") {
        const finalAmount = params.approvedAmount ? Number(params.approvedAmount) : Number(currentDep.amount);
        if (isNaN(finalAmount) || finalAmount <= 0) {
          throw new Error("Invalid deposit approved amount: " + params.approvedAmount);
        }

        // 1. Atomic compare-and-swap transition from pending -> approved
        const { data: updatedDep, error: uErr } = await supabase
          .from("payment_deposits")
          .update({
            status: "approved",
            approved_amount: finalAmount,
            admin_note: finalNote,
            decided_by: params.adminId.length === 36 ? params.adminId : null,
            decided_at: nowStr,
            updated_at: nowStr,
          })
          .eq("id", params.depositId)
          .eq("status", "pending")
          .select()
          .maybeSingle();

        if (uErr || !updatedDep) {
          throw new Error("Deposit has already been processed or is not in pending status.");
        }

        // 2. Credit user's wallet with dedicated idempotency key
        try {
          await this.creditWallet({
            userId: currentDep.user_id,
            amount: finalAmount,
            type: "DEPOSIT",
            note: `Deposit approved via ${currentDep.network}. Amount: $${finalAmount.toFixed(2)} USDT`,
            refType: "payment_deposits",
            refId: currentDep.id,
            idempotencyKey: `deposit-approve:${currentDep.id}`,
            createdBy: params.adminId,
            isDeposit: true,
          });
        } catch (credErr: any) {
          // Compensate: Revert deposit status back to pending so it can be safely reviewed/retried
          console.error(`[adminDecideDeposit] Credit failed for deposit ${currentDep.id}. Reverting deposit status to pending:`, credErr.message);
          await supabase
            .from("payment_deposits")
            .update({
              status: "pending",
              approved_amount: null,
              admin_note: `Credit failed, reverted to pending: ${credErr.message}`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", params.depositId);

          throw new Error("Failed to credit wallet for deposit. Status reverted to pending: " + credErr.message);
        }

        // 3. Send notification
        await this.createNotification({
          userId: currentDep.user_id,
          type: "deposit",
          channel: "both",
          title: "Deposit Approved! 💰",
          body: `Your deposit of $${fmt(finalAmount)} USDT has been verified and added to your available balance.`,
          actionUrl: "/wallet",
          actionText: "View Wallet",
        });

        // 4. Audit log
        await this.logAudit({
          adminId: params.adminId,
          adminEmail: params.adminEmail || "admin@easyx.trade",
          action: "APPROVE_DEPOSIT",
          entityType: "payment_deposits",
          entityId: currentDep.id,
          amount: finalAmount,
          reason: params.note || "Verified transaction proof",
          meta: { network: currentDep.network, tx_hash: currentDep.tx_hash },
        });

        return this.serializeDeposit(updatedDep);
      } else {
        // Reject
        const { data: updatedDep, error: uErr } = await supabase
          .from("payment_deposits")
          .update({
            status: "rejected",
            admin_note: finalNote,
            decided_by: params.adminId.length === 36 ? params.adminId : null,
            decided_at: nowStr,
            updated_at: nowStr,
          })
          .eq("id", params.depositId)
          .eq("status", "pending")
          .select()
          .maybeSingle();

        if (uErr || !updatedDep) {
          throw new Error("Deposit has already been processed or is not in pending status.");
        }

        await this.createNotification({
          userId: currentDep.user_id,
          type: "deposit",
          channel: "both",
          title: "Deposit Rejected",
          body: `Your deposit request for $${fmt(currentDep.amount)} USDT was rejected. Reason: ${finalNote}`,
          actionUrl: "/wallet",
          actionText: "View Wallet",
        });

        await this.logAudit({
          adminId: params.adminId,
          adminEmail: params.adminEmail || "admin@easyx.trade",
          action: "REJECT_DEPOSIT",
          entityType: "payment_deposits",
          entityId: currentDep.id,
          amount: Number(currentDep.amount),
          reason: finalNote,
        });

        return this.serializeDeposit(updatedDep);
      }
    });
  }

  /* -------------------------------------------------------------------------- */
  /*                               WITHDRAWALS                                  */
  /* -------------------------------------------------------------------------- */

  public async createWithdrawal(params: {
    userId: string;
    amount: number;
    network: "TRC20" | "BEP20" | "ERC20" | "POLYGON";
    destinationAddress: string;
    idempotencyKey?: string;
  }): Promise<any> {
    if (!this.isConfigured() || !isUuid(params.userId)) return null;

    return transactionLocks.withLock(`user:${params.userId}`, async () => {
      const supabase = this.getClient();
      const withdrawAmt = Number(params.amount);
      if (isNaN(withdrawAmt) || withdrawAmt < 100) {
        throw new Error("Minimum withdrawal amount is 100.00 USDT.");
      }

      // 1. Idempotency check: Return existing withdrawal if this request was already processed
      const cleanIdem = params.idempotencyKey ? String(params.idempotencyKey).trim() : undefined;
      if (cleanIdem) {
        const { data: existingTx } = await supabase
          .from("wallet_transactions")
          .select("id, ref_id")
          .eq("user_id", params.userId)
          .eq("idempotency_key", cleanIdem)
          .eq("status", "completed")
          .maybeSingle();

        if (existingTx?.ref_id) {
          const { data: existingW } = await supabase
            .from("withdrawals")
            .select("*")
            .eq("id", existingTx.ref_id)
            .maybeSingle();

          if (existingW) {
            console.log(`[createWithdrawal] Idempotent request detected (${cleanIdem}). Returning existing withdrawal ${existingW.id}`);
            return this.serializeWithdrawal(existingW);
          }
        }
      }

      // 2. Verify KYC approved
      const profile = await this.getProfileById(params.userId);
      if (!profile || profile.kyc_status !== "approved") {
        throw new Error("KYC verification is required before initiating withdrawals. Please complete KYC.");
      }

      // 3. Put funds on escrow hold using OCC retry loop on wallets table
      const withdrawalId = crypto.randomUUID();
      const holdIdemKey = cleanIdem || `withdrawal-hold:${withdrawalId}`;

      let attempts = 0;
      const maxAttempts = 3;
      let newAvail = 0;
      let walletId = "";

      while (attempts < maxAttempts) {
        attempts++;
        const wallet = await this.getWallet(params.userId);
        walletId = wallet.id;
        const available = Number(wallet.available_balance || 0);

        if (available < withdrawAmt) {
          throw new Error(`Insufficient available balance ($${fmt(available)}). Required: $${fmt(withdrawAmt)}.`);
        }

        newAvail = available - withdrawAmt;
        const newPending = Number(wallet.pending_withdrawal || 0) + withdrawAmt;

        const { data: uData, error: uErr } = await supabase
          .from("wallets")
          .update({
            available_balance: newAvail,
            pending_withdrawal: newPending,
            updated_at: new Date().toISOString(),
          })
          .eq("id", wallet.id)
          .eq("available_balance", available)
          .select()
          .maybeSingle();

        if (!uErr && uData) {
          break;
        }

        if (attempts >= maxAttempts) {
          throw new Error("Failed to place funds on hold due to concurrent wallet activity. Please retry.");
        }
        await new Promise((r) => setTimeout(r, 40));
      }

      // 4. Create withdrawal record
      const nowStr = new Date().toISOString();
      const { data: withdrawal, error } = await supabase
        .from("withdrawals")
        .insert({
          id: withdrawalId,
          user_id: params.userId,
          amount: withdrawAmt,
          fee: 0,
          net_amount: withdrawAmt,
          network: params.network,
          destination_address: params.destinationAddress.trim(),
          status: "pending",
          created_at: nowStr,
          updated_at: nowStr,
        })
        .select()
        .single();

      if (error || !withdrawal) {
        // Rollback wallet hold atomically
        console.error(`[createWithdrawal] Insert failed. Reverting hold for user ${params.userId}:`, error?.message);
        try {
          const freshW = await this.getWallet(params.userId);
          await supabase
            .from("wallets")
            .update({
              available_balance: Number(freshW.available_balance || 0) + withdrawAmt,
              pending_withdrawal: Math.max(0, Number(freshW.pending_withdrawal || 0) - withdrawAmt),
              updated_at: new Date().toISOString(),
            })
            .eq("id", freshW.id);
        } catch (rbErr: any) {
          console.error("[createWithdrawal] CRITICAL: Failed to rollback escrow hold:", rbErr?.message);
        }
        throw new Error("Failed to create withdrawal request: " + error?.message);
      }

      // 5. Ledger record with idempotency key
      await supabase.from("wallet_transactions").insert({
        wallet_id: walletId,
        user_id: params.userId,
        type: "WITHDRAWAL_REQUEST",
        direction: "hold",
        amount: withdrawAmt,
        balance_after: newAvail,
        ref_type: "withdrawals",
        ref_id: withdrawal.id,
        idempotency_key: holdIdemKey,
        status: "completed",
        note: `Withdrawal request placed (${params.network} to ${params.destinationAddress.slice(0, 8)}...)`,
        created_at: nowStr,
      });

      // 6. User notification
      await this.createNotification({
        userId: params.userId,
        type: "withdrawal",
        channel: "both",
        title: "Withdrawal Request Queued",
        body: `Your withdrawal of $${fmt(withdrawAmt)} USDT (${params.network}) has been submitted and is processing.`,
        actionUrl: "/wallet",
        actionText: "View Status",
      });

      return this.serializeWithdrawal(withdrawal);
    });
  }

  public async getUserWithdrawals(userId: string): Promise<any[]> {
    if (!userId || !isUuid(userId) || !isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("withdrawals")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error || !data) return [];
    return data.map((w) => this.serializeWithdrawal(w));
  }

  public async getAllWithdrawals(status?: string): Promise<any[]> {
    if (!isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    let query = supabase
      .from("withdrawals")
      .select("*, profiles:user_id(name, email)")
      .order("created_at", { ascending: false });

    if (status && status !== "all") {
      query = query.eq("status", status.toLowerCase());
    }

    const { data, error } = await query;
    if (error || !data) return [];
    return data.map((w) => {
      const uName = (w as any).profiles?.name || "Investor";
      const uEmail = (w as any).profiles?.email || "";
      return {
        ...this.serializeWithdrawal(w),
        user_name: uName,
        user_email: uEmail,
        user: { name: uName, email: uEmail },
      };
    });
  }

  public async getWithdrawalById(id: string): Promise<any | null> {
    if (!id || !isSupabaseAdminConfigured()) return null;
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("withdrawals")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error || !data) return null;
    return this.serializeWithdrawal(data);
  }

  public serializeWithdrawal(w: any): any {
    return {
      id: w.id,
      user_id: w.user_id,
      amount: fmt(w.amount),
      fee: fmt(w.fee),
      net_amount: fmt(w.net_amount),
      network: w.network,
      to_address: w.destination_address,
      destination_address: w.destination_address,
      status: w.status,
      tx_hash: w.payout_tx_hash || null,
      payout_tx_hash: w.payout_tx_hash || null,
      rejection_reason: w.rejection_reason || null,
      processed_by: w.processed_by,
      decided_at: w.decided_at,
      completed_at: w.completed_at,
      created_at: w.created_at,
      updated_at: w.updated_at,
    };
  }

  public async adminProcessWithdrawal(params: {
    withdrawalId: string;
    action: "complete" | "reject" | "approve" | "processing";
    adminId: string;
    adminEmail?: string;
    txHash?: string;
    reason?: string;
    adminNote?: string;
  }): Promise<any> {
    if (!isSupabaseAdminConfigured()) return null;
    const supabase = this.getClient();
    const { data: w, error: fErr } = await supabase
      .from("withdrawals")
      .select("*")
      .eq("id", params.withdrawalId)
      .single();

    if (fErr || !w) throw new Error("Withdrawal record not found: " + params.withdrawalId);

    const lockKeys = [`withdrawal:${params.withdrawalId}`, `user:${w.user_id}`];
    return transactionLocks.withLock(lockKeys, async () => {
      // Re-fetch under lock to guarantee fresh status
      const { data: freshW } = await supabase
        .from("withdrawals")
        .select("*")
        .eq("id", params.withdrawalId)
        .single();

      const currentW = freshW || w;
      const amount = Number(currentW.amount);
      const nowStr = new Date().toISOString();

      if (params.action === "approve") {
        if (currentW.status !== "pending") {
          throw new Error(`Only pending withdrawals can be approved. Current status: ${currentW.status}`);
        }

        const { data: updatedW, error: uErr } = await supabase
          .from("withdrawals")
          .update({
            status: "approved",
            processed_by: params.adminId.length === 36 ? params.adminId : null,
            admin_note: params.reason || params.adminNote || null,
            decided_at: nowStr,
            updated_at: nowStr,
          })
          .eq("id", params.withdrawalId)
          .eq("status", "pending")
          .select()
          .maybeSingle();

        if (uErr || !updatedW) throw new Error("Withdrawal is not pending or was already decided.");
        return this.serializeWithdrawal(updatedW);
      }

      if (params.action === "processing") {
        if (!["approved", "pending"].includes(currentW.status)) {
          throw new Error(`Only pending or approved withdrawals can be set to processing. Current status: ${currentW.status}`);
        }

        const { data: updatedW, error: uErr } = await supabase
          .from("withdrawals")
          .update({
            status: "processing",
            processed_by: params.adminId.length === 36 ? params.adminId : null,
            admin_note: params.reason || params.adminNote || null,
            updated_at: nowStr,
          })
          .eq("id", params.withdrawalId)
          .in("status", ["approved", "pending"])
          .select()
          .maybeSingle();

        if (uErr || !updatedW) throw new Error("Withdrawal is not pending/approved or was already decided.");
        return this.serializeWithdrawal(updatedW);
      }

      if (params.action === "complete") {
        if (!["pending", "approved", "processing"].includes(currentW.status)) {
          throw new Error(`Withdrawal is not eligible for completion. Current status: ${currentW.status}`);
        }

        // 1. Atomic compare-and-swap status transition
        const { data: updatedW, error: uErr } = await supabase
          .from("withdrawals")
          .update({
            status: "completed",
            payout_tx_hash: params.txHash || ("0x" + crypto.randomBytes(24).toString("hex")),
            processed_by: params.adminId.length === 36 ? params.adminId : null,
            decided_at: currentW.decided_at || nowStr,
            completed_at: nowStr,
            updated_at: nowStr,
          })
          .eq("id", params.withdrawalId)
          .in("status", ["pending", "approved", "processing"])
          .select()
          .maybeSingle();

        if (uErr || !updatedW) throw new Error("Withdrawal has already been finalized or processed.");

        // 2. Update wallet: release from pending_withdrawal and increment total_withdrawn
        const wallet = await this.getWallet(currentW.user_id);
        const newPending = Math.max(0, Number(wallet.pending_withdrawal || 0) - amount);
        const newWithdrawn = Number(wallet.total_withdrawn || 0) + amount;

        await supabase
          .from("wallets")
          .update({
            pending_withdrawal: newPending,
            total_withdrawn: newWithdrawn,
            updated_at: nowStr,
          })
          .eq("id", wallet.id);

        // 3. Ledger record with idempotency key
        await supabase.from("wallet_transactions").insert({
          wallet_id: wallet.id,
          user_id: currentW.user_id,
          type: "WITHDRAWAL_APPROVED",
          direction: "debit",
          amount,
          balance_after: Number(wallet.available_balance || 0),
          ref_type: "withdrawals",
          ref_id: currentW.id,
          idempotency_key: `withdrawal-complete:${currentW.id}`,
          status: "completed",
          note: `Withdrawal broadcast on-chain (${currentW.network}). Tx: ${params.txHash || "Confirmed"}`,
          created_by: params.adminId.length === 36 ? params.adminId : null,
          created_at: nowStr,
        });

        // 4. Notification
        await this.createNotification({
          userId: currentW.user_id,
          type: "withdrawal",
          channel: "both",
          title: "Withdrawal Sent! 🚀",
          body: `Your withdrawal of $${fmt(amount)} USDT (${currentW.network}) has been broadcast to your address.`,
          actionUrl: "/wallet",
          actionText: "View Details",
        });

        // 5. Audit
        await this.logAudit({
          adminId: params.adminId,
          adminEmail: params.adminEmail || "admin@easyx.trade",
          action: "COMPLETE_WITHDRAWAL",
          entityType: "withdrawals",
          entityId: currentW.id,
          amount,
          reason: "On-chain payout confirmed",
          meta: { tx_hash: params.txHash },
        });

        return this.serializeWithdrawal(updatedW);
      } else {
        // Reject: Return held funds to available_balance
        if (!["pending", "approved", "processing"].includes(currentW.status)) {
          throw new Error(`Withdrawal cannot be rejected. Current status: ${currentW.status}`);
        }

        // 1. Atomic compare-and-swap status transition
        const { data: updatedW, error: uErr } = await supabase
          .from("withdrawals")
          .update({
            status: "rejected",
            rejection_reason: params.reason || params.adminNote || "Rejected by administrator",
            processed_by: params.adminId.length === 36 ? params.adminId : null,
            decided_at: nowStr,
            updated_at: nowStr,
          })
          .eq("id", params.withdrawalId)
          .in("status", ["pending", "approved", "processing"])
          .select()
          .maybeSingle();

        if (uErr || !updatedW) throw new Error("Withdrawal has already been finalized or rejected.");

        // 2. Return funds to available balance
        const wallet = await this.getWallet(currentW.user_id);
        const newAvail = Number(wallet.available_balance || 0) + amount;
        const newPending = Math.max(0, Number(wallet.pending_withdrawal || 0) - amount);

        await supabase
          .from("wallets")
          .update({
            available_balance: newAvail,
            pending_withdrawal: newPending,
            updated_at: nowStr,
          })
          .eq("id", wallet.id);

        // 3. Ledger release with idempotency key
        await supabase.from("wallet_transactions").insert({
          wallet_id: wallet.id,
          user_id: currentW.user_id,
          type: "WITHDRAWAL_REJECTED",
          direction: "release",
          amount,
          balance_after: newAvail,
          ref_type: "withdrawals",
          ref_id: currentW.id,
          idempotency_key: `withdrawal-reject:${currentW.id}`,
          status: "completed",
          note: `Withdrawal held funds returned: ${params.reason || params.adminNote || "Compliance check"}`,
          created_by: params.adminId.length === 36 ? params.adminId : null,
          created_at: nowStr,
        });

        await this.createNotification({
          userId: currentW.user_id,
          type: "withdrawal",
          channel: "both",
          title: "Withdrawal Returned to Balance",
          body: `Your withdrawal request for $${fmt(amount)} USDT was rejected and returned to your available balance. Reason: ${params.reason || params.adminNote || "Verification error"}`,
          actionUrl: "/wallet",
          actionText: "View Wallet",
        });

        await this.logAudit({
          adminId: params.adminId,
          adminEmail: params.adminEmail || "admin@easyx.trade",
          action: "REJECT_WITHDRAWAL",
          entityType: "withdrawals",
          entityId: currentW.id,
          amount,
          reason: params.reason || params.adminNote || "Failed verification check",
        });

        return this.serializeWithdrawal(updatedW);
      }
    });
  }

  /* -------------------------------------------------------------------------- */
  /*                            KYC & SUPABASE STORAGE                          */
  /* -------------------------------------------------------------------------- */

  public async ensurePrivateKycBuckets(): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const supabase = this.getClient();
      const { data: buckets } = await supabase.storage.listBuckets();
      const bucketNames = ["kyc-documents", "kyc-selfies"] as const;
      for (const bName of bucketNames) {
        const found = buckets?.find((b: any) => b.name === bName || b.id === bName);
        if (!found) {
          await supabase.storage.createBucket(bName, { public: false });
        } else if (found.public) {
          await supabase.storage.updateBucket(bName, { public: false });
        }
      }
    } catch (e: any) {
      // Buckets may already be defined via SQL migration
    }
  }

  public async uploadKycDocument(userId: string, buffer: Buffer, mimeType: string, prefix: string): Promise<string> {
    if (!this.isConfigured()) {
      return "data:" + mimeType + ";base64," + buffer.toString("base64");
    }
    const supabase = this.getClient();
    const ext = mimeType.includes("png") ? "png" : mimeType.includes("pdf") ? "pdf" : "jpg";
    const bucket = prefix === "selfie" ? "kyc-selfies" : "kyc-documents";
    const filePath = `${prefix}/${userId}/${crypto.randomUUID()}.${ext}`;

    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(filePath, buffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (error || !data) {
      throw new Error(`Failed to upload ${prefix} to bucket ${bucket}: ` + error?.message);
    }

    return filePath;
  }

  public async getKycSignedUrl(bucket: "kyc-documents" | "kyc-selfies", path: string): Promise<string> {
    if (!path) return "";
    if (!this.isConfigured() || path.startsWith("data:") || path.startsWith("http://") || path.startsWith("https://")) return path;

    const supabase = this.getClient();
    const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
    return data?.signedUrl || "";
  }

  public async submitKyc(params: {
    userId: string;
    idType: string;
    idNumber: string;
    permanentAddress: string;
    frontBuffer?: Buffer;
    frontMime?: string;
    backBuffer?: Buffer;
    backMime?: string;
    selfieBuffer?: Buffer;
    selfieMime?: string;
  }): Promise<any> {
    if (!this.isConfigured()) return null;
    const supabase = this.getClient();

    // 1. Upload files
    let frontPath = null;
    let backPath = null;
    let selfiePath = null;

    if (params.frontBuffer) {
      frontPath = await this.uploadKycDocument(params.userId, params.frontBuffer, params.frontMime || "image/jpeg", "front");
    }
    if (params.backBuffer) {
      backPath = await this.uploadKycDocument(params.userId, params.backBuffer, params.backMime || "image/jpeg", "back");
    }
    if (params.selfieBuffer) {
      selfiePath = await this.uploadKycDocument(params.userId, params.selfieBuffer, params.selfieMime || "image/jpeg", "selfie");
    }

    const rawId = String(params.idNumber || "").trim();
    const maskedId = rawId.length > 4 ? "*".repeat(Math.max(0, rawId.length - 4)) + rawId.slice(-4) : rawId;

    // 2. Insert KYC record
    const { data: kyc, error: kErr } = await supabase
      .from("kyc_records")
      .insert({
        user_id: params.userId,
        country: "IN",
        id_type: params.idType.toLowerCase() as any,
        id_number: rawId,
        id_number_masked: maskedId,
        permanent_address: params.permanentAddress,
        id_front_storage_path: frontPath,
        id_back_storage_path: backPath,
        selfie_storage_path: selfiePath,
        status: "pending",
        submitted_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (kErr || !kyc) {
      throw new Error("Failed to insert KYC record: " + kErr?.message);
    }

    // 3. Update user profile
    await supabase
      .from("profiles")
      .update({
        kyc_status: "pending",
        id_number_masked: maskedId,
        permanent_address: params.permanentAddress,
        address: params.permanentAddress,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.userId);

    // 4. Notification
    await this.createNotification({
      userId: params.userId,
      type: "kyc",
      channel: "both",
      title: "KYC Documents Under Review",
      body: "Your identity verification details and permanent residential address proof have been submitted for compliance review.",
      actionUrl: "/kyc",
      actionText: "Check Status",
    });

    return this.serializeKyc(kyc);
  }

  public async getUserKyc(userId: string): Promise<any | null> {
    if (!userId || !isUuid(userId) || !isSupabaseAdminConfigured()) return null;
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("kyc_records")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;
    return this.serializeKyc(data);
  }

  public async getAllKyc(status?: string): Promise<any[]> {
    if (!isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    let query = supabase
      .from("kyc_records")
      .select("*, profiles:user_id(name, email, phone)")
      .order("created_at", { ascending: false });

    if (status && status !== "all") {
      query = query.eq("status", status.toLowerCase());
    }

    const { data, error } = await query;
    if (error || !data) return [];
    const results = [];
    for (const k of data) {
      const serialized = await this.serializeKyc(k);
      const uName = (k as any).profiles?.name || "Investor";
      const uEmail = (k as any).profiles?.email || "";
      const uPhone = (k as any).profiles?.phone || "";
      results.push({
        ...serialized,
        user_name: uName,
        user_email: uEmail,
        user_phone: uPhone,
        user: { name: uName, email: uEmail, phone: uPhone },
      });
    }
    return results;
  }

  public async serializeKyc(k: any): Promise<any> {
    const frontUrl = k.id_front_storage_path
      ? await this.getKycSignedUrl("kyc-documents", k.id_front_storage_path)
      : null;
    const backUrl = k.id_back_storage_path
      ? await this.getKycSignedUrl("kyc-documents", k.id_back_storage_path)
      : null;
    const selfieUrl = k.selfie_storage_path
      ? await this.getKycSignedUrl("kyc-selfies", k.selfie_storage_path)
      : null;

    const documents = [];
    if (k.id_front_storage_path) {
      documents.push({
        id: `sb:${k.id}:front`,
        doc_type: "id_front",
        storage_path: k.id_front_storage_path,
        mime: k.id_front_storage_path.endsWith(".pdf") ? "application/pdf" : "image/jpeg",
        url: frontUrl,
      });
    }
    if (k.id_back_storage_path) {
      documents.push({
        id: `sb:${k.id}:back`,
        doc_type: "id_back",
        storage_path: k.id_back_storage_path,
        mime: k.id_back_storage_path.endsWith(".pdf") ? "application/pdf" : "image/jpeg",
        url: backUrl,
      });
    }
    if (k.selfie_storage_path) {
      documents.push({
        id: `sb:${k.id}:selfie`,
        doc_type: "selfie",
        storage_path: k.selfie_storage_path,
        mime: "image/jpeg",
        url: selfieUrl,
      });
    }

    return {
      id: k.id,
      user_id: k.user_id,
      country: k.country || "IN",
      id_type: k.id_type,
      id_number: k.id_number || k.id_number_masked,
      id_number_masked: k.id_number_masked,
      permanent_address: k.permanent_address,
      address: k.permanent_address,
      front_document_url: frontUrl,
      back_document_url: backUrl,
      id_document_url: frontUrl,
      selfie_url: selfieUrl,
      documents,
      status: k.status,
      reject_reason: k.reject_reason || null,
      decided_by: k.decided_by,
      decided_at: k.decided_at,
      submitted_at: k.submitted_at || k.created_at,
      created_at: k.created_at,
      updated_at: k.updated_at,
    };
  }

  /**
   * Authoritative sync of local KYC documents into private Supabase Storage buckets
   * Ensures that Supabase Storage is the permanent, authoritative source of truth.
   */
  public async syncLocalKycDocumentsToStorage(kycDocsMap: Map<string, any> | Record<string, any>): Promise<number> {
    if (!this.isConfigured()) return 0;
    const supabase = this.getClient();
    let synced = 0;
    const docs = kycDocsMap instanceof Map ? Array.from(kycDocsMap.values()) : Object.values(kycDocsMap || {});

    for (const doc of docs) {
      if (!doc || !doc.id) continue;
      const rawData = doc.data;
      if (!rawData) continue;

      const buffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData, "base64");
      if (!buffer || buffer.length === 0) continue;

      const bucket = doc.doc_type === "selfie" ? "kyc-selfies" : "kyc-documents";
      const ext = doc.mime?.includes("png") ? "png" : doc.mime?.includes("pdf") ? "pdf" : "jpg";
      const path = `documents/${doc.id}.${ext}`;

      try {
        const { data, error } = await supabase.storage.from(bucket).upload(path, buffer, {
          contentType: doc.mime || "image/jpeg",
          upsert: true,
        });
        if (!error && data) {
          synced++;
        }
      } catch (err: any) {
        console.warn(`[SupabaseStorage] Sync local doc ${doc.id} warning:`, err?.message);
      }
    }
    return synced;
  }

  /**
   * Retrieves and streams a private KYC document buffer directly from Supabase Storage
   * Authoritative source: Supabase Storage private buckets 'kyc-documents' and 'kyc-selfies'
   */
  public async getKycDocumentStream(
    docRefId: string,
    adminUser: boolean,
    requestingUserId?: string
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    if (!this.isConfigured() || !docRefId) return null;
    const supabase = this.getClient();

    let bucket: "kyc-documents" | "kyc-selfies" = "kyc-documents";
    let storagePath = "";
    let userId = "";

    let cleanId = String(docRefId).trim();
    try {
      cleanId = decodeURIComponent(cleanId);
    } catch {
      // keep raw string if decode fails
    }

    if (cleanId.startsWith("sb:")) {
      const parts = cleanId.split(":");
      const kycId = parts[1];
      const type = parts[2] || "front";

      const { data: rec, error } = await supabase
        .from("kyc_records")
        .select("*")
        .eq("id", kycId)
        .maybeSingle();

      if (error || !rec) return null;
      userId = rec.user_id;

      if (type === "selfie") {
        bucket = "kyc-selfies";
        storagePath = rec.selfie_storage_path;
      } else if (type === "back") {
        bucket = "kyc-documents";
        storagePath = rec.id_back_storage_path;
      } else {
        bucket = "kyc-documents";
        storagePath = rec.id_front_storage_path;
      }
    } else if (cleanId.includes("/")) {
      // Direct storage path: front/..., back/..., selfie/..., documents/...
      bucket = cleanId.includes("selfie") ? "kyc-selfies" : "kyc-documents";
      storagePath = cleanId;
    } else {
      // 1. Check if cleanId matches a KYC record ID or user ID in Supabase
      const { data: rec } = await supabase
        .from("kyc_records")
        .select("*")
        .or(`id.eq.${cleanId},user_id.eq.${cleanId}`)
        .maybeSingle();

      if (rec) {
        userId = rec.user_id;
        bucket = "kyc-documents";
        storagePath = rec.id_front_storage_path || rec.selfie_storage_path;
      } else {
        // 2. Authoritative retrieval directly from Supabase Storage private buckets under candidate folders
        const candidateFolders = ["documents", "front", "back", "selfie", ""];
        const candidateExtensions = ["jpg", "png", "pdf", "webp", "jpeg"];
        for (const b of ["kyc-documents", "kyc-selfies"] as const) {
          for (const folder of candidateFolders) {
            for (const ext of candidateExtensions) {
              const testPath = folder ? `${folder}/${cleanId}.${ext}` : `${cleanId}.${ext}`;
              const { data: blob, error: dlErr } = await supabase.storage.from(b).download(testPath);
              if (!dlErr && blob) {
                const arrayBuffer = await blob.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const contentType = blob.type || (ext === "pdf" ? "application/pdf" : `image/${ext === "jpg" ? "jpeg" : ext}`);
                return { buffer, contentType };
              }
            }
            const testPathNoExt = folder ? `${folder}/${cleanId}` : cleanId;
            const { data: blobNoExt, error: dlNoExtErr } = await supabase.storage.from(b).download(testPathNoExt);
            if (!dlNoExtErr && blobNoExt) {
              const arrayBuffer = await blobNoExt.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              const contentType = blobNoExt.type || "image/jpeg";
              return { buffer, contentType };
            }
          }
        }
      }
    }

    if (!storagePath) return null;

    // Authorization check (admin authorization checked server-side)
    if (!adminUser && userId && userId !== requestingUserId) {
      throw new Error("Unauthorized to access this KYC document");
    }

    const { data: blob, error: dlErr } = await supabase.storage
      .from(bucket)
      .download(storagePath);

    if (dlErr || !blob) {
      console.error(`[SupabaseStorage] Download failed for ${bucket}/${storagePath}:`, dlErr?.message);
      return null;
    }

    const arrayBuffer = await blob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = blob.type || (storagePath.endsWith(".pdf") ? "application/pdf" : "image/jpeg");

    return { buffer, contentType };
  }

  public async adminReviewKyc(params: {
    kycId?: string;
    kycIdOrUserId?: string;
    action?: "approve" | "reject";
    decision?: "approve" | "reject";
    adminId: string;
    adminEmail?: string;
    reason?: string;
    rejectReason?: string;
  }): Promise<any> {
    if (!isSupabaseAdminConfigured()) return null;
    const supabase = this.getClient();
    const idToLookup = params.kycId || params.kycIdOrUserId;
    if (!idToLookup) throw new Error("No KYC ID or User ID provided");

    let { data: kyc, error: fErr } = await supabase
      .from("kyc_records")
      .select("*")
      .or(`id.eq.${idToLookup},user_id.eq.${idToLookup}`)
      .limit(1)
      .maybeSingle();

    if (fErr || !kyc) throw new Error("KYC record not found: " + idToLookup);
    const nowStr = new Date().toISOString();
    const decisionAction = params.decision || params.action || "approve";
    const newStatus = decisionAction === "approve" ? "approved" : "rejected";
    const finalReason = params.rejectReason || params.reason || "Documentation unclear";

    // 1. Update KYC record
    const { data: updatedKyc, error: uErr } = await supabase
      .from("kyc_records")
      .update({
        status: newStatus,
        reject_reason: newStatus === "rejected" ? finalReason : null,
        decided_by: params.adminId.length === 36 ? params.adminId : null,
        decided_at: nowStr,
        updated_at: nowStr,
      })
      .eq("id", kyc.id)
      .select()
      .single();

    if (uErr) throw new Error("Failed to update KYC status: " + uErr.message);

    // 2. Update user's profile
    await supabase
      .from("profiles")
      .update({
        kyc_status: newStatus,
        updated_at: nowStr,
      })
      .eq("id", kyc.user_id);

    // 3. User notification
    await this.createNotification({
      userId: kyc.user_id,
      type: "kyc",
      channel: "both",
      title: params.action === "approve" ? "KYC Approved! ✅" : "KYC Rejected ⚠️",
      body: params.action === "approve"
        ? "Your identity verification is approved. Full account features and withdrawals are now unlocked."
        : `Your KYC verification was not approved. Reason: ${params.reason || "Document details could not be validated."}`,
      actionUrl: "/kyc",
      actionText: "View KYC",
    });

    // 4. Audit log
    await this.logAudit({
      adminId: params.adminId,
      adminEmail: params.adminEmail || "admin@easyx.trade",
      action: params.action === "approve" ? "APPROVE_KYC" : "REJECT_KYC",
      entityType: "kyc_records",
      entityId: kyc.id,
      reason: params.reason || `KYC status marked ${newStatus}`,
    });

    return this.serializeKyc(updatedKyc);
  }

  public async updateKycAdminDetails(params: {
    kycIdOrUserId: string;
    name?: string;
    id_type?: string;
    id_number?: string;
    address?: string;
    permanent_address?: string;
    status?: string;
    admin_note?: string;
    adminId: string;
    adminEmail?: string;
  }): Promise<any> {
    if (!isSupabaseAdminConfigured()) throw new Error("Supabase is not configured.");
    const supabase = this.getClient();
    const idToLookup = params.kycIdOrUserId;

    let { data: kyc } = await supabase
      .from("kyc_records")
      .select("*")
      .or(`id.eq.${idToLookup},user_id.eq.${idToLookup}`)
      .limit(1)
      .maybeSingle();

    const targetUserId = kyc?.user_id || (isUuid(idToLookup) ? idToLookup : null);
    if (!targetUserId) throw new Error("User or KYC record not found.");

    const nowStr = new Date().toISOString();
    const changes: Record<string, any> = {};

    const profileUpdates: Record<string, any> = { updated_at: nowStr };
    if (params.name && params.name.trim()) {
      profileUpdates.name = params.name.trim();
      changes.name = params.name.trim();
    }
    const targetAddr = params.permanent_address || params.address;
    if (targetAddr && targetAddr.trim()) {
      profileUpdates.address = targetAddr.trim();
      profileUpdates.permanent_address = targetAddr.trim();
      changes.address = targetAddr.trim();
    }
    if (params.status) {
      profileUpdates.kyc_status = params.status;
      changes.status = params.status;
    }

    await supabase.from("profiles").update(profileUpdates).eq("id", targetUserId);

    const kycUpdates: Record<string, any> = {
      updated_at: nowStr,
      admin_note: params.admin_note || null,
      decided_by: params.adminId && params.adminId.length === 36 ? params.adminId : null,
    };
    if (params.status) {
      kycUpdates.status = params.status;
      if (params.status === "approved") {
        kycUpdates.decided_at = nowStr;
      }
    }
    if (params.id_type) {
      kycUpdates.id_type = params.id_type.toLowerCase();
      changes.id_type = params.id_type.toLowerCase();
    }
    if (params.id_number && params.id_number.trim()) {
      kycUpdates.id_number = params.id_number.trim();
      changes.id_number = params.id_number.trim();
    }
    if (targetAddr) {
      kycUpdates.address = targetAddr.trim();
    }

    let savedKyc: any;
    if (kyc) {
      const { data } = await supabase.from("kyc_records").update(kycUpdates).eq("id", kyc.id).select().single();
      savedKyc = data;
    } else {
      const { data } = await supabase.from("kyc_records").insert({
        user_id: targetUserId,
        ...kycUpdates,
        status: params.status || "approved",
        submitted_at: nowStr,
        created_at: nowStr,
      }).select().single();
      savedKyc = data;
    }

    await this.logAudit({
      adminId: params.adminId,
      adminEmail: params.adminEmail || "admin@easyx.trade",
      action: "kyc.admin_update",
      targetType: "kyc_record",
      targetId: savedKyc?.id || targetUserId,
      details: { changes, note: params.admin_note },
    });

    const { data: updatedProfile } = await supabase.from("profiles").select("*").eq("id", targetUserId).single();

    return {
      ok: true,
      record: savedKyc ? this.serializeKyc(savedKyc) : null,
      user: updatedProfile ? this.serializeUser(updatedProfile) : null,
      changes,
    };
  }

  public async setKycStatus(params: {
    kycIdOrUserId: string;
    status: string;
    adminId: string;
    adminEmail?: string;
  }): Promise<any> {
    if (!isSupabaseAdminConfigured()) return null;
    const supabase = this.getClient();
    const idToLookup = params.kycIdOrUserId;

    const { data: kyc } = await supabase
      .from("kyc_records")
      .select("*")
      .or(`id.eq.${idToLookup},user_id.eq.${idToLookup}`)
      .limit(1)
      .maybeSingle();

    if (!kyc) throw new Error("KYC record not found: " + idToLookup);
    const nowStr = new Date().toISOString();

    await supabase
      .from("kyc_records")
      .update({
        status: params.status,
        reject_reason: null,
        decided_by: null,
        decided_at: null,
        updated_at: nowStr,
      })
      .eq("id", kyc.id);

    await supabase
      .from("profiles")
      .update({
        kyc_status: params.status,
        updated_at: nowStr,
      })
      .eq("id", kyc.user_id);

    return true;
  }

  /* -------------------------------------------------------------------------- */
  /*                                 REFERRALS                                  */
  /* -------------------------------------------------------------------------- */

  public async getReferralSummary(userId: string): Promise<any> {
    if (!userId || !isUuid(userId) || !isSupabaseAdminConfigured()) {
      return {
        referral_code: "EX000000",
        referral_link: "https://easyx.trade/register?ref=EX000000",
        commission_rate: 10,
        total_commission: "0.00",
        total_commissions: "0.00",
        total_earned: "0.00",
        referees_count: 0,
        active_referrals: 0,
        direct_referrals: [],
      };
    }
    const supabase = this.getClient();
    const profile = await this.getProfileById(userId);

    // Get referees
    const { data: referees } = await supabase
      .from("profiles")
      .select("id, name, email, created_at, kyc_status")
      .eq("referred_by", userId)
      .order("created_at", { ascending: false });

    // Get commissions
    const { data: commissions } = await supabase
      .from("referral_commissions")
      .select("*, referee:referee_id(name, email)")
      .eq("referrer_id", userId)
      .order("created_at", { ascending: false });

    const totalCommissions = (commissions || []).reduce(
      (acc: number, c: any) => acc + Number(c.commission_amount || 0),
      0
    );

    const refCode = profile?.referral_code || "EX" + userId.slice(0, 6).toUpperCase();

    return {
      referral_code: refCode,
      referral_link: `https://easyx.trade/register?ref=${refCode}`,
      commission_rate: 10,
      total_commission: fmt(totalCommissions),
      total_commissions: fmt(totalCommissions),
      total_earned: fmt(totalCommissions),
      referees_count: referees?.length || 0,
      active_referrals: referees?.length || 0,
      direct_referrals: (referees || []).map((r: any) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        joined_at: r.created_at,
        created_at: r.created_at,
        kyc_status: r.kyc_status,
      })),
      commissions_history: (commissions || []).map((c: any) => ({
        id: c.id,
        referee_id: c.referee_id,
        referee_name: c.referee?.name || "Referral",
        investment_id: c.investment_id,
        commission_amount: fmt(c.commission_amount),
        tier_percentage: c.tier_percentage,
        status: c.status,
        created_at: c.created_at,
      })),
    };
  }

  public async getAllReferralsAdmin(): Promise<any> {
    if (!isSupabaseAdminConfigured()) return { stats: {}, relationships: [], commissions: [] };
    const supabase = this.getClient();
    const [
      { data: referrals },
      { data: commissions },
      { data: profiles },
    ] = await Promise.all([
      supabase.from("referrals").select("*, referrer:referrer_id(id, name, email), referee:referee_id(id, name, email)").order("created_at", { ascending: false }),
      supabase.from("referral_commissions").select("*, referrer:referrer_id(id, name, email), referee:referee_id(id, name, email)").order("created_at", { ascending: false }),
      supabase.from("profiles").select("id, name, email, referred_by, created_at"),
    ]);

    const profMap = new Map<string, any>();
    for (const p of profiles || []) profMap.set(p.id, p);

    let relationships: any[] = [];
    if (referrals && referrals.length > 0) {
      relationships = referrals.map((r: any) => ({
        referrer: r.referrer || { id: r.referrer_id, name: profMap.get(r.referrer_id)?.name, email: profMap.get(r.referrer_id)?.email },
        referee: r.referee || { id: r.referee_id, name: profMap.get(r.referee_id)?.name, email: profMap.get(r.referee_id)?.email },
        joined_at: r.created_at,
      }));
    } else {
      for (const p of profiles || []) {
        if (p.referred_by && profMap.has(p.referred_by)) {
          const ref = profMap.get(p.referred_by);
          relationships.push({
            referrer: { id: ref.id, name: ref.name, email: ref.email },
            referee: { id: p.id, name: p.name, email: p.email },
            joined_at: p.created_at,
          });
        }
      }
    }

    const commsList = (commissions || []).map((c: any) => ({
      id: c.id,
      referrer: c.referrer || { id: c.referrer_id, name: profMap.get(c.referrer_id)?.name, email: profMap.get(c.referrer_id)?.email },
      referee: c.referee || { id: c.referee_id, name: profMap.get(c.referee_id)?.name, email: profMap.get(c.referee_id)?.email },
      investment_id: c.investment_id,
      plan_key: c.plan_key,
      amount: fmt(c.amount),
      percentage: fmt(c.percentage || c.tier_percentage || 10),
      status: c.status,
      created_at: c.created_at,
    }));

    const totalPaid = commsList
      .filter((c: any) => c.status === "paid")
      .reduce((sum: number, c: any) => sum + Number(c.amount), 0);

    return {
      stats: {
        total_relationships: relationships.length,
        total_referrers: new Set(relationships.map((r: any) => r.referrer?.id).filter(Boolean)).size,
        total_commissions: commsList.length,
        total_commissions_paid: commsList.filter((c: any) => c.status === "paid").length,
        total_commission_amount: fmt(totalPaid),
      },
      relationships,
      commissions: commsList,
    };
  }

  /* -------------------------------------------------------------------------- */
  /*                               NOTIFICATIONS                                */
  /* -------------------------------------------------------------------------- */

  public async getUserNotifications(userId: string, unreadOnly: boolean = false): Promise<any[]> {
    if (!userId || !isUuid(userId) || !isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    let query = supabase
      .from("notifications")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(60);

    if (unreadOnly) {
      query = query.eq("is_read", false);
    }

    const { data, error } = await query;
    if (error || !data) return [];
    return data.map((n) => ({
      id: n.id,
      user_id: n.user_id,
      title: n.title,
      body: n.body,
      message: n.body,
      type: n.type,
      channel: n.channel,
      action_url: n.action_url,
      action_text: n.action_text,
      is_read: Boolean(n.is_read),
      read_at: n.read_at,
      created_at: n.created_at,
    }));
  }

  public async getUnreadNotificationCount(userId: string): Promise<number> {
    if (!userId || !isUuid(userId) || !isSupabaseAdminConfigured()) return 0;
    const supabase = this.getClient();
    const { count, error } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_read", false);

    if (error) return 0;
    return count || 0;
  }

  public async createNotification(params: {
    userId: string;
    title: string;
    body?: string;
    message?: string;
    type?: string;
    channel?: "in_app" | "push" | "both";
    actionUrl?: string;
    actionText?: string;
    senderAdmin?: string;
  }): Promise<any> {
    if (!isSupabaseAdminConfigured()) return null;
    const supabase = this.getClient();
    const bodyContent = params.body || params.message || params.title;
    const { data, error } = await supabase
      .from("notifications")
      .insert({
        user_id: params.userId,
        title: params.title,
        body: bodyContent,
        type: params.type || "system",
        channel: params.channel || "both",
        action_url: params.actionUrl || null,
        action_text: params.actionText || null,
        sender_admin: params.senderAdmin || null,
        is_read: false,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      console.warn("[SupabaseDb] Notification insert notice:", error.message);
    }
    return data;
  }

  public async markNotificationRead(id: string, userId: string): Promise<void> {
    if (!isSupabaseAdminConfigured()) return;
    const supabase = this.getClient();
    await supabase
      .from("notifications")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId);
  }

  public async markAllNotificationsRead(userId: string): Promise<void> {
    if (!isSupabaseAdminConfigured()) return;
    const supabase = this.getClient();
    await supabase
      .from("notifications")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("is_read", false);
  }

  /* -------------------------------------------------------------------------- */
  /*                                AUDIT LOGS                                  */
  /* -------------------------------------------------------------------------- */

  public async logAudit(params: {
    adminId?: string;
    adminEmail: string;
    action: string;
    entityType?: string;
    entityId?: string;
    targetType?: string;
    targetId?: string;
    amount?: number;
    reason?: string;
    details?: any;
    meta?: any;
  }): Promise<void> {
    if (!isSupabaseAdminConfigured()) return;
    try {
      const supabase = this.getClient();
      await supabase.from("audit_logs").insert({
        admin_id: params.adminId && params.adminId.length === 36 ? params.adminId : null,
        admin_email: params.adminEmail,
        action: params.action,
        entity_type: params.entityType || params.targetType || "system",
        entity_id: params.entityId || params.targetId || "unknown",
        amount: params.amount != null ? Number(params.amount) : null,
        reason: params.reason || null,
        meta: params.meta || params.details || {},
        created_at: new Date().toISOString(),
      });
    } catch (err: any) {
      console.warn("[SupabaseDb] Audit log notice:", err.message);
    }
  }

  public serializeUser(u: any): CleanUserProfile {
    return this.formatProfile(u);
  }

  public serializeTransaction(t: any): any {
    return {
      id: t.id,
      user_id: t.user_id,
      type: t.type,
      direction: t.direction,
      amount: fmt(t.amount),
      balance_after: fmt(t.balance_after),
      ref_type: t.ref_type,
      ref_id: t.ref_id,
      status: t.status,
      note: t.note,
      description: t.note,
      created_at: t.created_at,
    };
  }

  public async getAuditLogs(limit: number = 100): Promise<any[]> {
    if (!isSupabaseAdminConfigured()) return [];
    const supabase = this.getClient();
    const { data, error } = await supabase
      .from("audit_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data;
  }

  /* -------------------------------------------------------------------------- */
  /*                             PLATFORM SETTINGS                              */
  /* -------------------------------------------------------------------------- */

  public async getPlatformSettings(): Promise<Record<string, any>> {
    if (!isSupabaseAdminConfigured()) return {};
    const supabase = this.getClient();
    const { data, error } = await supabase.from("platform_settings").select("*");
    if (error || !data) return {};

    const map: Record<string, any> = {};
    for (const row of data) {
      map[row.key] = row.value;
    }
    return map;
  }

  public async updatePlatformSetting(key: string, value: any, adminId?: string): Promise<void> {
    if (!isSupabaseAdminConfigured() || !isAdminKeyVerified()) return;
    const supabase = this.getClient();
    try {
      await supabase.from("platform_settings").upsert(
        {
          key,
          value,
          updated_by: adminId && adminId.length === 36 ? adminId : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      );
    } catch {
      // Safe catch
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                  ADMIN FINANCIAL & STATISTICAL OPERATIONS                  */
  /* -------------------------------------------------------------------------- */

  public async cancelInvestment(params: {
    investmentId: string;
    adminId: string;
    adminEmail?: string;
    refundAmount: number;
    reason?: string;
  }): Promise<any> {
    if (!isSupabaseAdminConfigured()) return null;
    const supabase = this.getClient();
    const { data: inv, error } = await supabase
      .from("investments")
      .select("*")
      .eq("id", params.investmentId)
      .single();

    if (error || !inv) throw new Error("Investment not found: " + params.investmentId);
    if (inv.status !== "active") throw new Error(`Only active investments can be cancelled. Current status: ${inv.status}`);

    const lockKeys = [`investment:${params.investmentId}`, `user:${inv.user_id}`];
    return transactionLocks.withLock(lockKeys, async () => {
      const nowStr = new Date().toISOString();
      const refundAmt = Number(params.refundAmount || 0);

      const { data: updatedInv, error: uErr } = await supabase
        .from("investments")
        .update({
          status: "cancelled",
          cancelled_at: nowStr,
          cancelled_by: params.adminId && params.adminId.length === 36 ? params.adminId : null,
          cancel_reason: params.reason || "Cancelled by administrator",
          refund_amount: refundAmt,
          updated_at: nowStr,
        })
        .eq("id", params.investmentId)
        .eq("status", "active")
        .select()
        .single();

      if (uErr || !updatedInv) throw new Error("Failed to cancel investment in database.");

      if (refundAmt > 0) {
        await this.creditWallet({
          userId: inv.user_id,
          amount: refundAmt,
          type: "REFUND",
          refType: "investments",
          refId: inv.id,
          idempotencyKey: `invest-cancel-refund:${inv.id}`,
          note: `Investment cancelled — ${fmt(refundAmt)} USDT refunded`,
          createdBy: params.adminId,
        });
      }

      await this.createNotification({
        userId: inv.user_id,
        type: "investment",
        channel: "both",
        title: "Investment Cancelled",
        body: `Your investment in ${inv.plan_name} was cancelled.${refundAmt > 0 ? ` $${fmt(refundAmt)} USDT refunded to your wallet.` : ""}`,
        actionUrl: "/wallet",
        actionText: "View Wallet",
      });

      await this.logAudit({
        adminId: params.adminId,
        adminEmail: params.adminEmail || "admin@easyx.trade",
        action: "CANCEL_INVESTMENT",
        entityType: "investments",
        entityId: inv.id,
        amount: refundAmt,
        reason: params.reason || "Cancelled by administrator",
      });

      return this.serializeInvestment(updatedInv);
    });
  }

  public async getAdminOverview(): Promise<any> {
    if (!isSupabaseAdminConfigured()) throw new Error("Supabase is not configured.");
    const supabase = this.getClient();

    const [
      { count: totalUsers },
      { count: activeUsers },
      { count: suspendedUsers },
      { data: investments },
      { data: deposits },
      { data: withdrawals },
      { count: kycPending },
      { data: wallets },
      { data: commissions },
    ] = await Promise.all([
      supabase.from("profiles").select("*", { count: "exact", head: true }).neq("role", "admin"),
      supabase.from("profiles").select("*", { count: "exact", head: true }).neq("role", "admin").eq("status", "active"),
      supabase.from("profiles").select("*", { count: "exact", head: true }).neq("role", "admin").eq("status", "suspended"),
      supabase.from("investments").select("status, principal, maturity_at"),
      supabase.from("payment_deposits").select("status, amount, approved_amount"),
      supabase.from("withdrawals").select("status, amount"),
      supabase.from("kyc_records").select("*", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("wallets").select("available_balance"),
      supabase.from("referral_commissions").select("amount, status"),
    ]);

    const nowMs = Date.now();
    const sevenDaysMs = 7 * 86400 * 1000;
    const invList = investments || [];
    const invActive = invList.filter((i: any) => i.status === "active").length;
    const invMatured = invList.filter((i: any) => i.status === "matured").length;
    const invCancelled = invList.filter((i: any) => i.status === "cancelled").length;
    const invMaturingSoon = invList.filter((i: any) => {
      if (i.status !== "active" || !i.maturity_at) return false;
      const diff = new Date(i.maturity_at).getTime() - nowMs;
      return diff > 0 && diff <= sevenDaysMs;
    }).length;
    const activePrincipal = invList
      .filter((i: any) => i.status === "active")
      .reduce((sum: number, i: any) => sum + Number(i.principal || 0), 0);

    const depList = deposits || [];
    const depPending = depList.filter((d: any) => d.status === "pending").length;
    const depApprovedTotal = depList
      .filter((d: any) => d.status === "approved")
      .reduce((sum: number, d: any) => sum + Number(d.approved_amount || d.amount || 0), 0);
    const depTotal = depList.reduce((sum: number, d: any) => sum + Number(d.amount || 0), 0);

    const wdList = withdrawals || [];
    const wdPending = wdList.filter((w: any) => w.status === "pending").length;
    const wdApproved = wdList.filter((w: any) => w.status === "approved").length;
    const wdPaidTotal = wdList
      .filter((w: any) => w.status === "completed" || w.status === "paid")
      .reduce((sum: number, w: any) => sum + Number(w.amount || 0), 0);
    const wdTotal = wdList.reduce((sum: number, w: any) => sum + Number(w.amount || 0), 0);

    const availableTotal = (wallets || []).reduce(
      (sum: number, w: any) => sum + Number(w.available_balance || 0),
      0
    );
    const liabilities = availableTotal + activePrincipal;

    const commsPaid = (commissions || [])
      .filter((c: any) => c.status === "paid")
      .reduce((sum: number, c: any) => sum + Number(c.amount || 0), 0);

    return {
      users: { total: totalUsers || 0, active: activeUsers || 0, suspended: suspendedUsers || 0 },
      investments: {
        active: invActive,
        matured: invMatured,
        cancelled: invCancelled,
        maturing_soon: invMaturingSoon,
        active_principal: fmt(activePrincipal),
      },
      deposits: { pending: depPending, approved_total: fmt(depApprovedTotal), total: fmt(depTotal) },
      withdrawals: { pending: wdPending, approved: wdApproved, paid_total: fmt(wdPaidTotal), total: fmt(wdTotal) },
      kyc: { pending: kycPending || 0 },
      wallet: {
        available_total: fmt(availableTotal),
        locked_total: fmt(activePrincipal),
        liabilities: fmt(liabilities),
      },
      referrals: { commissions_paid: fmt(commsPaid) },
    };
  }

  public async getAdminUsers(options?: { status?: string; query?: string }): Promise<any> {
    if (!isSupabaseAdminConfigured()) throw new Error("Supabase is not configured.");
    const supabase = this.getClient();

    const [
      { data: profiles, error: pErr },
      { data: wallets },
      { data: investments },
      { data: referrals },
      { data: commissions },
    ] = await Promise.all([
      supabase.from("profiles").select("*").order("created_at", { ascending: false }),
      supabase.from("wallets").select("*"),
      supabase.from("investments").select("id, user_id, principal, status"),
      supabase.from("referrals").select("referrer_id, referee_id"),
      supabase.from("referral_commissions").select("referrer_id, amount, status"),
    ]);

    if (pErr || !profiles) throw new Error("Failed to fetch user profiles: " + pErr?.message);

    const walletMap = new Map<string, any>();
    for (const w of wallets || []) walletMap.set(w.user_id, w);

    const invMap = new Map<string, any[]>();
    for (const i of investments || []) {
      const list = invMap.get(i.user_id) || [];
      list.push(i);
      invMap.set(i.user_id, list);
    }

    const refMap = new Map<string, number>();
    for (const r of referrals || []) {
      refMap.set(r.referrer_id, (refMap.get(r.referrer_id) || 0) + 1);
    }

    const commMap = new Map<string, number>();
    for (const c of commissions || []) {
      if (c.status === "paid") {
        commMap.set(c.referrer_id, (commMap.get(c.referrer_id) || 0) + Number(c.amount || 0));
      }
    }

    let list = profiles.map((p) => {
      const userClean = this.formatProfile(p);
      const wallet = walletMap.get(p.id) || {
        currency: "USDT",
        available_balance: 0,
        total_invested: 0,
        total_profit: 0,
      };
      const invs = invMap.get(p.id) || [];
      const activeInvs = invs.filter((i) => i.status === "active");
      const activePrincipal = activeInvs.reduce((sum, i) => sum + Number(i.principal || 0), 0);
      const directReferrals = refMap.get(p.id) || 0;
      const commsEarned = commMap.get(p.id) || 0;

      return {
        ...userClean,
        kyc_status: p.kyc_status || "none",
        wallet: {
          currency: wallet.currency || "USDT",
          available_balance: fmt(wallet.available_balance),
          locked_investment: fmt(activePrincipal),
          total_invested: fmt(wallet.total_invested),
          total_earned: fmt(wallet.total_profit || wallet.total_earned || 0),
        },
        investments: {
          total: invs.length,
          active: activeInvs.length,
          active_principal: fmt(activePrincipal),
          matured: invs.filter((i) => i.status === "matured").length,
        },
        referrals: {
          total_referred: directReferrals,
          commission_earned: fmt(commsEarned),
        },
      };
    });

    if (options?.status && options.status !== "all") {
      list = list.filter((u) => u.status === options.status);
    }

    if (options?.query) {
      const rx = options.query.trim().toLowerCase();
      list = list.filter(
        (u) =>
          (u.name && u.name.toLowerCase().includes(rx)) ||
          (u.email && u.email.toLowerCase().includes(rx)) ||
          (u.phone && u.phone.toLowerCase().includes(rx)) ||
          (u.referral_code && u.referral_code.toLowerCase().includes(rx)) ||
          (u.id && u.id.toLowerCase().includes(rx)) ||
          (u.kyc_status && u.kyc_status.toLowerCase().includes(rx))
      );
    }

    return { total: list.length, users: list };
  }

  public async getAdminUserById(userId: string): Promise<any> {
    if (!isSupabaseAdminConfigured()) throw new Error("Supabase is not configured.");
    const supabase = this.getClient();

    const [
      { data: profile, error: pErr },
      { data: wallet },
      { data: investments },
      { data: referrals },
      { data: commissions },
    ] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", userId).single(),
      supabase.from("wallets").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("investments").select("id, principal, status").eq("user_id", userId),
      supabase.from("referrals").select("referee_id").eq("referrer_id", userId),
      supabase.from("referral_commissions").select("amount, status").eq("referrer_id", userId),
    ]);

    if (pErr || !profile) return null;

    const userClean = this.formatProfile(profile);
    const w = wallet || { currency: "USDT", available_balance: 0, total_invested: 0, total_profit: 0 };
    const invs = investments || [];
    const activeInvs = invs.filter((i) => i.status === "active");
    const activePrincipal = activeInvs.reduce((sum, i) => sum + Number(i.principal || 0), 0);
    const directReferrals = (referrals || []).length;
    const commsEarned = (commissions || [])
      .filter((c) => c.status === "paid")
      .reduce((sum, c) => sum + Number(c.amount || 0), 0);

    return {
      ...userClean,
      kyc_status: profile.kyc_status || "none",
      wallet: {
        currency: w.currency || "USDT",
        available_balance: fmt(w.available_balance),
        locked_investment: fmt(activePrincipal),
        total_invested: fmt(w.total_invested),
        total_earned: fmt(w.total_profit || w.total_earned || 0),
      },
      investments: {
        total: invs.length,
        active: activeInvs.length,
        active_principal: fmt(activePrincipal),
        matured: invs.filter((i) => i.status === "matured").length,
      },
      referrals: {
        total_referred: directReferrals,
        commission_earned: fmt(commsEarned),
      },
    };
  }

  public async adminAdjustWallet(params: {
    userId: string;
    amount: number;
    direction: "credit" | "debit";
    adminId: string;
    adminEmail?: string;
    reason: string;
    idempotencyKey?: string;
  }): Promise<any> {
    if (!isSupabaseAdminConfigured()) throw new Error("Supabase is not configured.");
    const supabase = this.getClient();

    const { data: profile } = await supabase
      .from("profiles")
      .select("id, name, email")
      .eq("id", params.userId)
      .single();

    if (!profile) {
      throw new Error("Target user not found in authoritative database.");
    }

    const amt = Math.abs(Number(params.amount));
    if (isNaN(amt) || amt <= 0) {
      throw new Error("Adjustment amount must be greater than 0.");
    }

    const currentWallet = await this.getWallet(params.userId);
    const curBal = Number(currentWallet?.available_balance || 0);

    if (params.direction === "debit" && curBal < amt) {
      const err: any = new Error(`Insufficient balance. User only has $${fmt(curBal)} USDT available, cannot debit $${fmt(amt)} USDT.`);
      err.status = 422;
      err.current_balance = fmt(curBal);
      err.requested_debit = fmt(amt);
      throw err;
    }

    const finalIdempotencyKey = params.idempotencyKey || `admin_adj_${params.userId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    let updatedWallet: any;
    if (params.direction === "credit") {
      updatedWallet = await this.creditWallet({
        userId: params.userId,
        amount: amt,
        type: "ADMIN_ADJUSTMENT",
        refType: "admin_adjustment",
        refId: params.adminId && params.adminId.length === 36 ? params.adminId : undefined,
        createdBy: params.adminId && params.adminId.length === 36 ? params.adminId : undefined,
        idempotencyKey: finalIdempotencyKey,
        note: params.reason,
      });
    } else {
      updatedWallet = await this.debitWallet({
        userId: params.userId,
        amount: amt,
        type: "ADMIN_ADJUSTMENT",
        refType: "admin_adjustment",
        refId: params.adminId && params.adminId.length === 36 ? params.adminId : undefined,
        createdBy: params.adminId && params.adminId.length === 36 ? params.adminId : undefined,
        idempotencyKey: finalIdempotencyKey,
        note: params.reason,
      });
    }

    // Fetch the created transaction record
    const { data: tx } = await supabase
      .from("wallet_transactions")
      .select("*")
      .eq("user_id", params.userId)
      .eq("idempotency_key", finalIdempotencyKey)
      .maybeSingle();

    // Insert audit log
    await this.logAudit({
      action: "wallet.adjust",
      adminId: params.adminId,
      adminEmail: params.adminEmail,
      targetType: "wallet",
      targetId: updatedWallet?.id || params.userId,
      details: {
        user_id: params.userId,
        user_email: profile.email,
        direction: params.direction,
        amount: fmt(amt),
        previous_balance: fmt(curBal),
        balance_after: updatedWallet?.available_balance,
        reason: params.reason,
        ledger_tx_id: tx?.id,
        idempotency_key: finalIdempotencyKey,
      },
    });

    // Create notification in Supabase
    await this.createNotification({
      userId: params.userId,
      type: "wallet_adjustment",
      title: `Wallet ${params.direction === "credit" ? "Credited" : "Debited"} ($${fmt(amt)} USDT)`,
      message: `An administrator has ${params.direction === "credit" ? "credited" : "debited"} $${fmt(amt)} USDT to your wallet. Reason: ${params.reason}. Balance: $${updatedWallet?.available_balance} USDT.`,
      actionUrl: "/wallet",
      actionText: "View Wallet",
    });

    return {
      ok: true,
      transaction: tx ? this.serializeTransaction(tx) : {
        id: finalIdempotencyKey,
        type: "ADMIN_ADJUSTMENT",
        direction: params.direction,
        amount: fmt(amt),
        balance_after: updatedWallet?.available_balance,
        note: params.reason,
        created_at: new Date().toISOString(),
      },
      user: { id: profile.id, name: profile.name, email: profile.email },
      wallet: { available_balance: updatedWallet?.available_balance },
    };
  }

  public async suspendUser(params: {
    userId: string;
    adminId: string;
    adminEmail?: string;
    reason?: string;
  }): Promise<any> {
    if (!isSupabaseAdminConfigured()) throw new Error("Supabase is not configured.");
    const supabase = this.getClient();
    const profile = await this.getProfileById(params.userId);
    if (!profile) throw new Error("User not found.");
    if (profile.role === "admin") throw new Error("Admin accounts cannot be suspended.");

    const nowStr = new Date().toISOString();
    const reasonText = params.reason || "Administrative suspension";

    const { data: updated, error } = await supabase
      .from("profiles")
      .update({
        status: "suspended",
        suspended_at: nowStr,
        suspended_reason: reasonText,
        suspended_by: params.adminId,
        updated_at: nowStr,
      })
      .eq("id", params.userId)
      .select()
      .single();

    if (error) throw new Error("Failed to suspend user: " + error.message);

    await this.logAudit({
      action: "user.suspend",
      adminId: params.adminId,
      adminEmail: params.adminEmail || "admin@easyx.trade",
      targetType: "user",
      targetId: params.userId,
      details: { reason: reasonText },
    });

    await this.createNotification({
      userId: params.userId,
      type: "account_suspended",
      title: "Account suspended",
      message: "Your account has been suspended. Existing investments continue toward maturity. Contact support for details.",
    });

    return this.formatProfile(updated);
  }

  public async unsuspendUser(params: {
    userId: string;
    adminId: string;
    adminEmail?: string;
  }): Promise<any> {
    if (!isSupabaseAdminConfigured()) throw new Error("Supabase is not configured.");
    const supabase = this.getClient();
    const profile = await this.getProfileById(params.userId);
    if (!profile) throw new Error("User not found.");

    const nowStr = new Date().toISOString();

    const { data: updated, error } = await supabase
      .from("profiles")
      .update({
        status: "active",
        suspended_at: null,
        suspended_reason: null,
        suspended_by: null,
        updated_at: nowStr,
      })
      .eq("id", params.userId)
      .select()
      .single();

    if (error) throw new Error("Failed to unsuspend user: " + error.message);

    await this.logAudit({
      action: "user.unsuspend",
      adminId: params.adminId,
      adminEmail: params.adminEmail || "admin@easyx.trade",
      targetType: "user",
      targetId: params.userId,
      details: {},
    });

    await this.createNotification({
      userId: params.userId,
      type: "account_reactivated",
      title: "Account reactivated",
      message: "Your account has been reactivated. Welcome back!",
    });

    return this.formatProfile(updated);
  }

  public async batchSetUserStatus(params: {
    ids: string[];
    status: string;
    reason?: string;
    adminId: string;
    adminEmail?: string;
  }): Promise<{ success: boolean; count: number; status: string; updated: any[]; errors: any[] }> {
    if (!isSupabaseAdminConfigured()) throw new Error("Supabase is not configured.");
    const updated: any[] = [];
    const errors: any[] = [];

    for (const id of params.ids) {
      try {
        const profile = await this.getProfileById(id);
        if (!profile) {
          errors.push({ id, error: "User not found" });
          continue;
        }
        if (profile.role === "admin") {
          errors.push({ id, error: "Cannot modify admin user" });
          continue;
        }

        if (params.status === "suspended") {
          const res = await this.suspendUser({
            userId: id,
            adminId: params.adminId,
            adminEmail: params.adminEmail,
            reason: params.reason || "Batch suspended by administrator",
          });
          updated.push(res);
        } else if (params.status === "active") {
          const res = await this.unsuspendUser({
            userId: id,
            adminId: params.adminId,
            adminEmail: params.adminEmail,
          });
          updated.push(res);
        } else if (params.status === "kyc_approved") {
          await this.adminReviewKyc({
            kycIdOrUserId: id,
            adminId: params.adminId,
            adminEmail: params.adminEmail,
            decision: "approve",
          });
          const prof = await this.getProfileById(id);
          updated.push(prof);
        } else if (params.status === "kyc_rejected") {
          await this.adminReviewKyc({
            kycIdOrUserId: id,
            adminId: params.adminId,
            adminEmail: params.adminEmail,
            decision: "reject",
            rejectReason: params.reason || "Rejected by administrator",
          });
          const prof = await this.getProfileById(id);
          updated.push(prof);
        }
      } catch (err: any) {
        errors.push({ id, error: err?.message || "Failed to update user" });
      }
    }

    return { success: true, count: updated.length, status: params.status, updated, errors };
  }

  public async backdateInvestment(id: string, secondsAgo: number = 1): Promise<any> {
    if (!isSupabaseAdminConfigured()) throw new Error("Supabase is not configured.");
    const supabase = this.getClient();
    const newMaturity = new Date(Date.now() - secondsAgo * 1000).toISOString();
    const { data, error } = await supabase
      .from("investments")
      .update({ maturity_at: newMaturity, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error("Failed to backdate investment: " + error.message);
    return data;
  }

  public async getAdminTrends(period: string = "30d"): Promise<any> {
    if (!isSupabaseAdminConfigured()) throw new Error("Supabase is not configured.");
    const supabase = this.getClient();
    const now = new Date();

    let daysCount = 30;
    let isMonthly = false;
    if (period === "7d") daysCount = 7;
    else if (period === "30d") daysCount = 30;
    else if (period === "90d") daysCount = 90;
    else if (period === "1y") { daysCount = 365; isMonthly = true; }
    else if (period === "all") { daysCount = 180; isMonthly = true; }

    const [
      { data: profiles, error: pErr },
      { data: deposits, error: dErr },
      { data: investments, error: iErr },
    ] = await Promise.all([
      supabase.from("profiles").select("id, role, status, kyc_status, created_at").neq("role", "admin"),
      supabase.from("payment_deposits").select("id, user_id, amount, approved_amount, status, network, created_at"),
      supabase.from("investments").select("id, plan_key, principal, status, created_at"),
    ]);

    if (pErr) throw new Error("Failed to fetch profiles: " + pErr.message);
    if (dErr) throw new Error("Failed to fetch deposits: " + dErr.message);
    if (iErr) throw new Error("Failed to fetch investments: " + iErr.message);

    const nonAdminUsers = profiles || [];
    const allDeposits = deposits || [];
    const allInvestments = investments || [];

    interface BucketData {
      date: string;
      formatted_date: string;
      full_date: string;
      rawDate: Date;
      new_users: number;
      cumulative_users: number;
      active_users: number;
      kyc_verified: number;
      approved_deposits: number;
      pending_deposits: number;
      rejected_deposits: number;
      total_deposits: number;
      cumulative_deposits: number;
      deposit_count: number;
      avg_deposit: number;
    }

    const buckets: BucketData[] = [];
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    if (isMonthly) {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        buckets.push({
          date: key,
          formatted_date: `${monthNames[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`,
          full_date: `${monthNames[d.getMonth()]} ${d.getFullYear()}`,
          rawDate: d,
          new_users: 0,
          cumulative_users: 0,
          active_users: 0,
          kyc_verified: 0,
          approved_deposits: 0,
          pending_deposits: 0,
          rejected_deposits: 0,
          total_deposits: 0,
          cumulative_deposits: 0,
          deposit_count: 0,
          avg_deposit: 0,
        });
      }
    } else {
      for (let i = daysCount - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400000);
        const key = d.toISOString().slice(0, 10);
        const day = d.getDate();
        const month = monthNames[d.getMonth()];
        buckets.push({
          date: key,
          formatted_date: `${day} ${month}`,
          full_date: `${day} ${month} ${d.getFullYear()}`,
          rawDate: d,
          new_users: 0,
          cumulative_users: 0,
          active_users: 0,
          kyc_verified: 0,
          approved_deposits: 0,
          pending_deposits: 0,
          rejected_deposits: 0,
          total_deposits: 0,
          cumulative_deposits: 0,
          deposit_count: 0,
          avg_deposit: 0,
        });
      }
    }

    for (const user of nonAdminUsers) {
      if (!user.created_at) continue;
      const uDate = new Date(user.created_at);
      const dateKey = isMonthly
        ? `${uDate.getFullYear()}-${String(uDate.getMonth() + 1).padStart(2, "0")}`
        : user.created_at.slice(0, 10);

      const bucket = buckets.find((b) => b.date === dateKey);
      if (bucket) {
        bucket.new_users += 1;
        if (user.kyc_status === "approved") bucket.kyc_verified += 1;
        if (user.status === "active") bucket.active_users += 1;
      }
    }

    for (const dep of allDeposits) {
      if (!dep.created_at) continue;
      const dDate = new Date(dep.created_at);
      const dateKey = isMonthly
        ? `${dDate.getFullYear()}-${String(dDate.getMonth() + 1).padStart(2, "0")}`
        : dep.created_at.slice(0, 10);

      const bucket = buckets.find((b) => b.date === dateKey);
      if (bucket) {
        const amt = Number(dep.amount || 0);
        const appAmt = Number(dep.approved_amount || dep.amount || 0);
        bucket.total_deposits += amt;

        if (dep.status === "approved") {
          bucket.approved_deposits += appAmt;
          bucket.deposit_count += 1;
        } else if (dep.status === "pending") {
          bucket.pending_deposits += amt;
        } else if (dep.status === "rejected") {
          bucket.rejected_deposits += amt;
        }
      }
    }

    let runningUsers = 0;
    let runningDeposits = 0;
    const firstBucketStart = buckets[0]?.rawDate || new Date(0);
    const priorUsers = nonAdminUsers.filter((u) => u.created_at && new Date(u.created_at) < firstBucketStart).length;
    const priorApprovedDeposits = allDeposits
      .filter((d) => d.status === "approved" && d.created_at && new Date(d.created_at) < firstBucketStart)
      .reduce((sum, d) => sum + Number(d.approved_amount || d.amount || 0), 0);

    runningUsers = priorUsers;
    runningDeposits = priorApprovedDeposits;

    for (const b of buckets) {
      runningUsers += b.new_users;
      runningDeposits += b.approved_deposits;

      b.cumulative_users = runningUsers;
      b.cumulative_deposits = Math.round(runningDeposits * 100) / 100;
      b.approved_deposits = Math.round(b.approved_deposits * 100) / 100;
      b.pending_deposits = Math.round(b.pending_deposits * 100) / 100;
      b.total_deposits = Math.round(b.total_deposits * 100) / 100;
      b.avg_deposit = b.deposit_count > 0 ? Math.round((b.approved_deposits / b.deposit_count) * 100) / 100 : 0;
    }

    const networkMap: Record<string, { volume: number; count: number; color: string }> = {
      TRC20: { volume: 0, count: 0, color: "#10b981" },
      BEP20: { volume: 0, count: 0, color: "#a855f7" },
      ERC20: { volume: 0, count: 0, color: "#0ea5e9" },
      POLYGON: { volume: 0, count: 0, color: "#f59e0b" },
    };

    for (const dep of allDeposits) {
      if (dep.status === "approved") {
        const net = (dep.network || "TRC20").toUpperCase();
        if (!networkMap[net]) {
          networkMap[net] = { volume: 0, count: 0, color: "#ec4899" };
        }
        const v = Number(dep.approved_amount || dep.amount || 0);
        networkMap[net].volume += v;
        networkMap[net].count += 1;
      }
    }

    const totalAppVolume = Object.values(networkMap).reduce((sum, n) => sum + n.volume, 0) || 1;
    const network_breakdown = Object.entries(networkMap)
      .filter(([_, data]) => data.count > 0 || data.volume > 0)
      .map(([network, data]) => ({
        network,
        volume: Math.round(data.volume * 100) / 100,
        count: data.count,
        percentage: Math.round((data.volume / totalAppVolume) * 1000) / 10,
        color: data.color,
      }));

    const planMap: Record<string, { name: string; volume: number; count: number; color: string }> = {
      silver: { name: "Silver ($300)", volume: 0, count: 0, color: "#94a3b8" },
      gold: { name: "Gold ($1,000)", volume: 0, count: 0, color: "#fbbf24" },
      platinum: { name: "Platinum ($5,000)", volume: 0, count: 0, color: "#a855f7" },
      diamond: { name: "Diamond ($10,000)", volume: 0, count: 0, color: "#38bdf8" },
    };

    for (const inv of allInvestments) {
      const key = (inv.plan_key || "silver").toLowerCase();
      if (planMap[key]) {
        planMap[key].volume += Number(inv.principal || 0);
        planMap[key].count += 1;
      }
    }
    const totalPlanVolume = Object.values(planMap).reduce((sum, p) => sum + p.volume, 0) || 1;
    const plan_breakdown = Object.entries(planMap).map(([key, data]) => ({
      key,
      name: data.name,
      volume: Math.round(data.volume * 100) / 100,
      count: data.count,
      percentage: Math.round((data.volume / totalPlanVolume) * 1000) / 10,
      color: data.color,
    }));

    const kycApproved = nonAdminUsers.filter((u) => u.kyc_status === "approved").length;
    const kycPending = nonAdminUsers.filter((u) => u.kyc_status === "pending").length;
    const kycRejected = nonAdminUsers.filter((u) => u.kyc_status === "rejected").length;
    const kycNone = nonAdminUsers.filter((u) => !u.kyc_status || u.kyc_status === "none").length;
    const totalU = nonAdminUsers.length || 1;

    const kyc_funnel = [
      { status: "Approved", count: kycApproved, percentage: Math.round((kycApproved / totalU) * 100), color: "#10b981" },
      { status: "Pending Review", count: kycPending, percentage: Math.round((kycPending / totalU) * 100), color: "#f59e0b" },
      { status: "Not Submitted", count: kycNone, percentage: Math.round((kycNone / totalU) * 100), color: "#64748b" },
      { status: "Rejected", count: kycRejected, percentage: Math.round((kycRejected / totalU) * 100), color: "#f43f5e" },
    ];

    const periodNewUsers = buckets.reduce((sum, b) => sum + b.new_users, 0);
    const periodApprovedDeposits = buckets.reduce((sum, b) => sum + b.approved_deposits, 0);
    const periodPendingDeposits = buckets.reduce((sum, b) => sum + b.pending_deposits, 0);
    const totalApprovedDepositsOverall = allDeposits
      .filter((d) => d.status === "approved")
      .reduce((sum, d) => sum + Number(d.approved_amount || d.amount || 0), 0);

    const usersWithDeposits = new Set(allDeposits.filter((d) => d.status === "approved").map((d) => d.user_id)).size;
    const depositConversionRate = nonAdminUsers.length > 0 ? Math.round((usersWithDeposits / nonAdminUsers.length) * 1000) / 10 : 0;

    let peakDepositDay = { date: "—", amount: 0 };
    let peakRegDay = { date: "—", count: 0 };
    for (const b of buckets) {
      if (b.approved_deposits > peakDepositDay.amount) {
        peakDepositDay = { date: b.formatted_date, amount: b.approved_deposits };
      }
      if (b.new_users > peakRegDay.count) {
        peakRegDay = { date: b.formatted_date, count: b.new_users };
      }
    }

    const half = Math.floor(buckets.length / 2);
    const firstHalfUsers = buckets.slice(0, half).reduce((sum, b) => sum + b.new_users, 0) || 1;
    const secondHalfUsers = buckets.slice(half).reduce((sum, b) => sum + b.new_users, 0);
    const userGrowthRate = Math.round(((secondHalfUsers - firstHalfUsers) / firstHalfUsers) * 1000) / 10;

    const firstHalfDeps = buckets.slice(0, half).reduce((sum, b) => sum + b.approved_deposits, 0) || 1;
    const secondHalfDeps = buckets.slice(half).reduce((sum, b) => sum + b.approved_deposits, 0);
    const depositGrowthRate = Math.round(((secondHalfDeps - firstHalfDeps) / firstHalfDeps) * 1000) / 10;

    const totalDepCount = allDeposits.filter((d) => d.status === "approved").length;
    const avgDepositAmount = totalDepCount > 0 ? Math.round((totalApprovedDepositsOverall / totalDepCount) * 100) / 100 : 0;

    return {
      period,
      summary: {
        total_users: nonAdminUsers.length,
        period_new_users: periodNewUsers,
        user_growth_rate: userGrowthRate,
        total_approved_deposits: fmt(totalApprovedDepositsOverall),
        period_approved_deposits: fmt(periodApprovedDeposits),
        period_pending_deposits: fmt(periodPendingDeposits),
        deposit_growth_rate: depositGrowthRate,
        deposit_conversion_rate: depositConversionRate,
        avg_deposit_amount: fmt(avgDepositAmount),
        active_investors_count: nonAdminUsers.filter((u) => u.status === "active").length,
        peak_deposit_day: { date: peakDepositDay.date, amount: fmt(peakDepositDay.amount) },
        peak_registration_day: { date: peakRegDay.date, count: peakRegDay.count },
      },
      time_series: buckets,
      network_breakdown,
      plan_breakdown,
      kyc_funnel,
    };
  }
}

export const supabaseDb = SupabaseDbService.getInstance();
