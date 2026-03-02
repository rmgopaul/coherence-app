import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import PinGate from "./components/PinGate";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import SolarRecDashboard from "./pages/SolarRecDashboard";
import Notebook from "./pages/Notebook";
import Settings from "./pages/Settings";
import TodoistWidget from "./pages/TodoistWidget";
import ChatGPTWidget from "./pages/ChatGPTWidget";
import GoogleCalendarWidget from "./pages/GoogleCalendarWidget";
import GmailWidget from "./pages/GmailWidget";

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/dashboard"} component={Dashboard} />
      <Route path={"/solar-rec-dashboard"} component={SolarRecDashboard} />
      <Route path={"/notes"} component={Notebook} />
      <Route path={"/settings"} component={Settings} />
      <Route path={"/widget/todoist"} component={TodoistWidget} />
      <Route path={"/widget/chatgpt"} component={ChatGPTWidget} />
      <Route path={"/widget/google-calendar"} component={GoogleCalendarWidget} />
      <Route path={"/widget/gmail"} component={GmailWidget} />
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
