import { Suspense, lazy } from "react";
import SolarRecAuthGate from "./components/SolarRecAuthGate";

const SolarRecDashboard = lazy(() => import("./pages/SolarRecDashboard"));

function RouteFallback() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#64748b", fontSize: "14px" }}>Loading Solar REC Dashboard...</div>
    </div>
  );
}

export default function SolarRecStandaloneApp() {
  return (
    <SolarRecAuthGate>
      <Suspense fallback={<RouteFallback />}>
        <SolarRecDashboard />
      </Suspense>
    </SolarRecAuthGate>
  );
}
