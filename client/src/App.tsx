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
const EGaugeApi = lazy(() => import("./pages/EGaugeApi"));
const TeslaSolarApi = lazy(() => import("./pages/TeslaSolarApi"));
const TeslaPowerhubApi = lazy(() => import("./pages/TeslaPowerhubApi"));
const ZendeskTicketMetrics = lazy(() => import("./pages/ZendeskTicketMetrics"));
const DeepUpdateSynthesizer = lazy(() => import("./pages/DeepUpdateSynthesizer"));
const ContractScanner = lazy(() => import("./pages/ContractScanner"));
const ContractScrapeManager = lazy(() => import("./pages/ContractScrapeManager"));
const AbpInvoiceSettlement = lazy(() => import("./pages/AbpInvoiceSettlement"));
const EarlyPayment = lazy(() => import("./pages/EarlyPayment"));
const AddressChecker = lazy(() => import("./pages/AddressChecker"));
const SunpowerReadings = lazy(() => import("./pages/SunpowerReadings"));
const Notebook = lazy(() => import("./pages/Notebook"));
const Settings = lazy(() => import("./pages/Settings"));
const TodoistWidget = lazy(() => import("./pages/TodoistWidget"));
const ClockifyWidget = lazy(() => import("./pages/ClockifyWidget"));
const ChatGPTWidget = lazy(() => import("./pages/ChatGPTWidget"));
const GoogleCalendarWidget = lazy(() => import("./pages/GoogleCalendarWidget"));
const GmailWidget = lazy(() => import("./pages/GmailWidget"));
const SolisMeterReads = lazy(() => import("./pages/SolisMeterReads"));
const GoodWeMeterReads = lazy(() => import("./pages/GoodWeMeterReads"));
const GeneracMeterReads = lazy(() => import("./pages/GeneracMeterReads"));
const LocusMeterReads = lazy(() => import("./pages/LocusMeterReads"));
const GrowattMeterReads = lazy(() => import("./pages/GrowattMeterReads"));
const APsystemsMeterReads = lazy(() => import("./pages/APsystemsMeterReads"));
const EkmMeterReads = lazy(() => import("./pages/EkmMeterReads"));
const HoymilesMeterReads = lazy(() => import("./pages/HoymilesMeterReads"));
const SolarLogMeterReads = lazy(() => import("./pages/SolarLogMeterReads"));

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
      <Route path={"/contract-scrape-manager"} component={withRouteSuspense(ContractScrapeManager)} />
      <Route path={"/abp-invoice-settlement"} component={withRouteSuspense(AbpInvoiceSettlement)} />
      <Route path={"/early-payment"} component={withRouteSuspense(EarlyPayment)} />
      <Route path={"/address-checker"} component={withRouteSuspense(AddressChecker)} />
      <Route path={"/sunpower-readings"} component={withRouteSuspense(SunpowerReadings)} />
      <Route path={"/enphase-v4-meter-reads"} component={withRouteSuspense(EnphaseV2MeterReads)} />
      <Route path={"/enphase-v2-meter-reads"} component={withRouteSuspense(EnphaseV2MeterReads)} />
      <Route path={"/solaredge-meter-reads"} component={withRouteSuspense(SolarEdgeMeterReads)} />
      <Route path={"/fronius-meter-reads"} component={withRouteSuspense(FroniusMeterReads)} />
      <Route path={"/ennexos-meter-reads"} component={withRouteSuspense(EnnexOsMeterReads)} />
      <Route path={"/egauge-api"} component={withRouteSuspense(EGaugeApi)} />
      <Route path={"/tesla-solar-api"} component={withRouteSuspense(TeslaSolarApi)} />
      <Route path={"/tesla-powerhub-api"} component={withRouteSuspense(TeslaPowerhubApi)} />
      <Route path={"/solis-meter-reads"} component={withRouteSuspense(SolisMeterReads)} />
      <Route path={"/goodwe-meter-reads"} component={withRouteSuspense(GoodWeMeterReads)} />
      <Route path={"/generac-meter-reads"} component={withRouteSuspense(GeneracMeterReads)} />
      <Route path={"/locus-meter-reads"} component={withRouteSuspense(LocusMeterReads)} />
      <Route path={"/growatt-meter-reads"} component={withRouteSuspense(GrowattMeterReads)} />
      <Route path={"/apsystems-meter-reads"} component={withRouteSuspense(APsystemsMeterReads)} />
      <Route path={"/ekm-meter-reads"} component={withRouteSuspense(EkmMeterReads)} />
      <Route path={"/hoymiles-meter-reads"} component={withRouteSuspense(HoymilesMeterReads)} />
      <Route path={"/solarlog-meter-reads"} component={withRouteSuspense(SolarLogMeterReads)} />
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
