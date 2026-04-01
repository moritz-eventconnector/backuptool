import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext.tsx";
import Layout from "./components/Layout.tsx";
import Login from "./pages/Login.tsx";
import Setup from "./pages/Setup.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import Agents from "./pages/Agents.tsx";
import Jobs from "./pages/Jobs.tsx";
import Snapshots from "./pages/Snapshots.tsx";
import Destinations from "./pages/Destinations.tsx";
import LicensePage from "./pages/License.tsx";
import Settings from "./pages/Settings.tsx";
import { useEffect, useState } from "react";
import { api } from "./api/client.ts";

function AppRoutes() {
  const { user, loading } = useAuth();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);

  useEffect(() => {
    api.setupRequired().then((r) => setSetupRequired(r.setupRequired)).catch(() => setSetupRequired(false));
  }, []);

  if (loading || setupRequired === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}>
        <div className="spinner" />
      </div>
    );
  }

  if (setupRequired) {
    return (
      <Routes>
        <Route path="/setup" element={<Setup onComplete={() => setSetupRequired(false)} />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="agents" element={<Agents />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="snapshots" element={<Snapshots />} />
        <Route path="destinations" element={<Destinations />} />
        <Route path="license" element={<LicensePage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
