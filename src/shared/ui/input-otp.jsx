import * as React from "react";
import { OTPInput, OTPInputContext, REGEXP_ONLY_DIGITS } from "input-otp";
import { Minus } from "lucide-react";

import { cn } from "@/lib/utils";

const InputOTP = React.forwardRef(({ className, containerClassName, ...props }, ref) => (
  <OTPInput
    ref={ref}
    containerClassName={cn("flex items-center gap-2 has-[:disabled]:opacity-50", containerClassName)}
    className={cn("disabled:cursor-not-allowed", className)}
    {...props}
  />
));
InputOTP.displayName = "InputOTP";

const InputOTPGroup = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("flex items-center gap-1.5 xs:gap-2 sm:gap-2.5", className)} {...props} />
));
InputOTPGroup.displayName = "InputOTPGroup";

const InputOTPSlot = React.forwardRef(({ index, className, isError, ...props }, ref) => {
  const inputOTPContext = React.useContext(OTPInputContext);
  const slot = inputOTPContext?.slots?.[index] || {};
  const { char, hasFakeCaret, isActive } = slot;

  const isFilled = Boolean(char);

  return (
    <div
      ref={ref}
      data-slot={index}
      data-testid={`otp-slot-${index}`}
      className={cn(
        // 6 distinct standalone visual boxes with mobile-first sizing
        "relative flex h-12 w-10 xs:h-13 xs:w-11 sm:h-14 sm:w-12 items-center justify-center rounded-xl border text-xl sm:text-2xl font-mono font-bold transition-all duration-150 select-none",
        // Idle / Empty state
        !isActive && !isError && !isFilled && "border-white/10 bg-white/[0.04] text-white/30 shadow-inner",
        // Filled state
        isFilled && !isActive && !isError && "border-purple-400/40 bg-purple-500/[0.07] text-white shadow-[0_0_12px_rgba(143,107,255,0.18)]",
        // Active / Focused state
        isActive && !isError && "z-10 border-purple-400 ring-2 ring-purple-500/50 bg-purple-500/15 shadow-[0_0_20px_rgba(143,107,255,0.35)] scale-[1.03] text-white",
        // Error state
        isError && "border-rose-500/80 ring-2 ring-rose-500/40 bg-rose-500/10 text-rose-200",
        className
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && !isError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-5 w-[2px] rounded-full bg-purple-400 animate-pulse duration-700" />
        </div>
      )}
    </div>
  );
});
InputOTPSlot.displayName = "InputOTPSlot";

const InputOTPSeparator = React.forwardRef(({ className, children, ...props }, ref) => (
  <div ref={ref} role="separator" className={cn("text-white/25 select-none font-bold text-sm px-0.5", className)} {...props}>
    {children || "•"}
  </div>
));
InputOTPSeparator.displayName = "InputOTPSeparator";

/**
 * EasyX Six-Digit OTP Input
 * A luxury 6-slot code input component tailored to the EasyX design system.
 */
export function SixDigitOtpInput({
  value = "",
  onChange,
  onComplete,
  disabled = false,
  isError = false,
  autoFocus = true,
  className,
  id = "verification-code",
  dataTestId,
}) {
  return (
    <div className={cn("flex justify-center w-full", isError && "animate-shake", className)}>
      <InputOTP
        id={id}
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        value={value}
        onChange={(val) => {
          onChange?.(val);
          if (val && val.length === 6) {
            onComplete?.(val);
          }
        }}
        disabled={disabled}
        autoFocus={autoFocus}
        data-testid={dataTestId}
        containerClassName="justify-center gap-1 xs:gap-1.5 sm:gap-2"
      >
        <InputOTPGroup>
          <InputOTPSlot index={0} isError={isError} />
          <InputOTPSlot index={1} isError={isError} />
          <InputOTPSlot index={2} isError={isError} />
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          <InputOTPSlot index={3} isError={isError} />
          <InputOTPSlot index={4} isError={isError} />
          <InputOTPSlot index={5} isError={isError} />
        </InputOTPGroup>
      </InputOTP>
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator, REGEXP_ONLY_DIGITS };
