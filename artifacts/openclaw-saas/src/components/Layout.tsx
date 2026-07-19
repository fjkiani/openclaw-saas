import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useUser, useClerk } from "@clerk/react";

// Safe wrappers — return null/no-op when rendered outside <ClerkProvider> (e.g. dev without Clerk key).
function useSafeUser() {
  try { return useUser(); } catch { return { user: null, isLoaded: false, isSignedIn: false }; }
}
function useSafeClerk() {
  try { return useClerk(); } catch { return { signOut: () => Promise.resolve() } as ReturnType<typeof useClerk>; }
}
import {
  LayoutDashboard,
  Bot,
  Zap,
  CreditCard,
  LogOut,
  ChevronRight,
  Activity,
  FlaskConical,
  Puzzle,
  Sun,
  Moon,
  Scale,
  LineChart,
} from "lucide-react";

const navItems = [
  { href: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/agents", icon: Bot, label: "Agents" },
  { href: "/skills", icon: Zap, label: "Skills" },
  { href: "/zoa", icon: Zap, label: "ZOA" },
  { href: "/forge", icon: FlaskConical, label: "Model Forge" },
  { href: "/agent-robustness", icon: Activity, label: "Robustness" },
  { href: "/mcps", icon: Puzzle, label: "MCP Registry" },
  { href: "/mlops", icon: LineChart, label: "MLOps" },
  { href: "/startup-counsel", icon: Scale, label: "Counsel" },
  { href: "/billing", icon: CreditCard, label: "Billing" },
];

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    return (localStorage.getItem("oc-theme") as "dark" | "light") ?? "dark";
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light") {
      root.classList.remove("dark");
      root.classList.add("light");
    } else {
      root.classList.remove("light");
      root.classList.add("dark");
    }
    localStorage.setItem("oc-theme", theme);
  }, [theme]);
  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return { theme, toggle };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { user } = useSafeUser();
  const { signOut } = useSafeClerk();
  const { theme, toggle } = useTheme();

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <aside className="w-56 flex-shrink-0 border-r border-border bg-card flex flex-col">
        <div className="h-14 flex items-center px-4 border-b border-border">
          <img src="/logo.svg" alt="OpenClaw" className="w-7 h-7 mr-2" />
          <span className="font-mono font-bold text-foreground tracking-tight">OpenClaw</span>
          <span className="ml-1.5 text-[10px] font-mono bg-primary/10 text-primary border border-primary/20 px-1 rounded">BETA</span>
        </div>
        <nav className="flex-1 py-4 px-2 space-y-0.5" data-testid="nav-sidebar">
          {navItems.map(({ href, icon: Icon, label }) => {
            const active = location === href || location.startsWith(href + "/");
            return (
              <Link key={href} href={href} className={`flex items-center gap-2.5 px-3 py-2 rounded text-sm font-mono transition-colors ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}`} data-testid={`nav-${label.toLowerCase()}`}>
                <Icon className="w-4 h-4 shrink-0" />
                {label}
                {active && <ChevronRight className="w-3 h-3 ml-auto" />}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border p-3">
          <button
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-pressed={theme === "light"}
            role="switch"
            className="w-full flex items-center gap-2 px-2 py-1.5 text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded transition-colors mb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            data-testid="button-theme-toggle"
          >
            {theme === "dark" ? <Sun className="w-3 h-3 shrink-0" aria-hidden="true" /> : <Moon className="w-3 h-3 shrink-0" aria-hidden="true" />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded bg-primary/20 flex items-center justify-center">
              <span className="text-xs font-mono text-primary font-bold">
                {user?.firstName?.[0] ?? user?.emailAddresses?.[0]?.emailAddress?.[0]?.toUpperCase() ?? "U"}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono text-foreground truncate" data-testid="text-username">{user?.firstName ?? "User"}</p>
              <p className="text-[10px] font-mono text-muted-foreground truncate">{user?.emailAddresses?.[0]?.emailAddress ?? ""}</p>
            </div>
          </div>
          <button onClick={() => signOut({ redirectUrl: "/" })} className="w-full flex items-center gap-2 px-2 py-1.5 text-xs font-mono text-muted-foreground hover:text-foreground hover:bg-secondary/50 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" data-testid="button-signout">
            <LogOut className="w-3 h-3" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto" data-testid="main-content">{children}</main>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border">
      <div>
        <h1 className="text-lg font-mono font-bold text-foreground tracking-tight">{title}</h1>
        {subtitle && <p className="text-xs font-mono text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    running: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    stopped: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
    provisioning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    error: "bg-red-500/10 text-red-400 border-red-500/20",
  };
  const dots: Record<string, string> = {
    running: "bg-emerald-400",
    stopped: "bg-zinc-400",
    provisioning: "bg-amber-400 animate-pulse",
    error: "bg-red-400",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono border ${styles[status] ?? styles.stopped}`} data-testid={`status-${status}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dots[status] ?? dots.stopped}`} aria-hidden="true" />
      {status.toUpperCase()}
    </span>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: React.ComponentType<{ className?: string }>; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-12 h-12 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mb-4" aria-hidden="true">
        <Icon className="w-6 h-6 text-primary" />
      </div>
      <h3 className="text-sm font-mono font-bold text-foreground mb-1">{title}</h3>
      <p className="text-xs font-mono text-muted-foreground max-w-xs mb-4">{description}</p>
      {action}
    </div>
  );
}

export function ActivityIcon({ type }: { type: string }) {
  const map: Record<string, string> = {
    agent_started: "text-emerald-400",
    agent_stopped: "text-zinc-400",
    skill_installed: "text-primary",
    skill_uninstalled: "text-amber-400",
    task_completed: "text-emerald-400",
    error: "text-red-400",
  };
  return <Activity className={`w-3 h-3 ${map[type] ?? "text-muted-foreground"}`} aria-hidden="true" />;
}
