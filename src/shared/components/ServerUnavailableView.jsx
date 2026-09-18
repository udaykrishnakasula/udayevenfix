import React, { useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export function ServerUnavailableView({ onRetry, isRetrying: externalRetrying = false, errorDetail = null }) {
  const [internalRetrying, setInternalRetrying] = useState(false);

  const retrying = externalRetrying || internalRetrying;

  const handleRetry = async () => {
    if (retrying) return;
    setInternalRetrying(true);
    try {
      if (onRetry) {
        await onRetry();
      } else {
        window.location.reload();
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

        <h1 className="text-xl font-bold text-white tracking-tight">
          Server temporarily unavailable. Please try again later.
        </h1>

        <p className="mt-3 text-sm text-white/60 leading-relaxed">
          The database connection is currently unavailable or experiencing maintenance. All protected operations are paused to protect account data.
        </p>

        {errorDetail && process.env.NODE_ENV === "development" && (
          <div className="mt-4 p-3 rounded-lg bg-red-950/40 border border-red-800/40 text-left text-xs font-mono text-red-300 break-words">
            {errorDetail}
          </div>
        )}

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
            {retrying ? "Checking connection..." : "Retry"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ServerUnavailableView;
