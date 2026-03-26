import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, useLocation } from "wouter";
import { Suspense, lazy, type ComponentType } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import GlobalFeedbackWidget from "./components/GlobalFeedbackWidget";
import GlobalClockifyTimer from "./components/GlobalClockifyTimer";
import PinGate from "./components/PinGate";
import TwoFactorGate from "./components/TwoFactorGate";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AppShell } from "./components/layout/AppShell";

const Home = lazy(() => import("./pages/Home"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const SolarRecDashboard = lazy(() => import("./pages/SolarRecDashboard"));
const InvoiceMatchDashboard = lazy(() => import("./pages/InvoiceMatchDashboard"));
const EnphaseV2MeterReads = lazy(() => import("./pages/EnphaseV2MeterReads"));
const SolarEdgeMeterReads = lazy(() => import("./pages/SolarEdgeMeterReads"));
const FroniusMeterReads = lazy(() => import("./pages/FroniusMeterReads"));
const EnnexOsMeterReads = lazy(() => import("./pages/EnnexOsMeterReads"));
const TeslaSolarApi = lazy(() => import("./pages/TeslaSolarApi"));
const TeslaPowerhubApi = lazy(() => import("./pages/TeslaPowerhubApi"));
const ZendeskTicketMetrics = lazy(() => import("./pages/ZendeskTicketMetrics"));
const DeepUpdateSynthesizer = lazy(() => import("./pages/DeepUpdateSynthesizer"));
const ContractScanner = lazy(() => import("./pages/ContractScanner"));
const AbpInvoiceSettlement = lazy(() => import("./pages/AbpInvoiceSettlement"));
const Notebook = lazy(() => import("./pages/Notebook"));
const Settings = lazy(() => import("./pages/Settings"));
const TodoistWidget = lazy(() => import("./pages/TodoistWidget"));
const ClockifyWidget = lazy(() => import("./pages/ClockifyWidget"));
const ChatGPTWidget = lazy(() => import("./pages/ChatGPTWidget"));
const GoogleCalendarWidget = lazy(() => import("./pages/GoogleCalendarWidget"));
const GmailWidget = lazy(() => import("./pages/GmailWidget"));

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

/** Routes that live inside the AppShell (sidebar + command palette). */
function AppRoutes() {
  return (
    <Switch>
      <Route path={"/dashboard"} component={withRouteSuspense(Dashboard)} />
      <Route path={"/solar-rec-dashboard"} component={withRouteSuspense(SolarRecDashboard)} />
      <Route path={"/invoice-match-dashboard"} component={withRouteSuspense(InvoiceMatchDashboard)} />
      <Route path={"/deep-update-synthesizer"} component={withRouteSuspense(DeepUpdateSynthesizer)} />
      <Route path={"/contract-scanner"} component={withRouteSuspense(ContractScanner)} />
      <Route path={"/abp-invoice-settlement"} component={withRouteSuspense(AbpInvoiceSettlement)} />
      <Route path={"/enphase-v4-meter-reads"} component={withRouteSuspense(EnphaseV2MeterReads)} />
      <Route path={"/enphase-v2-meter-reads"} component={withRouteSuspense(EnphaseV2MeterReads)} />
      <Route path={"/solaredge-meter-reads"} component={withRouteSuspense(SolarEdgeMeterReads)} />
      <Route path={"/fronius-meter-reads"} component={withRouteSuspense(FroniusMeterReads)} />
      <Route path={"/ennexos-meter-reads"} component={withRouteSuspense(EnnexOsMeterReads)} />
      <Route path={"/tesla-solar-api"} component={withRouteSuspense(TeslaSolarApi)} />
      <Route path={"/tesla-powerhub-api"} component={withRouteSuspense(TeslaPowerhubApi)} />
      <Route path={"/zendesk-ticket-metrics"} component={withRouteSuspense(ZendeskTicketMetrics)} />
      <Route path={"/notes"} component={withRouteSuspense(Notebook)} />
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
    <AppShell>
      <AppRoutes />
      <GlobalClockifyTimer />
      <GlobalFeedbackWidget />
    </AppShell>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
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
