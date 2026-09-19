import React, { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

/**
 * Reusable MotionToast component using Framer Motion.
 * Positions a subtle, high-contrast, accessible notification at the bottom or top of the viewport.
 */
export function MotionToast({
  isOpen = false,
  onClose,
  message,
  description,
  type = "error",
  duration = 6000,
  action,
  position = "bottom",
  id = "motion-toast",
}) {
  useEffect(() => {
    if (!isOpen || !duration || duration <= 0) return;
    const timer = setTimeout(() => {
      if (onClose) onClose();
    }, duration);
    return () => clearTimeout(timer);
  }, [isOpen, duration, onClose]);

  const typeConfig = {
    error: {
      border: "border-rose-500/30",
      bg: "bg-[#18141F]/95",
      glow: "shadow-rose-950/40",
      iconBg: "bg-rose-500/15 text-rose-400 border border-rose-500/25",
      titleColor: "text-rose-200",
      Icon: AlertCircle,
    },
    warning: {
      border: "border-amber-500/30",
      bg: "bg-[#18161A]/95",
      glow: "shadow-amber-950/40",
      iconBg: "bg-amber-500/15 text-amber-400 border border-amber-500/25",
      titleColor: "text-amber-200",
      Icon: AlertTriangle,
    },
    success: {
      border: "border-emerald-500/30",
      bg: "bg-[#131A17]/95",
      glow: "shadow-emerald-950/40",
      iconBg: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25",
      titleColor: "text-emerald-200",
      Icon: CheckCircle2,
    },
    info: {
      border: "border-purple-500/30",
      bg: "bg-[#161426]/95",
      glow: "shadow-purple-950/40",
      iconBg: "bg-purple-500/15 text-purple-300 border border-purple-500/25",
      titleColor: "text-purple-200",
      Icon: Info,
    },
  }[type] || {
    border: "border-white/20",
    bg: "bg-[#161424]/95",
    glow: "shadow-black/50",
    iconBg: "bg-white/10 text-white",
    titleColor: "text-white",
    Icon: Info,
  };

  const { Icon, border, bg, glow, iconBg, titleColor } = typeConfig;

  const positionClasses =
    position === "top"
      ? "top-6 left-1/2 -translate-x-1/2"
      : "bottom-6 left-1/2 -translate-x-1/2";

  const motionVariants = {
    initial: {
      opacity: 0,
      y: position === "top" ? -24 : 24,
      scale: 0.95,
    },
    animate: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: {
        type: "spring",
        stiffness: 380,
        damping: 26,
      },
    },
    exit: {
      opacity: 0,
      y: position === "top" ? -16 : 16,
      scale: 0.95,
      transition: {
        duration: 0.22,
        ease: "easeInOut",
      },
    },
  };

  return (
    <div
      className={`fixed ${positionClasses} z-[9999] px-4 w-full max-w-md pointer-events-none`}
    >
      <AnimatePresence>
        {isOpen && (
          <motion.div
            id={id}
            data-testid={id}
            role="alert"
            aria-live="polite"
            variants={motionVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border ${border} ${bg} p-4 text-white shadow-2xl ${glow} backdrop-blur-md transition-colors`}
          >
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconBg}`}
            >
              <Icon className="h-4 w-4" />
            </div>

            <div className="flex-1 min-w-0 pt-0.5">
              {message && (
                <h4
                  className={`text-sm font-semibold tracking-tight leading-snug ${titleColor}`}
                >
                  {message}
                </h4>
              )}
              {description && (
                <p className="mt-1 text-xs text-white/70 leading-relaxed break-words">
                  {description}
                </p>
              )}

              {action && (
                <button
                  type="button"
                  onClick={action.onClick}
                  className="mt-2.5 inline-flex items-center text-xs font-semibold text-[#9680dc] hover:text-[#b4a4ee] underline underline-offset-4 transition"
                >
                  {action.label}
                </button>
              )}
            </div>

            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close notification"
                className="shrink-0 -mr-1 -mt-1 p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default MotionToast;
