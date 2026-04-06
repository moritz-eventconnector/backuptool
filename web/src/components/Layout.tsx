import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.tsx";
import { useQuery } from "@tanstack/react-query";
import {
  LayoutDashboard, Server, Briefcase, Camera, HardDrive,
  Key, Settings, LogOut, AlertTriangle, ClipboardList,
} from "lucide-react";
import logoFull from "../assets/logo-full.svg";
import { api } from "../api/client.ts";

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/agents", label: "Agents", icon: Server },
  { to: "/jobs", label: "Backup Jobs", icon: Briefcase },
  { to: "/snapshots", label: "Snapshots", icon: Camera },
  { to: "/destinations", label: "Destinations", icon: HardDrive },
  { to: "/license", label: "License", icon: Key },
  { to: "/audit-log", label: "Audit Log", icon: ClipboardList },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { data: setupStatus } = useQuery({
    queryKey: ["setup-status"],
    queryFn: api.getSetupStatus,
    enabled: user?.role === "admin",
  });

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* Sidebar */}
      <aside style={{
        width: 220, background: "var(--bg-card)", borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column", flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ padding: "16px", borderBottom: "1px solid var(--border)" }}>
          <img src={logoFull} alt="BackupTool" style={{ height: 44, width: "auto", display: "block" }} />
        </div>

        {/* Nav */}
        <nav className="sidebar-nav" style={{ flex: 1, padding: "12px 8px" }}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              className={({ isActive }) => isActive ? "active" : ""}
              style={{ marginBottom: 2 }}
            >
              <item.icon size={16} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* User footer */}
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
          <div style={{ fontSize: 13, marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <span style={{ color: "var(--text-muted)" }}>{user?.email}</span>
          </div>
          <button className="btn-ghost" style={{ width: "100%", justifyContent: "flex-start", display: "flex", alignItems: "center", gap: 8 }} onClick={handleLogout}>
            <LogOut size={14} /> Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
        {user?.role === "admin" && setupStatus && !setupStatus.setupCompleted && (
          <div style={{ background: "rgba(245,158,11,.12)", borderBottom: "1px solid rgba(245,158,11,.3)", padding: "8px 24px", display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
            <AlertTriangle size={14} color="var(--warning, #f59e0b)" />
            <span style={{ color: "var(--warning, #f59e0b)" }}>
              Setup is not complete.{" "}
              <button onClick={() => navigate("/onboarding")} style={{ background: "none", border: "none", color: "var(--warning, #f59e0b)", textDecoration: "underline", cursor: "pointer", padding: 0, fontSize: 13 }}>
                Continue setup wizard
              </button>
            </span>
          </div>
        )}
        <div style={{ flex: 1, padding: "28px 32px" }}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
