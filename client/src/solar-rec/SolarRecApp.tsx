import { Suspense, lazy } from "react";
import { Route, Switch, Redirect, Router } from "wouter";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { useSolarRecAuth } from "./hooks/useSolarRecAuth";
import SolarRecSidebar from "./components/SolarRecSidebar";
import SolarRecLoginPage from "./SolarRecLoginPage";

// Lazy-load pages
const SolarRecDashboard = lazy(() => import("../pages/SolarRecDashboard"));
const MonitoringDashboard = lazy(
  () => import("./pages/MonitoringDashboard")
);
const SolarRecSettings = lazy(() => import("./pages/SolarRecSettings"));

// Meter read pages (existing, reused from main app)
const SolarEdgeMeterReads = lazy(
  () => import("../pages/SolarEdgeMeterReads")
);
const EnphaseV2MeterReads = lazy(
  () => import("../pages/EnphaseV2MeterReads")
);
const APsystemsMeterReads = lazy(
  () => import("../pages/APsystemsMeterReads")
);
const HoymilesMeterReads = lazy(
  () => import("../pages/HoymilesMeterReads")
);
const FroniusMeterReads = lazy(
  () => import("../pages/FroniusMeterReads")
);
const GeneracMeterReads = lazy(
  () => import("../pages/GeneracMeterReads")
);
const GoodWeMeterReads = lazy(
  () => import("../pages/GoodWeMeterReads")
);
const SolisMeterReads = lazy(
  () => import("../pages/SolisMeterReads")
);
const LocusMeterReads = lazy(
  () => import("../pages/LocusMeterReads")
);
const GrowattMeterReads = lazy(
  () => import("../pages/GrowattMeterReads")
);
const SolarLogMeterReads = lazy(
  () => import("../pages/SolarLogMeterReads")
);
const EkmMeterReads = lazy(() => import("../pages/EkmMeterReads"));
const EnnexOsMeterReads = lazy(
  () => import("../pages/EnnexOsMeterReads")
);
const EGaugeApi = lazy(() => import("../pages/EGaugeApi"));
const SunpowerReadings = lazy(
  () => import("../pages/SunpowerReadings")
);
const TeslaSolarApi = lazy(() => import("../pages/TeslaSolarApi"));

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <p className="text-sm text-muted-foreground">Loading...</p>
    </div>
  );
}

function AuthenticatedApp() {
  const { user, logout } = useSolarRecAuth();

  return (
    <SidebarProvider>
      <SolarRecSidebar user={user} onLogout={logout} />
      <SidebarInset>
        <main className="flex-1 overflow-y-auto">
          <Suspense fallback={<PageLoader />}>
            <Switch>
              <Route path="/solar-rec/dashboard">
                <SolarRecDashboard />
              </Route>
              <Route path="/solar-rec/monitoring">
                <MonitoringDashboard />
              </Route>
              <Route path="/solar-rec/settings">
                <SolarRecSettings />
              </Route>

              {/* Meter read pages */}
              <Route path="/solar-rec/meter-reads/solaredge">
                <SolarEdgeMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/enphase-v2">
                <EnphaseV2MeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/apsystems">
                <APsystemsMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/hoymiles">
                <HoymilesMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/fronius">
                <FroniusMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/generac">
                <GeneracMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/goodwe">
                <GoodWeMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/solis">
                <SolisMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/locus">
                <LocusMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/growatt">
                <GrowattMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/solarlog">
                <SolarLogMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/ekm">
                <EkmMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/ennexos">
                <EnnexOsMeterReads />
              </Route>
              <Route path="/solar-rec/meter-reads/egauge">
                <EGaugeApi />
              </Route>
              <Route path="/solar-rec/meter-reads/sunpower">
                <SunpowerReadings />
              </Route>
              <Route path="/solar-rec/meter-reads/tesla-solar">
                <TeslaSolarApi />
              </Route>

              {/* Default: redirect to dashboard */}
              <Route>
                <Redirect to="/solar-rec/dashboard" />
              </Route>
            </Switch>
          </Suspense>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

export default function SolarRecApp() {
  const { loading, authenticated } = useSolarRecAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!authenticated) {
    return <SolarRecLoginPage />;
  }

  return (
    <Router base="">
      <AuthenticatedApp />
    </Router>
  );
}
