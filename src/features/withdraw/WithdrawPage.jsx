import React, { useMemo, useState, useEffect } from "react";
import { ArrowUpFromLine, ShieldCheck, AlertTriangle, KeyRound } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import dayjs from "dayjs";

import {
  useWithdrawConfig,
  useMyWithdrawals,
  useCreateWithdrawal,
  useRequestWithdrawalOtp,
  useWallet,
  useDashboard,
  money,
} from "@/features/dashboard/api";
import { apiError } from "@/lib/api";
import { SixDigitOtpInput } from "@/shared/ui/input-otp";
import {
  PageHeading,
  EasyXCard,
  EasyXButton,
  EasyXLoader,
  EasyXStatusBadge,
} from "@/design/EasyX";

const NETWORKS = [
  { key: "TRC20", label: "TRC20", chain: "Tron network" },
  { key: "BEP20", label: "BEP20", chain: "BNB Smart Chain" },
];

export default function WithdrawPage() {
  const { data: config, isLoading } = useWithdrawConfig();
  const { data: wallet } = useWallet();
  const { data: dashboard } = useDashboard();
  const { data: withdrawals } = useMyWithdrawals();
  const createWithdrawal = useCreateWithdrawal();
  const requestOtp = useRequestWithdrawalOtp();

  const [network, setNetwork] = useState("TRC20");
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState("");

  // OTP verification state
  const [step, setStep] = useState("details"); // "details" | "otp"
  const [otp, setOtp] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [timeLeft, setTimeLeft] = useState(300); // 5 minutes
  const [resendCooldown, setResendCooldown] = useState(0);

  const kycStatus = dashboard?.user?.kyc_status || "none";
  const kycApproved = kycStatus === "approved";
  const min = Number(config?.min_withdrawal ?? 100);
  const available = Number(wallet?.available_balance ?? 0);

  const amountNum = parseFloat(amount);
  let amountError = "";
  if (amount !== "") {
    if (isNaN(amountNum) || amountNum < min) amountError = `Minimum withdrawal is ${money(min)} USDT`;
    else if (amountNum > available) amountError = `Amount exceeds your available balance (${money(available)} USDT)`;
  }
  const canSubmit =
    kycApproved && !amountError && amount !== "" && address.trim().length >= 8 && !requestOtp.isPending;

  // Countdown timer for OTP expiry and resend cooldown
  useEffect(() => {
    if (step !== "otp") return;
    const interval = setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0));
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [step]);

  // Step 1: Request 6-digit OTP sent to verified email
  const handleRequestOtp = async (e) => {
    e?.preventDefault();
    if (!canSubmit || requestOtp.isPending) return;
    try {
      const res = await requestOtp.mutateAsync({
        network,
        amount: String(amount),
        to_address: address.trim(),
      });
      setMaskedEmail(res?.emailMasked || "");
      setTimeLeft(res?.expiresIn || 300);
      setResendCooldown(60);
      setOtp("");
      setStep("otp");
      toast.success("OTP Sent", {
        description: `Security verification code dispatched to ${res?.emailMasked || "your verified email"} via Resend.`,
        duration: 5000,
      });
    } catch (err) {
      toast.error(apiError(err, "Could not request verification code"));
    }
  };

  // Resend OTP
  const handleResendOtp = async () => {
    if (resendCooldown > 0 || requestOtp.isPending) return;
    try {
      const res = await requestOtp.mutateAsync({
        network,
        amount: String(amount),
        to_address: address.trim(),
      });
      const targetEmail = res?.emailMasked || maskedEmail || "your verified email";
      setMaskedEmail(res?.emailMasked || maskedEmail);
      setTimeLeft(res?.expiresIn || 300);
      setResendCooldown(60);
      toast.success("OTP Sent", {
        description: `A new verification code has been dispatched to ${targetEmail} via Resend.`,
        duration: 5000,
      });
    } catch (err) {
      toast.error(apiError(err, "Could not resend verification code"));
    }
  };

  // Step 2: Verify OTP and create withdrawal request
  const handleConfirmWithdrawal = async (e, overrideOtp) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (createWithdrawal.isPending || timeLeft === 0) return;
    const candidateOtp = typeof overrideOtp === "string" ? overrideOtp : (typeof e === "string" ? e : otp);
    const cleanOtp = (candidateOtp || "").replace(/\D/g, "").slice(0, 6);
    if (cleanOtp.length !== 6) return;
    try {
      await createWithdrawal.mutateAsync({
        network,
        amount: String(amount),
        to_address: address.trim(),
        otp: cleanOtp,
      });
      toast.success("Withdrawal requested \u2014 pending admin approval");
      setAmount("");
      setAddress("");
      setOtp("");
      setStep("details");
    } catch (err) {
      toast.error(apiError(err, "Verification failed"));
    }
  };

  const sorted = useMemo(() => withdrawals || [], [withdrawals]);

  return (
    <div data-testid="withdraw-page">
      <PageHeading
        title="Withdraw USDT"
        subtitle={`Send USDT to your wallet. Minimum withdrawal ${money(min)} USDT.`}
        icon={ArrowUpFromLine}
      />

      {isLoading ? (
        <EasyXLoader />
      ) : !kycApproved ? (
        <EasyXCard className="mt-5" data-testid="withdraw-kyc-gate">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-ex-ctrl bg-amber-500/15 text-amber-300">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="font-semibold text-ex-text">Verify your identity to withdraw</div>
              <p className="mt-1 text-sm text-ex-muted">
                Withdrawals are unlocked once your KYC is approved. Your current status is
                <span className="font-medium text-ex-text"> {kycStatus}</span>.
              </p>
              <Link to="/app/kyc">
                <EasyXButton className="mt-3" data-testid="withdraw-goto-kyc">Complete KYC</EasyXButton>
              </Link>
            </div>
          </div>
        </EasyXCard>
      ) : (
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <EasyXCard>
            <div className="flex items-center justify-between">
              <div className="text-sm text-ex-muted">Available balance</div>
              <div className="text-lg font-bold text-ex-text" data-testid="withdraw-available">{money(available)} USDT</div>
            </div>

            {step === "details" ? (
              <form onSubmit={handleRequestOtp} className="mt-4 space-y-4" data-testid="withdraw-form">
                <div>
                  <label className="text-xs text-ex-muted">Network</label>
                  <div className="mt-1 inline-flex rounded-ex-ctrl bg-white/5 p-1" data-testid="withdraw-network-tabs">
                    {NETWORKS.map((n) => (
                      <button
                        key={n.key}
                        type="button"
                        onClick={() => setNetwork(n.key)}
                        data-testid={`withdraw-network-${n.key}`}
                        data-active={network === n.key ? "true" : "false"}
                        className={`px-4 py-2 rounded-ex-ctrl text-sm font-medium transition ${
                          network === n.key ? "bg-ex-accent text-ex-ink shadow-ex-btn" : "text-ex-muted hover:text-ex-text"
                        }`}
                      >
                        {n.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-ex-muted">Destination address ({network})</label>
                  <input
                    type="text"
                    placeholder={`Your ${network} USDT address`}
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    className="mt-1 w-full rounded-ex-ctrl bg-white/5 border border-white/10 px-3 py-2.5 text-sm text-ex-text placeholder:text-ex-muted/60 focus:border-ex-accent focus:outline-none"
                    data-testid="withdraw-address-input"
                  />
                </div>
                <div>
                  <label className="text-xs text-ex-muted">Amount (USDT)</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={min}
                    step="0.01"
                    placeholder={`Min ${money(min)}`}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="mt-1 w-full rounded-ex-ctrl bg-white/5 border border-white/10 px-3 py-2.5 text-sm text-ex-text placeholder:text-ex-muted/60 focus:border-ex-accent focus:outline-none"
                    data-testid="withdraw-amount-input"
                  />
                  {amountError && <p className="mt-1 text-xs text-red-300" data-testid="withdraw-amount-error">{amountError}</p>}
                </div>
                <EasyXButton
                  type="submit"
                  className="w-full"
                  disabled={!canSubmit}
                  loading={requestOtp.isPending}
                  data-testid="withdraw-submit"
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  Request Security Code
                </EasyXButton>
              </form>
            ) : (
              <div className="mt-4 space-y-4" data-testid="withdraw-otp-step">
                <div className="rounded-ex-ctrl bg-white/5 p-3.5 text-xs border border-white/10 space-y-1.5">
                  <div className="flex justify-between text-ex-muted">
                    <span>Withdrawal Amount:</span>
                    <span className="font-semibold text-ex-text">{money(amountNum)} USDT</span>
                  </div>
                  <div className="flex justify-between text-ex-muted">
                    <span>Transfer Network:</span>
                    <span className="font-medium text-ex-accent">{network}</span>
                  </div>
                  <div className="flex justify-between text-ex-muted items-center">
                    <span>Destination:</span>
                    <span className="font-mono text-[11px] text-ex-text truncate max-w-[200px]">{address}</span>
                  </div>
                </div>

                <div className="text-xs text-ex-muted">
                  Enter the 6-digit authorization code sent to{" "}
                  <strong className="text-ex-text">{maskedEmail || "your verified email"}</strong>.
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs text-ex-muted font-medium">6-Digit Security Code</label>
                    <span className={`text-xs font-mono font-medium ${timeLeft < 60 ? "text-red-400" : "text-ex-muted"}`}>
                      {timeLeft > 0
                        ? `Valid: ${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, "0")}`
                        : "Code expired"}
                    </span>
                  </div>
                  <SixDigitOtpInput
                    id="withdraw-otp"
                    value={otp}
                    onChange={(val) => setOtp(val.replace(/\D/g, "").slice(0, 6))}
                    onComplete={(val) => {
                      if (!createWithdrawal.isPending && timeLeft > 0) {
                        handleConfirmWithdrawal(undefined, val);
                      }
                    }}
                    disabled={createWithdrawal.isPending || timeLeft === 0}
                    autoFocus
                    dataTestId="withdraw-otp-input"
                  />
                </div>

                <EasyXButton
                  type="button"
                  onClick={handleConfirmWithdrawal}
                  className="w-full"
                  disabled={otp.trim().length !== 6 || timeLeft === 0 || createWithdrawal.isPending}
                  loading={createWithdrawal.isPending}
                  data-testid="withdraw-otp-submit"
                >
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  Authorize & Submit Withdrawal
                </EasyXButton>

                <div className="flex items-center justify-between pt-1 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setStep("details");
                      setOtp("");
                    }}
                    className="text-ex-muted hover:text-ex-text transition"
                    data-testid="withdraw-back-button"
                  >
                    &larr; Modify Details
                  </button>
                  <button
                    type="button"
                    onClick={handleResendOtp}
                    disabled={resendCooldown > 0 || requestOtp.isPending}
                    className="text-ex-accent hover:underline disabled:opacity-50 disabled:no-underline"
                    data-testid="withdraw-resend-otp"
                  >
                    {resendCooldown > 0 ? `Resend Code (${resendCooldown}s)` : "Resend Code"}
                  </button>
                </div>
              </div>
            )}
          </EasyXCard>

          <EasyXCard>
            <div className="space-y-4 text-xs text-ex-muted">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-ex-lav-300" />
                <span>The requested amount is held from your available balance immediately upon submission. An administrator audits and signs each payout on-chain. If rejected, the full amount is returned to your wallet.</span>
              </div>
              <div className="flex items-start gap-2.5 pt-3 border-t border-white/5">
                <ShieldCheck className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />
                <span>Two-factor withdrawal authorization is active. A single-use 6-digit cryptographic code is dispatched exclusively to your verified account email to prevent unauthorized fund movements.</span>
              </div>
            </div>
          </EasyXCard>
        </div>
      )}

      <h2 className="mt-9 ex-display text-lg font-bold">Your withdrawals</h2>
      <EasyXCard className="mt-3 p-0 overflow-hidden">
        {!sorted || sorted.length === 0 ? (
          <div className="p-8 text-center text-ex-muted text-sm">No withdrawals yet.</div>
        ) : (
          <div className="divide-y divide-white/5" data-testid="withdraw-history">
            {sorted.map((w) => (
              <div key={w.id} className="flex items-center justify-between gap-3 px-4 py-3" data-testid={`withdraw-row-${w.id}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ex-text">{money(w.amount)} USDT</span>
                    <span className="text-[11px] text-ex-muted">· {w.network}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-ex-muted max-w-[220px] sm:max-w-md">{w.to_address}</div>
                  {w.tx_hash && <div className="truncate text-[11px] text-emerald-300 max-w-[220px] sm:max-w-md">TX: {w.tx_hash}</div>}
                  <div className="text-[11px] text-ex-muted">{dayjs(w.created_at).format("DD MMM YYYY, HH:mm")}</div>
                </div>
                <EasyXStatusBadge status={w.status} />
              </div>
            ))}
          </div>
        )}
      </EasyXCard>
    </div>
  );
}
