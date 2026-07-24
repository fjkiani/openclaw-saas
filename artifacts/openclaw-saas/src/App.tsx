import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useAuth, useUser } from "@clerk/react";
import { registerClerkTokenGetter } from "@/lib/apiFetch";
import { setAuthTokenGetter, setUserIdGetter } from "@workspace/api-client-react";
import { shadcn } from "@clerk/themes";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import LandingPage from "@/pages/landing";
import DashboardPage from "@/pages/dashboard";
import AgentsPage from "@/pages/agents/index";
import AgentDetailPage from "@/pages/agents/[id]";
import SkillsPage from "@/pages/skills";
import BillingPage from "@/pages/billing";
import ZoaPage from "@/pages/zoa";
import ForgePage from "@/pages/forge/index";
import ForgeWorkspacePage from "@/pages/forge/workspace";
import VerticalPickerPage from "@/pages/onboarding/vertical-picker";
import SetupPage from "@/pages/onboarding/setup";
import StartupCounselPage from "@/pages/startup-counsel";
import AgentRobustnessPage from "@/pages/agent-robustness";
import McpsPage from "@/pages/mcps";
import MlOpsPage from "@/pages/mlops";
import JudgePage from "@/pages/intelligence/judge";
import BenchmarkPage from "@/pages/intelligence/benchmark";
import PromotionPage from "@/pages/intelligence/promotion";
import RouterLoopPage from "@/pages/router-loop";
import LoopPlaygroundPage from "@/pages/loop-playground";
import AgentConsolePage from "@/pages/agent-console";
import KriosPage from "@/pages/krios";
import CertifyPage from "@/pages/certify";

const queryClient = new QueryClient();

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
// Clerk proxy only works with production instances (pk_live_).
// Dev instances (pk_test_) use a direct __dev_browser cookie flow that cannot be proxied.
const clerkProxyUrl = clerkPubKey?.startsWith('pk_live_')
  ? (import.meta.env.VITE_CLERK_PROXY_URL as string | undefined)
  : undefined;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Auth is optional — app runs in demo mode when Clerk key is not configured.
// Set VITE_CLERK_PUBLISHABLE_KEY=pk_live_... to enable full auth.
const clerkEnabled = typeof clerkPubKey === "string" && clerkPubKey.startsWith("pk_");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(199 89% 48%)",
    colorForeground: "hsl(210 40% 98%)",
    colorMutedForeground: "hsl(215 20.2% 65.1%)",
    colorDanger: "hsl(0 62.8% 30.6%)",
    colorBackground: "hsl(222 47% 8%)",
    colorInput: "hsl(222 47% 6%)",
    colorInputForeground: "hsl(210 40% 98%)",
    colorNeutral: "hsl(217 33% 17%)",
    fontFamily: "Inter, sans-serif",
    borderRadius: "0.25rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-card rounded-md w-[440px] max-w-full overflow-hidden border border-border",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground font-mono tracking-tight",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButtonText: "text-foreground font-mono",
    formFieldLabel: "text-foreground font-mono",
    footerActionLink: "text-primary hover:text-primary/80 font-mono",
    footerActionText: "text-muted-foreground font-mono",
    dividerText: "text-muted-foreground",
    identityPreviewEditButton: "text-primary",
    formFieldSuccessText: "text-green-500",
    alertText: "text-destructive-foreground",
    logoBox: "flex justify-center mb-4 text-primary",
    logoImage: "w-12 h-12 object-contain",
    socialButtonsBlockButton: "border-border hover:bg-secondary text-foreground",
    formButtonPrimary: "bg-primary text-primary-foreground hover:bg-primary/90 font-mono font-bold",
    formFieldInput: "bg-background border-border text-foreground focus:ring-primary focus:border-primary font-mono",
    footerAction: "bg-transparent",
    dividerLine: "bg-border",
    alert: "bg-destructive border-destructive text-destructive-foreground",
    otpCodeFieldInput: "border-border text-foreground font-mono",
    formFieldRow: "mb-4",
    main: "p-6",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        fallbackRedirectUrl={`${basePath}/dashboard`}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        fallbackRedirectUrl={`${basePath}/onboarding`}
      />
    </div>
  );
}

// Registers Clerk's getToken() + userId as auth suppliers for all apiFetch calls.
// Must be rendered inside <ClerkProvider>.
// userId is injected into request bodies as a fallback for dev instances
// deployed cross-origin where token refresh CORS blocks Bearer auth.
function ClerkTokenSync() {
  const { getToken } = useAuth();
  const { user } = useUser();

  // IMPORTANT: Register getters synchronously during render — NOT in useEffect.
  // useEffect runs after the first render, so any queries that fire on mount
  // (useListForgeWorkspaces, useGetForgeWorkspace, etc.) would have no userId
  // on the first call, causing 403s. Calling these synchronously ensures the
  // getters are set before any child component queries fire.
  // These are pure module-level variable assignments — safe to call during render.
  const tokenGetter = () => getToken();
  const userIdGetter = () => user?.id ?? null;
  registerClerkTokenGetter(tokenGetter, userIdGetter);
  setAuthTokenGetter(tokenGetter);
  setUserIdGetter(userIdGetter);

  return null;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

// ── Demo-mode stub shown when Clerk is not configured ────────────────────────
function DemoAuthNotice() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="max-w-md w-full border border-border rounded-lg p-8 text-center space-y-4">
        <div className="text-2xl font-mono font-bold text-primary">OpenClaw</div>
        <p className="text-muted-foreground text-sm">
          Auth is not yet configured. Set{" "}
          <code className="bg-muted px-1 rounded text-xs">VITE_CLERK_PUBLISHABLE_KEY</code>{" "}
          in the Render dashboard to enable sign-in.
        </p>
        <p className="text-muted-foreground text-xs">
          Legal analysis tools are available without auth — navigate directly to{" "}
          <a href="/forge" className="text-primary underline">/forge</a>.
        </p>
      </div>
    </div>
  );
}

// ── Auth-aware wrappers ───────────────────────────────────────────────────────

function HomeRedirect() {
  if (!clerkEnabled) return <LandingPage />;
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <LandingPage />
      </Show>
    </>
  );
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  // No Clerk — render the component directly (demo mode, no auth gate)
  if (!clerkEnabled) return <Component />;
  return (
    <>
      <Show when="signed-in">
        <Component />
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

// ── Routes (shared between Clerk and no-Clerk modes) ─────────────────────────

function AppRoutes() {
  return (
    <QueryClientProvider client={queryClient}>
      {clerkEnabled && <ClerkTokenSync />}
      {clerkEnabled && <ClerkQueryClientCacheInvalidator />}
      <Switch>
        <Route path="/" component={HomeRedirect} />
        <Route path="/sign-in/*?">{clerkEnabled ? <SignInPage /> : <DemoAuthNotice />}</Route>
        <Route path="/sign-up/*?">{clerkEnabled ? <SignUpPage /> : <DemoAuthNotice />}</Route>
        <Route path="/dashboard"><ProtectedRoute component={DashboardPage} /></Route>
        <Route path="/agents"><ProtectedRoute component={AgentsPage} /></Route>
        <Route path="/agents/:id"><ProtectedRoute component={AgentDetailPage} /></Route>
        <Route path="/skills"><ProtectedRoute component={SkillsPage} /></Route>
        <Route path="/billing"><ProtectedRoute component={BillingPage} /></Route>
        <Route path="/zoa"><ProtectedRoute component={ZoaPage} /></Route>
        <Route path="/forge"><ProtectedRoute component={ForgePage} /></Route>
        <Route path="/forge/:wid/:tab?"><ProtectedRoute component={ForgeWorkspacePage} /></Route>
        <Route path="/onboarding"><ProtectedRoute component={VerticalPickerPage} /></Route>
        <Route path="/onboarding/setup"><ProtectedRoute component={SetupPage} /></Route>
        <Route path="/startup-counsel"><ProtectedRoute component={StartupCounselPage} /></Route>
        <Route path="/agent-robustness"><ProtectedRoute component={AgentRobustnessPage} /></Route>
        <Route path="/router-loop"><ProtectedRoute component={RouterLoopPage} /></Route>
        <Route path="/loop-playground"><ProtectedRoute component={LoopPlaygroundPage} /></Route>
        <Route path="/agent-console"><ProtectedRoute component={AgentConsolePage} /></Route>
        <Route path="/krios"><ProtectedRoute component={KriosPage} /></Route>
        <Route path="/certify"><ProtectedRoute component={CertifyPage} /></Route>
        {/* Legacy routes kept reachable by deep-link during transition; not in sidebar. */}
        <Route path="/mcps"><ProtectedRoute component={McpsPage} /></Route>
        <Route path="/mlops"><ProtectedRoute component={MlOpsPage} /></Route>
        <Route path="/intelligence/judge"><ProtectedRoute component={JudgePage} /></Route>
        <Route path="/intelligence/benchmark"><ProtectedRoute component={BenchmarkPage} /></Route>
        <Route path="/intelligence/promotion"><ProtectedRoute component={PromotionPage} /></Route>
        <Route component={NotFound} />
      </Switch>
    </QueryClientProvider>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  if (!clerkEnabled) {
    // No valid Clerk key — render without ClerkProvider
    return <AppRoutes />;
  }

  return (
    <ClerkProvider
      publishableKey={clerkPubKey!}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Authenticate",
            subtitle: "Access your OpenClaw instances",
          },
        },
        signUp: {
          start: {
            title: "Provision Account",
            subtitle: "Initialize your workspace",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <AppRoutes />
    </ClerkProvider>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
