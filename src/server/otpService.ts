import crypto from "crypto";
import { getSupabaseAdmin, isSupabaseAdminConfigured, isAdminKeyVerified } from "./supabaseAdmin";
import { emailService } from "./emailService";

export type OtpPurpose = "SIGNUP" | "FORGOT_PASSWORD" | "WITHDRAWAL";

export interface OtpSessionRecord {
  id: string;
  purpose: OtpPurpose;
  email: string;
  userId?: string;
  salt: string;
  otpHash: string;
  token?: string;
  expiresAt: number;
  attempts: number;
  maxAttempts: number;
  verified: boolean;
  used: boolean;
  metadata?: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export interface RateLimitState {
  lastRequestAt: number;
  hourlyRequests: number[];
}

export interface RequestOtpParams {
  purpose: OtpPurpose;
  email: string;
  userId?: string;
  userName?: string;
  origin?: string;
  metadata?: Record<string, any>;
}

export interface VerifyOtpParams {
  purpose: OtpPurpose;
  email?: string;
  userId?: string;
  code?: string;
  token?: string;
  metadata?: Record<string, any>;
}

export class OtpService {
  private static instance: OtpService | null = null;
  // Ephemeral memory cache mirroring Supabase for instant sub-millisecond lookup
  private cache = new Map<string, OtpSessionRecord>();
  private rateLimits = new Map<string, RateLimitState>();

  public static getInstance(): OtpService {
    if (!this.instance) {
      this.instance = new OtpService();
    }
    return this.instance;
  }

  /**
   * Masks email securely for user display, e.g. "su***n@gmail.com"
   */
  public maskEmail(email: string): string {
    if (!email || typeof email !== "string" || !email.includes("@")) return email || "";
    const [local, domain] = email.trim().toLowerCase().split("@");
    if (!domain) return email;
    if (local.length <= 2) return `${local[0] || ""}*@${domain}`;
    if (local.length <= 4) return `${local.slice(0, 1)}**${local.slice(-1)}@${domain}`;
    return `${local.slice(0, 2)}***${local.slice(-1)}@${domain}`;
  }

  private getStorageKey(purpose: OtpPurpose, identifier: string): string {
    const cleanId = identifier.trim().toLowerCase();
    return `otp:${purpose.toLowerCase()}:${cleanId}`;
  }

  private getRateLimitKey(purpose: OtpPurpose, identifier: string): string {
    const cleanId = identifier.trim().toLowerCase();
    return `rl:${purpose.toLowerCase()}:${cleanId}`;
  }

  /**
   * Persists the OTP session to Supabase platform_settings (production source of truth)
   * Indexed under both userId and email if available for foolproof lookup
   */
  private async persistSession(session: OtpSessionRecord): Promise<void> {
    const keys: string[] = [];
    if (session.email) keys.push(this.getStorageKey(session.purpose, session.email));
    if (session.userId) keys.push(this.getStorageKey(session.purpose, session.userId));

    for (const k of keys) {
      this.cache.set(k, session);
    }

    if (isSupabaseAdminConfigured() && isAdminKeyVerified()) {
      try {
        const client = getSupabaseAdmin();
        const upserts = keys.map((key) => ({
          key,
          value: session,
          description: `Authoritative OTP session for ${session.purpose} (${session.email})`,
        }));
        await client.from("platform_settings").upsert(upserts);
      } catch (err: any) {
        console.error(`[EasyX OTP] Failed to persist OTP session to Supabase:`, err.message);
      }
    }
  }

  /**
   * Loads the OTP session from Supabase platform_settings
   */
  private async loadSession(purpose: OtpPurpose, identifier: string): Promise<OtpSessionRecord | null> {
    const storageKey = this.getStorageKey(purpose, identifier);
    
    // Check Supabase first as production source of truth
    if (isSupabaseAdminConfigured() && isAdminKeyVerified()) {
      try {
        const client = getSupabaseAdmin();
        const { data, error } = await client
          .from("platform_settings")
          .select("value")
          .eq("key", storageKey)
          .maybeSingle();

        if (!error && data?.value) {
          const session = data.value as OtpSessionRecord;
          this.cache.set(storageKey, session);
          return session;
        }
      } catch (err: any) {
        console.warn(`[EasyX OTP] Supabase loadSession notice (${storageKey}):`, err.message);
      }
    }

    // Fallback to local memory cache
    return this.cache.get(storageKey) || null;
  }

  /**
   * Removes or marks session as used in Supabase (clearing both email and userId keys)
   */
  private async deleteSession(purpose: OtpPurpose, identifier: string): Promise<void> {
    const session = await this.loadSession(purpose, identifier);
    const keys: string[] = [this.getStorageKey(purpose, identifier)];
    if (session?.email) keys.push(this.getStorageKey(purpose, session.email));
    if (session?.userId) keys.push(this.getStorageKey(purpose, session.userId));

    for (const k of keys) {
      this.cache.delete(k);
    }

    if (isSupabaseAdminConfigured() && isAdminKeyVerified()) {
      try {
        const client = getSupabaseAdmin();
        await client.from("platform_settings").delete().in("key", keys);
      } catch (err: any) {
        console.error(`[EasyX OTP] Failed to delete OTP session from Supabase:`, err.message);
      }
    }
  }

  /**
   * Rate limiting enforcement:
   * - 60-second cooldown between requests
   * - Maximum 5 requests per hour
   */
  private checkRateLimit(purpose: OtpPurpose, identifier: string): void {
    const rlKey = this.getRateLimitKey(purpose, identifier);
    const now = Date.now();
    let rl = this.rateLimits.get(rlKey);
    if (!rl) {
      rl = { lastRequestAt: 0, hourlyRequests: [] };
      this.rateLimits.set(rlKey, rl);
    }

    // Prune requests older than 1 hour (3600 seconds)
    rl.hourlyRequests = rl.hourlyRequests.filter((t) => now - t < 3600000);

    // Check 60-second cooldown
    if (now - rl.lastRequestAt < 60000) {
      const waitSec = Math.ceil((60000 - (now - rl.lastRequestAt)) / 1000);
      throw new Error(`Please wait ${waitSec} seconds before requesting a new verification code.`);
    }

    // Check 5 requests per hour limit
    if (rl.hourlyRequests.length >= 5) {
      throw new Error("Too many verification code requests. Please wait an hour before requesting again.");
    }
  }

  private updateRateLimit(purpose: OtpPurpose, identifier: string): void {
    const rlKey = this.getRateLimitKey(purpose, identifier);
    const now = Date.now();
    let rl = this.rateLimits.get(rlKey);
    if (!rl) {
      rl = { lastRequestAt: now, hourlyRequests: [now] };
      this.rateLimits.set(rlKey, rl);
    } else {
      rl.lastRequestAt = now;
      rl.hourlyRequests.push(now);
    }
  }

  /**
   * Generates a 6-digit numeric OTP and dispatches it via email
   */
  public async requestOtp(params: RequestOtpParams): Promise<{
    success: boolean;
    message: string;
    expiresIn: number;
    emailMasked: string;
    token?: string;
    cooldownSeconds: number;
  }> {
    const cleanEmail = params.email.trim().toLowerCase();
    const rateLimitId = params.userId || cleanEmail;

    // Enforce rate limiting
    this.checkRateLimit(params.purpose, rateLimitId);

    // Cryptographically secure 6-digit numeric OTP (100000 - 999999)
    const plainOtp = crypto.randomInt(100000, 1000000).toString();
    const salt = crypto.randomBytes(16).toString("hex");
    const otpHash = crypto.createHash("sha256").update(salt + plainOtp).digest("hex");
    const token = crypto.randomBytes(32).toString("hex");

    // Expiry durations: EXACTLY 5 minutes (300 seconds) for all OTP purposes
    // 1. PASSWORD_RESET / FORGOT_PASSWORD: 5 minutes (300s)
    // 2. EMAIL_VERIFICATION / SIGNUP: 5 minutes (300s)
    // 3. WITHDRAWAL: 5 minutes (300s)
    const expiresInSeconds = 300;

    const now = Date.now();
    const session: OtpSessionRecord = {
      id: crypto.randomUUID(),
      purpose: params.purpose,
      email: cleanEmail,
      userId: params.userId,
      salt,
      otpHash,
      token,
      expiresAt: now + expiresInSeconds * 1000,
      attempts: 0,
      maxAttempts: 3, // Maximum 3 failed attempts
      verified: false,
      used: false,
      metadata: params.metadata || {},
      createdAt: now,
      updatedAt: now,
    };

    // Store in Supabase and memory cache
    await this.persistSession(session);
    this.updateRateLimit(params.purpose, rateLimitId);

    // Dispatch email based on purpose
    if (params.purpose === "SIGNUP") {
      await emailService.sendEmailVerification({
        to: cleanEmail,
        name: params.userName,
        code: plainOtp,
        token,
        origin: params.origin,
        expiresInMinutes: Math.round(expiresInSeconds / 60),
      });
    } else if (params.purpose === "FORGOT_PASSWORD") {
      await emailService.sendPasswordResetEmail({
        to: cleanEmail,
        code: plainOtp,
        token,
        origin: params.origin,
        expiresInMinutes: Math.round(expiresInSeconds / 60),
      });
    } else if (params.purpose === "WITHDRAWAL") {
      await emailService.sendWithdrawalOtpEmail({
        to: cleanEmail,
        name: params.userName,
        code: plainOtp,
        amount: params.metadata?.amount || 0,
        network: params.metadata?.network || "TRC20",
        toAddress: params.metadata?.toAddress || "",
        expiresInMinutes: Math.round(expiresInSeconds / 60),
      });
    }

    return {
      success: true,
      message: `A 6-digit verification code has been sent to ${this.maskEmail(cleanEmail)}.`,
      expiresIn: expiresInSeconds,
      emailMasked: this.maskEmail(cleanEmail),
      token,
      cooldownSeconds: 60,
    };
  }

  /**
   * Verifies an OTP code or 1-click token
   */
  public async verifyOtp(params: VerifyOtpParams): Promise<{
    verified: boolean;
    session: OtpSessionRecord;
    token: string;
  }> {
    const identifier = params.userId || (params.email ? params.email.trim().toLowerCase() : "");
    if (!identifier) {
      throw new Error("Missing user identification for OTP verification.");
    }

    const session = await this.loadSession(params.purpose, identifier);
    const now = Date.now();

    if (!session || session.used) {
      throw new Error("No active verification code session found. Please request a new code.");
    }

    if (now > session.expiresAt) {
      await this.deleteSession(params.purpose, identifier);
      throw new Error("Verification code has expired. Please request a new verification code.");
    }

    if (session.attempts >= session.maxAttempts) {
      await this.deleteSession(params.purpose, identifier);
      throw new Error("Maximum verification attempts exceeded. Please request a new verification code.");
    }

    // If verifying via secure 1-click token
    if (params.token && session.token && params.token.trim() === session.token) {
      session.verified = true;
      session.updatedAt = now;
      await this.persistSession(session);
      return { verified: true, session, token: session.token };
    }

    // Verify via 6-digit code
    const cleanCode = (params.code || "").trim().replace(/\D/g, "");
    if (!cleanCode || cleanCode.length !== 6) {
      throw new Error("Please enter a valid 6-digit verification code.");
    }

    // Verify withdrawal metadata consistency (amount, network, address)
    if (params.purpose === "WITHDRAWAL" && params.metadata && session.metadata) {
      if (
        params.metadata.amount !== undefined &&
        Math.abs(Number(session.metadata.amount) - Number(params.metadata.amount)) > 0.0001
      ) {
        await this.deleteSession(params.purpose, identifier);
        throw new Error("Withdrawal amount mismatch from authorization session. Please request a new code.");
      }

      if (
        params.metadata.network &&
        session.metadata.network &&
        String(session.metadata.network).toUpperCase() !== String(params.metadata.network).toUpperCase()
      ) {
        await this.deleteSession(params.purpose, identifier);
        throw new Error("Withdrawal network mismatch from authorization session. Please request a new code.");
      }

      if (
        params.metadata.toAddress &&
        session.metadata.toAddress &&
        String(session.metadata.toAddress).toLowerCase() !== String(params.metadata.toAddress).toLowerCase()
      ) {
        await this.deleteSession(params.purpose, identifier);
        throw new Error("Destination wallet address mismatch from authorization session. Please request a new code.");
      }
    }

    // Timing-safe hash comparison
    const candidateHash = crypto.createHash("sha256").update(session.salt + cleanCode).digest("hex");
    let isMatch = false;
    try {
      isMatch = crypto.timingSafeEqual(
        Buffer.from(candidateHash, "hex"),
        Buffer.from(session.otpHash, "hex")
      );
    } catch {
      isMatch = false;
    }

    if (!isMatch) {
      session.attempts++;
      session.updatedAt = now;
      const remaining = session.maxAttempts - session.attempts;
      if (remaining <= 0) {
        await this.deleteSession(params.purpose, identifier);
        throw new Error("Incorrect verification code. Maximum attempts exceeded. Please request a new code.");
      }
      await this.persistSession(session);
      throw new Error(`Incorrect verification code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`);
    }

    // Code verified successfully
    session.verified = true;
    session.updatedAt = now;
    await this.persistSession(session);

    return { verified: true, session, token: session.token || "" };
  }

  /**
   * Consumes/invalidates the verified OTP session so it cannot be re-used
   */
  public async consumeOtp(purpose: OtpPurpose, identifier: string): Promise<void> {
    await this.deleteSession(purpose, identifier);
  }

  /**
   * Verifies if an active verified token exists for completing an action (e.g. password reset)
   */
  public async validateVerifiedToken(purpose: OtpPurpose, identifier: string, token?: string): Promise<boolean> {
    const session = await this.loadSession(purpose, identifier);
    if (!session || !session.verified || session.used) return false;
    if (Date.now() > session.expiresAt) {
      await this.deleteSession(purpose, identifier);
      return false;
    }
    if (token && session.token && token.trim() !== session.token) {
      return false;
    }
    return true;
  }
}

export const otpService = OtpService.getInstance();
