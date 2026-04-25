import { Suspense, lazy, type ReactNode } from "react";
import { Route, Switch, Redirect, Router } from "wouter";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { useSolarRecAuth } from "./hooks/useSolarRecAuth";
import SolarRecSidebar from "./components/SolarRecSidebar";
import SolarRecLoginPage from "./SolarRecLoginPage";
import { PermissionGate } from "./components/PermissionGate";

// Lazy-load pages
const SolarRecDashboard = lazy(
  () => import("../features/solar-rec/SolarRecDashboard")
);
const MonitoringDashboard = lazy(() => import("./pages/MonitoringDashboard"));
const MonitoringOverview = lazy(() => import("./pages/MonitoringOverview"));
const SolarRecSettings = lazy(() => import("./pages/SolarRecSettings"));

// Meter read pages (existing, reused from main app)
const SolarEdgeMeterReads = lazy(
  () => import("../features/solar-readings/SolarEdgeMeterReads")
);
const EnphaseV4MeterReads = lazy(
  () => import("../features/solar-readings/EnphaseV4MeterReads")
);
// Task 5.4 vendor 6/16 — APsystems migrated to solar-rec-native page backed
// by team credentials.
const APsystemsMeterReads = lazy(
  () => import("./pages/meter-reads/APsystemsMeterReads")
);
// Task 5.4 vendor 4/16 — Hoymiles migrated to solar-rec-native page backed
// by team credentials.
const HoymilesMeterReads = lazy(
  () => import("./pages/meter-reads/HoymilesMeterReads")
);
// Task 5.4 vendor 10/16 — Fronius migrated to solar-rec-native page backed
// by team credentials.
const FroniusMeterReads = lazy(
  () => import("./pages/meter-reads/FroniusMeterReads")
);
// Task 5.4 — Generac migrated to solar-rec-native page backed by team
// credentials; main's per-user Generac page is the fallback while the
// old URL (/generac-meter-reads) is still routable.
const GeneracMeterReads = lazy(
  () => import("./pages/meter-reads/GeneracMeterReads")
);
// Task 5.4 vendor 3/16 — GoodWe migrated to solar-rec-native page backed
// by team credentials.
const GoodWeMeterReads = lazy(
  () => import("./pages/meter-reads/GoodWeMeterReads")
);
// Task 5.4 vendor 2/16 — Solis migrated to solar-rec-native page backed
// by team credentials.
const SolisMeterReads = lazy(
  () => import("./pages/meter-reads/SolisMeterReads")
);
// Task 5.4 vendor 5/16 — Locus migrated to solar-rec-native page backed
// by team credentials.
const LocusMeterReads = lazy(
  () => import("./pages/meter-reads/LocusMeterReads")
);
// Task 5.4 vendor 8/16 — Growatt migrated to solar-rec-native page backed
// by team credentials.
const GrowattMeterReads = lazy(
  () => import("./pages/meter-reads/GrowattMeterReads")
);
// Task 5.4 vendor 7/16 — SolarLog migrated to solar-rec-native page backed
// by team credentials.
const SolarLogMeterReads = lazy(
  () => import("./pages/meter-reads/SolarLogMeterReads")
);
// Task 5.4 vendor 9/16 — EKM migrated to solar-rec-native page backed
// by team credentials.
const EkmMeterReads = lazy(
  () => import("./pages/meter-reads/EkmMeterReads")
);
// Task 5.4 vendor 11/16 — EnnexOS migrated to solar-rec-native page backed
// by team credentials.
const EnnexOsMeterReads = lazy(
  () => import("./pages/meter-reads/EnnexOsMeterReads")
);
const EGaugeApi = lazy(() => import("../features/solar-readings/EGaugeApi"));
const SunpowerReadings = lazy(
  () => import("../features/solar-readings/SunpowerReadings")
);
const TeslaPowerhubApi = lazy(
  () => import("../features/solar-readings/TeslaPowerhubApi")
);

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[50vh]">
      <p className="text-sm text-muted-foreground">Loading...</p>
    </div>
  );
}

function MeterReadsGate({ children }: { children: ReactNode }) {
  return <PermissionGate moduleKey="meter-reads">{children}</PermissionGate>;
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
                <PermissionGate moduleKey="solar-rec-dashboard">
                  <SolarRecDashboard />
                </PermissionGate>
              </Route>
              <Route path="/solar-rec/monitoring">
                <MonitoringDashboard />
              </Route>
              <Route path="/solar-rec/monitoring-overview">
                <MonitoringOverview />
              </Route>
              <Route path="/solar-rec/settings">
                <SolarRecSettings />
              </Route>

              {/* Meter read pages */}
              <Route path="/solar-rec/meter-reads/solaredge">
                <MeterReadsGate>
                  <SolarEdgeMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/enphase-v4">
                <MeterReadsGate>
                  <EnphaseV4MeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/apsystems">
                <MeterReadsGate>
                  <APsystemsMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/hoymiles">
                <MeterReadsGate>
                  <HoymilesMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/fronius">
                <MeterReadsGate>
                  <FroniusMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/generac">
                <MeterReadsGate>
                  <GeneracMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/goodwe">
                <MeterReadsGate>
                  <GoodWeMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/solis">
                <MeterReadsGate>
                  <SolisMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/locus">
                <MeterReadsGate>
                  <LocusMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/growatt">
                <MeterReadsGate>
                  <GrowattMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/solarlog">
                <MeterReadsGate>
                  <SolarLogMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/ekm">
                <MeterReadsGate>
                  <EkmMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/ennexos">
                <MeterReadsGate>
                  <EnnexOsMeterReads />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/egauge">
                <MeterReadsGate>
                  <EGaugeApi />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/sunpower">
                <MeterReadsGate>
                  <SunpowerReadings />
                </MeterReadsGate>
              </Route>
              <Route path="/solar-rec/meter-reads/tesla-powerhub">
                <MeterReadsGate>
                  <TeslaPowerhubApi />
                </MeterReadsGate>
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
