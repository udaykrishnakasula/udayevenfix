import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import api from "@/shared/lib/api";

const DatabaseHealthContext = createContext({
  isDatabaseHealthy: true,
  isChecking: false,
  databaseError: null,
  checkReadiness: async () => ({ ready: true }),
  markUnhealthy: () => {},
});

export function DatabaseHealthProvider({ children }) {
  const [isDatabaseHealthy, setIsDatabaseHealthy] = useState(true);
  const [isChecking, setIsChecking] = useState(true);
  const [databaseError, setDatabaseError] = useState(null);
  const checkingRef = useRef(false);

  const checkReadiness = useCallback(async (force = false) => {
    if (checkingRef.current) return { ready: isDatabaseHealthy };
    checkingRef.current = true;
    setIsChecking(true);

    try {
      const { data } = await api.get(`/health/readiness${force ? "?force=true" : ""}`, {
        // Shorter timeout for health check so UI reacts swiftly
        timeout: 10000,
      });

      if (data && data.ready) {
        setIsDatabaseHealthy(true);
        setDatabaseError(null);
        return { ready: true };
      } else {
        setIsDatabaseHealthy(false);
        const err = data?.detail || data?.message || "Server temporarily unavailable. Please try again later.";
        setDatabaseError(err);
        return { ready: false, error: err };
      }
    } catch (err) {
      setIsDatabaseHealthy(false);
      const detail =
        err?.response?.data?.detail ||
        err?.response?.data?.message ||
        "Server temporarily unavailable. Please try again later.";
      setDatabaseError(detail);
      return { ready: false, error: detail };
    } finally {
      checkingRef.current = false;
      setIsChecking(false);
    }
  }, [isDatabaseHealthy]);

  const markUnhealthy = useCallback((errMessage) => {
    setIsDatabaseHealthy(false);
    setDatabaseError(errMessage || "Server temporarily unavailable. Please try again later.");
  }, []);

  // Initial readiness check
  useEffect(() => {
    checkReadiness(false);
  }, [checkReadiness]);

  // Listen for 503 responses triggered by any API call during runtime
  useEffect(() => {
    const handleUnavailable = (event) => {
      const err = event?.detail?.error || "Server temporarily unavailable. Please try again later.";
      setIsDatabaseHealthy(false);
      setDatabaseError(err);
    };

    window.addEventListener("easyx:database_unavailable", handleUnavailable);
    return () => {
      window.removeEventListener("easyx:database_unavailable", handleUnavailable);
    };
  }, []);

  return (
    <DatabaseHealthContext.Provider
      value={{
        isDatabaseHealthy,
        isChecking,
        databaseError,
        checkReadiness,
        markUnhealthy,
      }}
    >
      {children}
    </DatabaseHealthContext.Provider>
  );
}

export function useDatabaseHealth() {
  return useContext(DatabaseHealthContext);
}

export default DatabaseHealthContext;
