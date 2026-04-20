import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/features/dashboard/NotFound";
import { Route, Switch, useLocation } from "wouter";
import { Suspense, lazy, type ComponentType } from "react";
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
const SolarRecDashboard = lazy(() => import("@/features/solar-rec/SolarRecDashboard"));
const InvoiceMatchDashboard = lazy(() => import("@/features/dashboard/InvoiceMatchDashboard"));
const EnphaseV4MeterReads = lazy(() => import("@/features/solar-readings/EnphaseV4MeterReads"));
const EnphaseV2MeterReadsPage = lazy(() => import("@/features/solar-readings/EnphaseV2MeterReadsPage"));
const SolarEdgeMeterReads = lazy(() => import("@/features/solar-readings/SolarEdgeMeterReads"));
const FroniusMeterReads = lazy(() => import("@/features/solar-readings/FroniusMeterReads"));
const EnnexOsMeterReads = lazy(() => import("@/features/solar-readings/EnnexOsMeterReads"));
const EGaugeApi = lazy(() => import("@/features/solar-readings/EGaugeApi"));
const TeslaSolarApi = lazy(() => import("@/features/solar-readings/TeslaSolarApi"));
const TeslaPowerhubApi = lazy(() => import("@/features/solar-readings/TeslaPowerhubApi"));
const ZendeskTicketMetrics = lazy(() => import("@/features/dashboard/ZendeskTicketMetrics"));
const DeepUpdateSynthesizer = lazy(() => import("@/features/dashboard/DeepUpdateSynthesizer"));
const ContractScanner = lazy(() => import("@/features/dashboard/ContractScanner"));
const ContractScrapeManager = lazy(() => import("@/features/dashboard/ContractScrapeManager"));
const AbpInvoiceSettlement = lazy(() => import("@/features/dashboard/AbpInvoiceSettlement"));
const EarlyPayment = lazy(() => import("@/features/dashboard/EarlyPayment"));
const AddressChecker = lazy(() => import("@/features/dashboard/AddressChecker"));
const SunpowerReadings = lazy(() => import("@/features/solar-readings/SunpowerReadings"));
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
const SolisMeterReads = lazy(() => import("@/features/solar-readings/SolisMeterReads"));
const GoodWeMeterReads = lazy(() => import("@/features/solar-readings/GoodWeMeterReads"));
const GeneracMeterReads = lazy(() => import("@/features/solar-readings/GeneracMeterReads"));
const LocusMeterReads = lazy(() => import("@/features/solar-readings/LocusMeterReads"));
const GrowattMeterReads = lazy(() => import("@/features/solar-readings/GrowattMeterReads"));
const APsystemsMeterReads = lazy(() => import("@/features/solar-readings/APsystemsMeterReads"));
const EkmMeterReads = lazy(() => import("@/features/solar-readings/EkmMeterReads"));
const HoymilesMeterReads = lazy(() => import("@/features/solar-readings/HoymilesMeterReads"));
const SolarLogMeterReads = lazy(() => import("@/features/solar-readings/SolarLogMeterReads"));

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
      <Route path={"/dashboard-legacy"} component={withRouteSuspense(DashboardLegacy)} />
      <Route path={"/solar-rec-dashboard"} component={withRouteSuspense(SolarRecDashboard)} />
      <Route path={"/invoice-match-dashboard"} component={withRouteSuspense(InvoiceMatchDashboard)} />
      <Route path={"/deep-update-synthesizer"} component={withRouteSuspense(DeepUpdateSynthesizer)} />
      <Route path={"/contract-scanner"} component={withRouteSuspense(ContractScanner)} />
      <Route path={"/contract-scrape-manager"} component={withRouteSuspense(ContractScrapeManager)} />
      <Route path={"/abp-invoice-settlement"} component={withRouteSuspense(AbpInvoiceSettlement)} />
      <Route path={"/early-payment"} component={withRouteSuspense(EarlyPayment)} />
      <Route path={"/address-checker"} component={withRouteSuspense(AddressChecker)} />
      <Route path={"/sunpower-readings"} component={withRouteSuspense(SunpowerReadings)} />
      <Route path={"/enphase-v4-meter-reads"} component={withRouteSuspense(EnphaseV4MeterReads)} />
      <Route path={"/enphase-v2-meter-reads"} component={withRouteSuspense(EnphaseV2MeterReadsPage)} />
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
