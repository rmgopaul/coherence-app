import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/features/dashboard/NotFound";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { Suspense, lazy, useEffect, type ComponentType } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import GlobalFeedbackWidget from "./components/GlobalFeedbackWidget";
import GlobalClockifyTimer from "./components/GlobalClockifyTimer";
import PinGate from "./components/PinGate";
import TwoFactorGate from "./components/TwoFactorGate";
import { ThemeProvider } from "./contexts/ThemeContext";
import { FocusModeProvider } from "./contexts/FocusModeContext";
import { AppShell } from "./components/layout/AppShell";

const Home = lazy(() => import("@/features/dashboard/Home"));
const Dashboard = lazy(() => import("@/features/dashboard/Dashboard"));
const DashboardLegacy = lazy(() => import("@/features/dashboard/DashboardLegacy"));
const OneThing = lazy(() => import("@/features/dashboard/OneThing"));
const River = lazy(() => import("@/features/dashboard/River"));
const Canvas = lazy(() => import("@/features/dashboard/Canvas"));
const CommandDeck = lazy(() => import("@/features/dashboard/CommandDeck"));
// SolarRecDashboard is no longer lazy-loaded here — Task 5.5 (2026-04-26)
// retired the legacy /solar-rec-dashboard URL in favor of /solar-rec/
// dashboard on the standalone Solar REC app. The route below now
// redirects rather than rendering the page.
const InvoiceMatchDashboard = lazy(() => import("@/features/dashboard/InvoiceMatchDashboard"));
// Task 5.11 PR-A (2026-04-27): ZendeskTicketMetrics moved to the
// standalone Solar REC app. Legacy URL kept as a Wouter <Redirect />.
// Task 5.11 PR-C (2026-04-27): DeepUpdateSynthesizer same — moved to
// the standalone Solar REC app, legacy URL kept as <Redirect />.
// Task 5.7 PR-B (2026-04-26): ContractScanner + ContractScrapeManager
// migrated to the standalone Solar REC app. The legacy URLs below are
// kept as Wouter <Redirect /> targets so existing bookmarks land on
// the new routes after the bundle hydrates.
// Task 5.9 PR-A + 5.11 PR-B (2026-04-27): AbpInvoiceSettlement +
// AddressChecker also migrated; legacy URLs are <Redirect /> targets.
const DinScrapeManager = lazy(() => import("@/features/dashboard/DinScrapeManager"));
const EarlyPayment = lazy(() => import("@/features/dashboard/EarlyPayment"));
const Notebook = lazy(() => import("@/features/notebook/Notebook"));
const Settings = lazy(() => import("@/features/settings/Settings"));
const Supplements = lazy(() => import("@/features/supplements/Supplements"));
const Habits = lazy(() => import("@/features/habits/Habits"));
const Health = lazy(() => import("@/features/health/Health"));
const TodoistWidget = lazy(() => import("@/features/dashboard/TodoistWidget"));
const ClockifyWidget = lazy(() => import("@/features/dashboard/ClockifyWidget"));
const ChatGPTWidget = lazy(() => import("@/features/dashboard/ChatGPTWidget"));
const GoogleCalendarWidget = lazy(() => import("@/features/dashboard/GoogleCalendarWidget"));
const GmailWidget = lazy(() => import("@/features/dashboard/GmailWidget"));

const LEGACY_METER_READ_REDIRECTS = [
  { from: "/sunpower-readings", to: "/solar-rec/meter-reads/sunpower" },
  { from: "/enphase-v4-meter-reads", to: "/solar-rec/meter-reads/enphase-v4" },
  { from: "/solaredge-meter-reads", to: "/solar-rec/meter-reads/solaredge" },
  { from: "/fronius-meter-reads", to: "/solar-rec/meter-reads/fronius" },
  { from: "/ennexos-meter-reads", to: "/solar-rec/meter-reads/ennexos" },
  { from: "/egauge-api", to: "/solar-rec/meter-reads/egauge" },
  { from: "/tesla-powerhub-api", to: "/solar-rec/meter-reads/tesla-powerhub" },
  { from: "/solis-meter-reads", to: "/solar-rec/meter-reads/solis" },
  { from: "/goodwe-meter-reads", to: "/solar-rec/meter-reads/goodwe" },
  { from: "/generac-meter-reads", to: "/solar-rec/meter-reads/generac" },
  { from: "/locus-meter-reads", to: "/solar-rec/meter-reads/locus" },
  { from: "/growatt-meter-reads", to: "/solar-rec/meter-reads/growatt" },
  { from: "/apsystems-meter-reads", to: "/solar-rec/meter-reads/apsystems" },
  { from: "/ekm-meter-reads", to: "/solar-rec/meter-reads/ekm" },
  { from: "/hoymiles-meter-reads", to: "/solar-rec/meter-reads/hoymiles" },
  { from: "/solarlog-meter-reads", to: "/solar-rec/meter-reads/solarlog" },
] as const;

function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-sm text-muted-foreground">Loading page...</div>
    </div>
  );
}

function withRouteSuspense(Component: ComponentType) {
  return function SuspendedRouteComponent() {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Component />
      </Suspense>
    );
  };
}

function ExternalRedirect({ to }: { to: string }) {
  useEffect(() => {
    window.location.assign(to);
  }, [to]);

  return <RouteFallback />;
}

/** Routes that live inside the AppShell (sidebar + command palette). */
function AppRoutes() {
  return (
    <Switch>
      {LEGACY_METER_READ_REDIRECTS.map(({ from, to }) => (
        <Route key={from} path={from}>
          <ExternalRedirect to={to} />
        </Route>
      ))}
      <Route path={"/dashboard"} component={withRouteSuspense(Dashboard)} />
      <Route path={"/dashboard/one-thing"} component={withRouteSuspense(OneThing)} />
      <Route path={"/dashboard/river"} component={withRouteSuspense(River)} />
      <Route path={"/dashboard/canvas"} component={withRouteSuspense(Canvas)} />
      <Route path={"/dashboard/command"} component={withRouteSuspense(CommandDeck)} />
      <Route path={"/dashboard-legacy"} component={withRouteSuspense(DashboardLegacy)} />
      {/* Task 5.5 (2026-04-26): legacy /solar-rec-dashboard URL retired
          in favor of /solar-rec/dashboard on the standalone Solar REC
          app. Wouter is client-side only — the redirect runs as soon as
          the bundle hydrates and bookmarks land on the right URL. */}
      <Route path={"/solar-rec-dashboard"}>
        <Redirect to="/solar-rec/dashboard" />
      </Route>
      <Route path={"/invoice-match-dashboard"} component={withRouteSuspense(InvoiceMatchDashboard)} />
      <Route path={"/deep-update-synthesizer"}>
        <Redirect to="/solar-rec/deep-update-synthesizer" />
      </Route>
      <Route path={"/contract-scanner"}>
        <Redirect to="/solar-rec/contract-scanner" />
      </Route>
      <Route path={"/contract-scrape-manager"}>
        <Redirect to="/solar-rec/contract-scrape-manager" />
      </Route>
      <Route path={"/din-scrape-manager"} component={withRouteSuspense(DinScrapeManager)} />
      <Route path={"/abp-invoice-settlement"}>
        <Redirect to="/solar-rec/abp-invoice-settlement" />
      </Route>
      <Route path={"/early-payment"} component={withRouteSuspense(EarlyPayment)} />
      <Route path={"/address-checker"}>
        <Redirect to="/solar-rec/address-checker" />
      </Route>
      <Route path={"/zendesk-ticket-metrics"}>
        <Redirect to="/solar-rec/zendesk-ticket-metrics" />
      </Route>
      <Route path={"/notes"} component={withRouteSuspense(Notebook)} />
      <Route path={"/supplements"} component={withRouteSuspense(Supplements)} />
      <Route path={"/habits"} component={withRouteSuspense(Habits)} />
      <Route path={"/health"} component={withRouteSuspense(Health)} />
      <Route path={"/settings"} component={withRouteSuspense(Settings)} />
      <Route path={"/widget/todoist"} component={withRouteSuspense(TodoistWidget)} />
      <Route path={"/widget/clockify"} component={withRouteSuspense(ClockifyWidget)} />
      <Route path={"/widget/chatgpt"} component={withRouteSuspense(ChatGPTWidget)} />
      <Route path={"/widget/google-calendar"} component={withRouteSuspense(GoogleCalendarWidget)} />
      <Route path={"/widget/gmail"} component={withRouteSuspense(GmailWidget)} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

function Router() {
  const [location] = useLocation();

  // Landing page renders without the app shell
  if (location === "/") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Home />
      </Suspense>
    );
  }

  // All other routes render inside the app shell (sidebar + command palette)
  return (
    <FocusModeProvider>
      <AppShell>
        <AppRoutes />
        <GlobalClockifyTimer />
        <GlobalFeedbackWidget />
      </AppShell>
    </FocusModeProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="dark"
        switchable
      >
        <TooltipProvider>
          <Toaster />
          <PinGate>
            <TwoFactorGate>
              <Router />
            </TwoFactorGate>
          </PinGate>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
