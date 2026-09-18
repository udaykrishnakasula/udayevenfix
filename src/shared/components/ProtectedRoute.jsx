import React, { useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { useAuth } from "@/shared/context/AuthContext";
import { useDatabaseHealth } from "@/shared/context/DatabaseHealthContext";
import { ServerUnavailableView } from "@/shared/components/ServerUnavailableView";

function FullScreenLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0d0b14]">
      <div className="h-8 w-8 rounded-full border-2 border-white/20 border-t-white animate-spin" />
    </div>
  );
}

export function ProtectedRoute({ children, adminOnly = false }) {
  const { user, loading, authState, isAdmin, refresh } = useAuth();
  const { isDatabaseHealthy, databaseError, checkReadiness } = useDatabaseHealth();
  const location = useLocation();
  const warnedRef = useRef(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!loading && user && adminOnly && !isAdmin && !warnedRef.current) {
      warnedRef.current = true;
      toast.error("403 Forbidden: Admin privileges required. Redirected to User Dashboard.");
    }
  }, [loading, user, adminOnly, isAdmin]);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await checkReadiness(true);
      if (res.ready) {
        await refresh();
      }
    } finally {
      setRetrying(false);
    }
  };

  // 1. Fail-closed check: if database is unhealthy or unreachable, show Server Unavailable screen immediately
  if (!isDatabaseHealthy) {
    return (
      <ServerUnavailableView
        onRetry={handleRetry}
        isRetrying={retrying}
        errorDetail={databaseError}
      />
    );
  }

  if (loading || authState === "INITIALIZING") {
    return <FullScreenLoader />;
  }

  // 2. If authentication failed due to database/server unavailable or network error
  if (authState === "AUTH_ERROR") {
    return (
      <ServerUnavailableView
        onRetry={handleRetry}
        isRetrying={retrying}
        errorDetail={databaseError}
      />
    );
  }

  if (!user || authState === "UNAUTHENTICATED") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (adminOnly && !isAdmin) return <Navigate to="/dashboard" replace />;
  return children;
}

export default ProtectedRoute;
