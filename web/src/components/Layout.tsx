import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.tsx";
import {
  LayoutDashboard, Server, Briefcase, Camera, HardDrive,
  Key, Settings, LogOut,
} from "lucide-react";
import logoFull from "../assets/logo-full.svg";

const navItems = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/agents", label: "Agents", icon: Server },
  { to: "/jobs", label: "Backup Jobs", icon: Briefcase },
  { to: "/snapshots", label: "Snapshots", icon: Camera },
  { to: "/destinations", label: "Destinations", icon: HardDrive },
  { to: "/license", label: "License", icon: Key },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

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
      <main style={{ flex: 1, padding: "28px 32px", overflow: "auto" }}>
        <Outlet />
      </main>
    </div>
  );
}
