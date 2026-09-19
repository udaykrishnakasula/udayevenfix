import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import AppToaster from "@/shared/components/AppToaster";
import Hero from "@/components/landing/Hero";
import Sections from "@/components/landing/Sections";
import { AuthProvider } from "@/shared/context/AuthContext";
import { BrandingProvider } from "@/shared/context/BrandingContext";
import { DatabaseHealthProvider, useDatabaseHealth } from "@/shared/context/DatabaseHealthContext";
import { ServerUnavailableView } from "@/shared/components/ServerUnavailableView";
import { ProtectedRoute } from "@/shared/components/ProtectedRoute";
import ErrorBoundary from "@/shared/analytics/ErrorBoundary";
import AnalyticsProvider from "@/shared/analytics/AnalyticsProvider";
import LoginPage from "@/shared/auth/LoginPage";
import RegisterPage from "@/shared/auth/RegisterPage";
import ForgotPasswordPage from "@/shared/auth/ForgotPasswordPage";
import VerifyEmailPage from "@/shared/auth/VerifyEmailPage";
import UserRoutes from "@/user/routes/UserRoutes";
import AdminRoutes from "@/admin/routes/AdminRoutes";
import GlobalKeyboardShortcuts from "@/shared/components/GlobalKeyboardShortcuts";
import NetworkStatusBanner from "@/shared/components/NetworkStatusBanner";
import { useAuth } from "@/shared/context/AuthContext";

const Landing = () => (
  <main data-testid="landing-page">
    <Hero />
    <Sections />
  </main>
);

function RootRoute() {
  const { user, loading, authState, isAdmin, refresh } = useAuth();
  const { isDatabaseHealthy, databaseError, checkReadiness } = useDatabaseHealth();

  const handleRetry = async () => {
    const res = await checkReadiness(true);
    if (res.ready) {
      await refresh();
    }
  };

  // 1. If database is unhealthy and user has a token or is authenticated, show server unavailable
  if (!isDatabaseHealthy && (user || (typeof localStorage !== "undefined" && localStorage.getItem("easyx_token")))) {
    return (
      <ServerUnavailableView
        onRetry={handleRetry}
        errorDetail={databaseError}
      />
    );
  }

  if (loading || authState === "INITIALIZING") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0d0b14]">
        <div className="h-8 w-8 rounded-full border-2 border-white/20 border-t-white animate-spin" />
      </div>
    );
  }

  // 2. If session verification failed due to network / 503 error
  if (authState === "AUTH_ERROR") {
    return (
      <ServerUnavailableView
        onRetry={handleRetry}
        errorDetail={databaseError}
      />
    );
  }

  if (user) {
    return <Navigate to={isAdmin ? "/admin" : "/dashboard"} replace />;
  }

  return <Landing />;
}

function WildcardRoute() {
  const { user, loading, authState, isAdmin } = useAuth();
  const { isDatabaseHealthy } = useDatabaseHealth();
  if (loading || authState === "INITIALIZING") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0d0b14]">
        <div className="h-8 w-8 rounded-full border-2 border-white/20 border-t-white animate-spin" />
      </div>
    );
  }
  if (user && isDatabaseHealthy) {
    return <Navigate to={isAdmin ? "/admin" : "/dashboard"} replace />;
  }
  return <Navigate to="/" replace />;
}

function DatabaseConnectionGuard({ children }) {
  const { isDatabaseHealthy, isChecking, checkReadiness } = useDatabaseHealth();

  if (isChecking) {
    return (
      <div
        id="server-connecting-screen"
        data-testid="server-connecting-screen"
        className="min-h-screen flex flex-col items-center justify-center bg-[#0d0b14] text-white px-4"
      >
        <div className="h-8 w-8 rounded-full border-2 border-white/20 border-t-[#9680dc] animate-spin mb-4" />
        <p className="text-sm font-medium text-white/80 tracking-wide">
          Connecting to server...
        </p>
      </div>
    );
  }

  if (!isDatabaseHealthy) {
    return <ServerUnavailableView onRetry={() => checkReadiness(true)} />;
  }

  return children;
}

function App() {
  return (
    <div className="App">
      <ErrorBoundary>
        <BrowserRouter>
          <DatabaseHealthProvider>
            <DatabaseConnectionGuard>
              <AuthProvider>
                <BrandingProvider>
                  <AnalyticsProvider>
                    <Routes>
                    {/* Public Landing & Authentication */}
                    <Route path="/" element={<RootRoute />} />
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/register" element={<RegisterPage />} />
                    <Route path="/verify-email" element={<VerifyEmailPage />} />
                    <Route path="/forgot-password" element={<ForgotPasswordPage />} />
                    <Route path="/reset-password" element={<ForgotPasswordPage />} />

                    {/* Legacy /app paths backwards-compatibility redirect */}
                    <Route path="/app" element={<Navigate to="/dashboard" replace />} />
                    <Route path="/app/*" element={<Navigate to="/dashboard" replace />} />

                    {/* Admin Application Architecture (/admin/*) */}
                    <Route
                      path="/admin/*"
                      element={
                        <ProtectedRoute adminOnly>
                          <AdminRoutes />
                        </ProtectedRoute>
                      }
                    />

                    {/* User Application Architecture (/dashboard, /investments, /wallet, etc.) */}
                    <Route
                      path="/*"
                      element={
                        <ProtectedRoute>
                          <UserRoutes />
                        </ProtectedRoute>
                      }
                    />

                    <Route path="*" element={<WildcardRoute />} />
                  </Routes>
                  <GlobalKeyboardShortcuts />
                  <NetworkStatusBanner />
                </AnalyticsProvider>
              </BrandingProvider>
            </AuthProvider>
          </DatabaseConnectionGuard>
          <AppToaster />
        </DatabaseHealthProvider>
      </BrowserRouter>
      </ErrorBoundary>
    </div>
  );
}

export default App;
