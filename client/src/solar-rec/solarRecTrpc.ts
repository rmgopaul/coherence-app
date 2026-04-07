import { createTRPCReact } from "@trpc/react-query";
import type { SolarRecAppRouter } from "../../../server/_core/solarRecRouter";

/**
 * tRPC React hooks typed against the Solar REC app router.
 *
 * Use this in new solar-rec pages (MonitoringDashboard, Settings).
 * The existing SolarRecDashboard page continues to use the main `trpc`
 * instance since it only calls `solarRecDashboard.*` routes.
 */
export const solarRecTrpc = createTRPCReact<SolarRecAppRouter>();
