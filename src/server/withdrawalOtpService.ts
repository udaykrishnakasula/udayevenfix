import { otpService } from "./otpService";

export interface WithdrawalOtpSession {
  userId: string;
  userEmail: string;
  amount: number;
  network: string;
  toAddress: string;
  salt: string;
  otpHash: string;
  expiresAt: number;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
}

class WithdrawalOtpService {
  /**
   * Generates and dispatches a cryptographically secure 6-digit OTP for withdrawal authorization
   * backed authoritatively by Supabase with persistent rate limiting and security hashing
   */
  public async requestWithdrawalOtp(params: {
    userId: string;
    userEmail: string;
    userName?: string;
    amount: number;
    network: string;
    toAddress: string;
    kycStatus: string;
    availableBalance: number;
  }): Promise<{
    success: boolean;
    message: string;
    expiresIn: number;
    emailMasked: string;
  }> {
    // 1. Enforce strict KYC validation
    if (params.kycStatus !== "approved") {
      throw new Error("Identity verification (KYC) must be approved before requesting withdrawals.");
    }

    // 2. Enforce minimum $100 USDT validation
    const numAmt = Number(params.amount);
    if (isNaN(numAmt) || numAmt < 100) {
      throw new Error("Minimum withdrawal amount is 100.00 USDT.");
    }

    // 3. Enforce available balance validation
    if (params.availableBalance < numAmt) {
      throw new Error(
        `Insufficient available balance (${params.availableBalance.toFixed(2)} USDT) for requested withdrawal (${numAmt.toFixed(2)} USDT).`
      );
    }

    // 4. Validate destination address
    const cleanAddress = (params.toAddress || "").trim();
    if (cleanAddress.length < 8) {
      throw new Error("Invalid destination wallet address.");
    }

    if (!["TRC20", "BEP20"].includes(params.network?.toUpperCase())) {
      throw new Error("Unsupported network. Only TRC20 and BEP20 are supported.");
    }

    // 5. Delegate to authoritative unified otpService backed by Supabase
    const result = await otpService.requestOtp({
      purpose: "WITHDRAWAL",
      userId: params.userId,
      email: params.userEmail,
      userName: params.userName,
      metadata: {
        amount: numAmt,
        network: params.network.toUpperCase(),
        toAddress: cleanAddress,
      },
    });

    return {
      success: true,
      message: result.message,
      expiresIn: result.expiresIn,
      emailMasked: result.emailMasked,
    };
  }

  /**
   * Verifies the submitted OTP against the cryptographically hashed session in Supabase
   */
  public async verifyWithdrawalOtp(params: {
    userId: string;
    otp: string;
    amount: number;
    network: string;
    toAddress: string;
  }): Promise<boolean> {
    await otpService.verifyOtp({
      purpose: "WITHDRAWAL",
      userId: params.userId,
      code: params.otp,
      metadata: {
        amount: params.amount,
        network: params.network,
        toAddress: params.toAddress,
      },
    });

    // Invalidate immediately upon successful verification (single-use guarantee)
    await otpService.consumeOtp("WITHDRAWAL", params.userId);
    return true;
  }
}

export const withdrawalOtpService = new WithdrawalOtpService();
