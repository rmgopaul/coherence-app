import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import { Suspense, lazy, type ComponentType } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import PinGate from "./components/PinGate";
import { ThemeProvider } from "./contexts/ThemeContext";

const Home = lazy(() => import("./pages/Home"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const SolarRecDashboard = lazy(() => import("./pages/SolarRecDashboard"));
const EnphaseV2MeterReads = lazy(() => import("./pages/EnphaseV2MeterReads"));
const SolarEdgeMeterReads = lazy(() => import("./pages/SolarEdgeMeterReads"));
const DeepUpdateSynthesizer = lazy(() => import("./pages/DeepUpdateSynthesizer"));
const Notebook = lazy(() => import("./pages/Notebook"));
const Settings = lazy(() => import("./pages/Settings"));
const TodoistWidget = lazy(() => import("./pages/TodoistWidget"));
const ChatGPTWidget = lazy(() => import("./pages/ChatGPTWidget"));
const GoogleCalendarWidget = lazy(() => import("./pages/GoogleCalendarWidget"));
const GmailWidget = lazy(() => import("./pages/GmailWidget"));

function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="text-sm text-slate-600">Loading page...</div>
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

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"/"} component={withRouteSuspense(Home)} />
      <Route path={"/dashboard"} component={withRouteSuspense(Dashboard)} />
      <Route path={"/solar-rec-dashboard"} component={withRouteSuspense(SolarRecDashboard)} />
      <Route path={"/deep-update-synthesizer"} component={withRouteSuspense(DeepUpdateSynthesizer)} />
      <Route path={"/enphase-v4-meter-reads"} component={withRouteSuspense(EnphaseV2MeterReads)} />
      <Route path={"/enphase-v2-meter-reads"} component={withRouteSuspense(EnphaseV2MeterReads)} />
      <Route path={"/solaredge-meter-reads"} component={withRouteSuspense(SolarEdgeMeterReads)} />
      <Route path={"/notes"} component={withRouteSuspense(Notebook)} />
      <Route path={"/settings"} component={withRouteSuspense(Settings)} />
      <Route path={"/widget/todoist"} component={withRouteSuspense(TodoistWidget)} />
      <Route path={"/widget/chatgpt"} component={withRouteSuspense(ChatGPTWidget)} />
      <Route path={"/widget/google-calendar"} component={withRouteSuspense(GoogleCalendarWidget)} />
      <Route path={"/widget/gmail"} component={withRouteSuspense(GmailWidget)} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

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
            <Router />
          </PinGate>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
