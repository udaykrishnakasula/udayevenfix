import React, { useState, useEffect } from "react";
import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { toast } from "sonner";
import MotionToast from "@/shared/components/MotionToast";

export function ServerUnavailableView({ onRetry, isRetrying: externalRetrying = false, errorDetail = null }) {
  const [internalRetrying, setInternalRetrying] = useState(false);
  const [showHealthToast, setShowHealthToast] = useState(true);

  const retrying = externalRetrying || internalRetrying;

  useEffect(() => {
    // Show subtle health check failure toast on mount
    setShowHealthToast(true);

    // If mounted while already offline, trigger subtle toast
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      toast.error("Network connection lost", {
        id: "server-unavailable-offline-toast",
        description: "Please check your internet connection.",
        icon: <WifiOff className="h-4 w-4 text-rose-400" />,
        duration: 4000,
      });
    }

    const handleOffline = () => {
      toast.error("Network connection lost", {
        id: "server-unavailable-offline-toast",
        description: "Please check your internet connection.",
        icon: <WifiOff className="h-4 w-4 text-rose-400" />,
        duration: 4000,
      });
    };

    const handleOnline = () => {
      toast.success("Network connection restored", {
        id: "server-unavailable-offline-toast",
        duration: 3000,
      });
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  const handleRetry = async () => {
    if (retrying) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      toast.error("Network connection lost", {
        id: "server-unavailable-offline-toast",
        description: "Please check your internet connection.",
        icon: <WifiOff className="h-4 w-4 text-rose-400" />,
        duration: 4000,
      });
      return;
    }
    setInternalRetrying(true);
    try {
      if (onRetry) {
        const res = await onRetry();
        if (res && !res.ready) {
          setShowHealthToast(true);
        }
      } else {
        window.location.reload();
      }
    } catch {
      setShowHealthToast(true);
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        toast.error("Network connection lost", {
          id: "server-unavailable-offline-toast",
          description: "Please check your internet connection.",
          icon: <WifiOff className="h-4 w-4 text-rose-400" />,
          duration: 4000,
        });
      }
    } finally {
      setInternalRetrying(false);
    }
  };

  return (
    <div
      id="server-unavailable-screen"
      data-testid="server-unavailable-screen"
      className="min-h-screen flex items-center justify-center bg-[#0d0b14] px-4"
    >
      <div className="max-w-md w-full rounded-2xl border border-white/10 bg-[#161424] p-8 text-center shadow-2xl">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/10 text-amber-400 mb-5">
          <AlertTriangle className="h-7 w-7 text-amber-400" />
        </div>

        <h1 className="text-2xl font-bold text-white tracking-tight">
          Server temporarily unavailable.
        </h1>

        <p className="mt-2 text-base text-white/70 leading-relaxed">
          Please try again later.
        </p>

        <div className="mt-7">
          <button
            id="retry-button"
            data-testid="retry-button"
            type="button"
            onClick={handleRetry}
            disabled={retrying}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#9680dc] px-5 py-3 text-sm font-semibold text-white hover:bg-[#856ecf] active:scale-[0.98] transition shadow-lg shadow-purple-900/30 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`h-4 w-4 ${retrying ? "animate-spin" : ""}`} />
            {retrying ? "Connecting to server..." : "Retry Connection"}
          </button>
        </div>
      </div>

      <MotionToast
        id="health-check-failed-toast"
        isOpen={showHealthToast}
        onClose={() => setShowHealthToast(false)}
        position="bottom"
        type="error"
        duration={6000}
        message="Health check failed"
        description="Database connection unavailable. System paused to protect transactions."
        action={{
          label: "Retry Connection",
          onClick: handleRetry,
        }}
      />
    </div>
  );
}

export default ServerUnavailableView;
