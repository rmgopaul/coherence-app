import { createTRPCReact } from "@trpc/react-query";
import type { SolarRecAppRouter } from "../../../server/_core/solarRecRouter";

export const solarRecTrpc = createTRPCReact<SolarRecAppRouter>();
