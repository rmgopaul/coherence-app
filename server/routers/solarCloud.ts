import { createSolarConnectionRouter, maskApiKey } from "./solarConnectionFactory";
import {
  SOLIS_PROVIDER,
  GOODWE_PROVIDER,
  GENERAC_PROVIDER,
  LOCUS_PROVIDER,
  GROWATT_PROVIDER,
  APSYSTEMS_PROVIDER,
  EKM_PROVIDER,
  HOYMILES_PROVIDER,
  SOLAR_LOG_PROVIDER,
  parseSolisMetadata,
  serializeSolisMetadata,
  parseGoodWeMetadata,
  serializeGoodWeMetadata,
  parseGeneracMetadata,
  serializeGeneracMetadata,
  parseLocusMetadata,
  serializeLocusMetadata,
  parseGrowattMetadata,
  serializeGrowattMetadata,
  parseAPsystemsMetadata,
  serializeAPsystemsMetadata,
  parseEkmMetadata,
  serializeEkmMetadata,
  parseHoymilesMetadata,
  serializeHoymilesMetadata,
  parseSolarLogMetadata,
  serializeSolarLogMetadata,
  getSolisContext,
  getGoodWeContext,
  getGeneracContext,
  getLocusContext,
  getGrowattContext,
  getAPsystemsContext,
  getEkmContext,
  getHoymilesContext,
  getSolarLogContext,
  toNonEmptyString,
} from "./helpers";
import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { getIntegrationByProvider } from "../db";
import {
  listStations as listStationsSolis,
  getStationProductionSnapshot as getStationProductionSnapshotSolis,
} from "../services/solar/solis";
import {
  listStations as listStationsGoodWe,
  getStationProductionSnapshot as getStationProductionSnapshotGoodWe,
} from "../services/solar/goodwe";
import {
  listSystems as listSystemsGenerac,
  getSystemProductionSnapshot as getSystemProductionSnapshotGenerac,
} from "../services/solar/generac";
import {
  listSites as listSitesLocus,
  getSiteProductionSnapshot as getSiteProductionSnapshotLocus,
} from "../services/solar/locus";
import {
  listPlants as listPlantsGrowatt,
  getPlantProductionSnapshot as getPlantProductionSnapshotGrowatt,
} from "../services/solar/growatt";
import {
  listSystems as listSystemsApsystems,
  getSystemProductionSnapshot as getSystemProductionSnapshotApsystems,
} from "../services/solar/apsystems";
import { getMeterProductionSnapshot as getMeterProductionSnapshotEkm } from "../services/solar/ekm";
import {
  listStations as listStationsHoymiles,
  getStationProductionSnapshot as getStationProductionSnapshotHoymiles,
} from "../services/solar/hoymiles";
import {
  listDevices as listDevicesSolarLog,
  getDeviceProductionSnapshot,
} from "../services/solar/solarLog";

// =========================================================================
// Solis Cloud
// =========================================================================
export const solisRouter = router({
  ...createSolarConnectionRouter({
    providerKey: SOLIS_PROVIDER,
    displayName: "Solis",
    credentialSchema: z.object({ apiKey: z.string().min(1), apiSecret: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
    parseMetadata: parseSolisMetadata,
    serializeMetadata: serializeSolisMetadata,
    buildNewConnection: (input, existing, connId, nowIso) => ({
      id: connId,
      name: toNonEmptyString(input.connectionName as string) ?? `Solis API ${existing.connections.length + 1}`,
      apiKey: (input.apiKey as string).trim(),
      apiSecret: (input.apiSecret as string).trim(),
      baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    getAccessToken: (c) => c.apiKey,
    mapConnectionStatus: (c, isActive) => ({
      id: c.id,
      name: c.name,
      baseUrl: c.baseUrl,
      apiKeyMasked: maskApiKey(c.apiKey),
      updatedAt: c.updatedAt,
      isActive,
    }),
    includeBaseUrlInStatus: true,
  }),
  listStations: protectedProcedure.query(async ({ ctx }) => { const context = await getSolisContext(ctx.user.id); return listStationsSolis(context); }),
  getProductionSnapshot: protectedProcedure.input(z.object({ stationId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getSolisContext(ctx.user.id); return getStationProductionSnapshotSolis(context, input.stationId.trim(), input.anchorDate); }),
});

// =========================================================================
// GoodWe SEMS
// =========================================================================
export const goodweRouter = router({
  ...createSolarConnectionRouter({
    providerKey: GOODWE_PROVIDER,
    displayName: "GoodWe",
    credentialSchema: z.object({ account: z.string().min(1), password: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
    parseMetadata: parseGoodWeMetadata,
    serializeMetadata: serializeGoodWeMetadata,
    buildNewConnection: (input, existing, connId, nowIso) => ({
      id: connId,
      name: toNonEmptyString(input.connectionName as string) ?? `GoodWe ${existing.connections.length + 1}`,
      account: (input.account as string).trim(),
      password: input.password as string,
      baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    getAccessToken: (c) => c.account,
    mapConnectionStatus: (c, isActive) => ({
      id: c.id,
      name: c.name,
      accountMasked: maskApiKey(c.account),
      updatedAt: c.updatedAt,
      isActive,
    }),
  }),
  listStations: protectedProcedure.query(async ({ ctx }) => { const context = await getGoodWeContext(ctx.user.id); return listStationsGoodWe(context); }),
  getProductionSnapshot: protectedProcedure.input(z.object({ stationId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getGoodWeContext(ctx.user.id); return getStationProductionSnapshotGoodWe(context, input.stationId.trim(), input.anchorDate); }),
});

// =========================================================================
// Generac PWRfleet
// =========================================================================
export const generacRouter = router({
  ...createSolarConnectionRouter({
    providerKey: GENERAC_PROVIDER,
    displayName: "Generac",
    credentialSchema: z.object({ apiKey: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
    parseMetadata: parseGeneracMetadata,
    serializeMetadata: serializeGeneracMetadata,
    buildNewConnection: (input, existing, connId, nowIso) => ({
      id: connId,
      name: toNonEmptyString(input.connectionName as string) ?? `Generac API ${existing.connections.length + 1}`,
      apiKey: (input.apiKey as string).trim(),
      baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    getAccessToken: (c) => c.apiKey,
    mapConnectionStatus: (c, isActive) => ({
      id: c.id,
      name: c.name,
      apiKeyMasked: maskApiKey(c.apiKey),
      updatedAt: c.updatedAt,
      isActive,
    }),
  }),
  listSystems: protectedProcedure.query(async ({ ctx }) => { const context = await getGeneracContext(ctx.user.id); return listSystemsGenerac(context); }),
  getProductionSnapshot: protectedProcedure.input(z.object({ systemId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getGeneracContext(ctx.user.id); return getSystemProductionSnapshotGenerac(context, input.systemId.trim(), input.anchorDate); }),
});

// =========================================================================
// Locus Energy / SolarNOC
// =========================================================================
export const locusRouter = router({
  ...createSolarConnectionRouter({
    providerKey: LOCUS_PROVIDER,
    displayName: "Locus",
    credentialSchema: z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1), partnerId: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
    parseMetadata: parseLocusMetadata,
    serializeMetadata: serializeLocusMetadata,
    buildNewConnection: (input, existing, connId, nowIso) => ({
      id: connId,
      name: toNonEmptyString(input.connectionName as string) ?? `Locus API ${existing.connections.length + 1}`,
      clientId: (input.clientId as string).trim(),
      clientSecret: (input.clientSecret as string).trim(),
      partnerId: (input.partnerId as string).trim(),
      baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    getAccessToken: (c) => c.clientId,
    mapConnectionStatus: (c, isActive) => ({
      id: c.id,
      name: c.name,
      clientIdMasked: maskApiKey(c.clientId),
      partnerId: c.partnerId,
      updatedAt: c.updatedAt,
      isActive,
    }),
  }),
  listSites: protectedProcedure.query(async ({ ctx }) => { const context = await getLocusContext(ctx.user.id); return listSitesLocus(context); }),
  getProductionSnapshot: protectedProcedure.input(z.object({ siteId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getLocusContext(ctx.user.id); return getSiteProductionSnapshotLocus(context, input.siteId.trim(), input.anchorDate); }),
});

// =========================================================================
// Growatt
// =========================================================================
export const growattRouter = router({
  ...createSolarConnectionRouter({
    providerKey: GROWATT_PROVIDER,
    displayName: "Growatt",
    credentialSchema: z.object({ username: z.string().min(1), password: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
    parseMetadata: parseGrowattMetadata,
    serializeMetadata: serializeGrowattMetadata,
    buildNewConnection: (input, existing, connId, nowIso) => ({
      id: connId,
      name: toNonEmptyString(input.connectionName as string) ?? `Growatt ${existing.connections.length + 1}`,
      username: (input.username as string).trim(),
      password: input.password as string,
      baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    getAccessToken: (c) => c.username,
    mapConnectionStatus: (c, isActive) => ({
      id: c.id,
      name: c.name,
      usernameMasked: maskApiKey(c.username),
      updatedAt: c.updatedAt,
      isActive,
    }),
  }),
  listPlants: protectedProcedure.query(async ({ ctx }) => { const context = await getGrowattContext(ctx.user.id); return listPlantsGrowatt(context); }),
  getProductionSnapshot: protectedProcedure.input(z.object({ plantId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getGrowattContext(ctx.user.id); return getPlantProductionSnapshotGrowatt(context, input.plantId.trim(), input.anchorDate); }),
});

// =========================================================================
// APsystems EMA
// =========================================================================
export const apsystemsRouter = router({
  ...createSolarConnectionRouter({
    providerKey: APSYSTEMS_PROVIDER,
    displayName: "APsystems",
    credentialSchema: z.object({ appId: z.string().min(1), appSecret: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
    parseMetadata: parseAPsystemsMetadata,
    serializeMetadata: serializeAPsystemsMetadata,
    buildNewConnection: (input, existing, connId, nowIso) => ({
      id: connId,
      name: toNonEmptyString(input.connectionName as string) ?? `APsystems API ${existing.connections.length + 1}`,
      appId: (input.appId as string).trim(),
      appSecret: (input.appSecret as string).trim(),
      baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    getAccessToken: (c) => c.appId,
    mapConnectionStatus: (c, isActive) => ({
      id: c.id,
      name: c.name,
      apiKeyMasked: maskApiKey(c.appId),
      hasSecret: !!c.appSecret,
      updatedAt: c.updatedAt,
      isActive,
    }),
  }),
  listSystems: protectedProcedure.query(async ({ ctx }) => { const context = await getAPsystemsContext(ctx.user.id); return listSystemsApsystems(context); }),
  listAllSids: protectedProcedure.mutation(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, APSYSTEMS_PROVIDER);
    const metadata = parseAPsystemsMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
    if (metadata.connections.length === 0) throw new Error("No APsystems profiles saved.");
    type TaggedSystem = { systemId: string; name: string; capacity: number | null; address: string | null; status: string | null; connectionId: string; connectionName: string };
    const profileResults = await Promise.all(
      metadata.connections.map(async (conn) => {
        try {
          const context = { appId: conn.appId, appSecret: conn.appSecret, baseUrl: conn.baseUrl ?? metadata.baseUrl };
          const result = await listSystemsApsystems(context);
          const systems: TaggedSystem[] = result.systems.map((s) => ({ ...s, connectionId: conn.id, connectionName: conn.name }));
          const raw = result.raw as Record<string, unknown>;
          return {
            connectionId: conn.id, connectionName: conn.name,
            systemCount: result.systems.length,
            ownCount: (raw.uniqueOwnSids as number) ?? 0,
            ownTotal: (raw.ownSystems as number) ?? 0,
            partnerCount: (raw.uniquePartnerSids as number) ?? 0,
            partnerTotal: (raw.partnerSystems as number) ?? 0,
            partnerRawEntries: (raw.fetchedPartner as number) ?? 0,
            error: (raw.ownError || raw.partnerError) ? `own: ${raw.ownError ?? "ok"}, partner: ${raw.partnerError ?? "ok"}` : null,
            systems,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { connectionId: conn.id, connectionName: conn.name, systemCount: 0, ownCount: 0, ownTotal: 0, partnerCount: 0, partnerTotal: 0, partnerRawEntries: 0, error: msg, systems: [] as TaggedSystem[] };
        }
      })
    );
    const allSystems = profileResults.flatMap((r) => r.systems);
    const seen = new Set<string>();
    const deduped = allSystems.filter((s) => { if (seen.has(s.systemId)) return false; seen.add(s.systemId); return true; });
    const perProfile = profileResults.map(({ systems: _s, ...rest }) => rest);
    return { systems: deduped, perProfile, totalProfiles: metadata.connections.length };
  }),
  getProductionSnapshot: protectedProcedure.input(z.object({ systemId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getAPsystemsContext(ctx.user.id); return getSystemProductionSnapshotApsystems(context, input.systemId.trim(), input.anchorDate); }),
});

// =========================================================================
// EKM Encompass
// =========================================================================
export const ekmRouter = router({
  ...createSolarConnectionRouter({
    providerKey: EKM_PROVIDER,
    displayName: "EKM",
    credentialSchema: z.object({ apiKey: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
    parseMetadata: parseEkmMetadata,
    serializeMetadata: serializeEkmMetadata,
    buildNewConnection: (input, existing, connId, nowIso) => ({
      id: connId,
      name: toNonEmptyString(input.connectionName as string) ?? `EKM API ${existing.connections.length + 1}`,
      apiKey: (input.apiKey as string).trim(),
      baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    getAccessToken: (c) => c.apiKey,
    mapConnectionStatus: (c, isActive) => ({
      id: c.id,
      name: c.name,
      apiKeyMasked: maskApiKey(c.apiKey),
      updatedAt: c.updatedAt,
      isActive,
    }),
  }),
  getProductionSnapshot: protectedProcedure.input(z.object({ meterNumber: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getEkmContext(ctx.user.id); return getMeterProductionSnapshotEkm(context, input.meterNumber.trim(), input.anchorDate); }),
});

// =========================================================================
// Hoymiles S-Miles Cloud
// =========================================================================
export const hoymilesRouter = router({
  ...createSolarConnectionRouter({
    providerKey: HOYMILES_PROVIDER,
    displayName: "Hoymiles",
    credentialSchema: z.object({ username: z.string().min(1), password: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
    parseMetadata: parseHoymilesMetadata,
    serializeMetadata: serializeHoymilesMetadata,
    buildNewConnection: (input, existing, connId, nowIso) => ({
      id: connId,
      name: toNonEmptyString(input.connectionName as string) ?? `Hoymiles ${existing.connections.length + 1}`,
      username: (input.username as string).trim(),
      password: input.password as string,
      baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    getAccessToken: (c) => c.username,
    mapConnectionStatus: (c, isActive) => ({
      id: c.id,
      name: c.name,
      usernameMasked: maskApiKey(c.username),
      updatedAt: c.updatedAt,
      isActive,
    }),
  }),
  listStations: protectedProcedure.query(async ({ ctx }) => { const context = await getHoymilesContext(ctx.user.id); return listStationsHoymiles(context); }),
  listAllStations: protectedProcedure.mutation(async ({ ctx }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, HOYMILES_PROVIDER);
    const metadata = parseHoymilesMetadata(integration?.metadata);
    if (metadata.connections.length === 0) throw new Error("No Hoymiles profiles saved.");
    const allStations: Array<{ stationId: string; name: string; capacity: number | null; address: string | null; status: string | null; connectionId: string; connectionName: string }> = [];
    const perProfile: Array<{ connectionId: string; connectionName: string; stationCount: number; error: string | null }> = [];
    for (const conn of metadata.connections) {
      try {
        const context = { username: conn.username, password: conn.password, baseUrl: conn.baseUrl ?? metadata.baseUrl };
        const result = await listStationsHoymiles(context);
        for (const s of result.stations) {
          allStations.push({ ...s, connectionId: conn.id, connectionName: conn.name });
        }
        perProfile.push({ connectionId: conn.id, connectionName: conn.name, stationCount: result.stations.length, error: null });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        perProfile.push({ connectionId: conn.id, connectionName: conn.name, stationCount: 0, error: msg });
      }
    }
    // Deduplicate stations by stationId (keep first occurrence)
    const seen = new Set<string>();
    const deduped = allStations.filter((s) => { if (seen.has(s.stationId)) return false; seen.add(s.stationId); return true; });
    return { stations: deduped, perProfile, totalProfiles: metadata.connections.length };
  }),
  getProductionSnapshot: protectedProcedure.input(z.object({ stationId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getHoymilesContext(ctx.user.id); return getStationProductionSnapshotHoymiles(context, input.stationId.trim(), input.anchorDate); }),
  getProductionSnapshotAllProfiles: protectedProcedure.input(z.object({ stationId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => {
    const integration = await getIntegrationByProvider(ctx.user.id, HOYMILES_PROVIDER);
    const metadata = parseHoymilesMetadata(integration?.metadata);
    if (metadata.connections.length === 0) throw new Error("No Hoymiles profiles saved.");
    for (const conn of metadata.connections) {
      try {
        const context = { username: conn.username, password: conn.password, baseUrl: conn.baseUrl ?? metadata.baseUrl };
        const result = await getStationProductionSnapshotHoymiles(context, input.stationId.trim(), input.anchorDate);
        if (result.found) {
          return { ...result, matchedConnectionId: conn.id, matchedConnectionName: conn.name, checkedConnections: metadata.connections.length };
        }
      } catch {
        // Try next profile
      }
    }
    return { stationId: input.stationId, name: null, status: "Not Found" as const, found: false, lifetimeKwh: null, monthlyProductionKwh: null, last12MonthsProductionKwh: null, dailyProductionKwh: null, anchorDate: input.anchorDate ?? new Date().toISOString().slice(0, 10), error: `Station not found in any of ${metadata.connections.length} profiles`, matchedConnectionId: null, matchedConnectionName: null, checkedConnections: metadata.connections.length };
  }),
});

// =========================================================================
// Solar-Log (local device)
// =========================================================================
export const solarLogRouter = router({
  ...createSolarConnectionRouter({
    providerKey: SOLAR_LOG_PROVIDER,
    displayName: "Solar-Log",
    credentialSchema: z.object({ baseUrl: z.string().min(1), password: z.string().optional(), connectionName: z.string().optional() }),
    parseMetadata: (raw) => ({ ...parseSolarLogMetadata(raw), baseUrl: null }),
    serializeMetadata: (connections, activeId, _baseUrl) => serializeSolarLogMetadata(connections, activeId),
    buildNewConnection: (input, existing, connId, nowIso) => ({
      id: connId,
      name: toNonEmptyString(input.connectionName as string) ?? `Solar-Log ${existing.connections.length + 1}`,
      baseUrl: (input.baseUrl as string).trim(),
      password: toNonEmptyString(input.password as string) ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    getAccessToken: (c) => c.baseUrl,
    mapConnectionStatus: (c, isActive) => ({
      id: c.id,
      name: c.name,
      baseUrl: c.baseUrl,
      hasPassword: !!c.password,
      updatedAt: c.updatedAt,
      isActive,
    }),
  }),
  listDevices: protectedProcedure.query(async ({ ctx }) => { const context = await getSolarLogContext(ctx.user.id); return listDevicesSolarLog(context); }),
  getProductionSnapshot: protectedProcedure.input(z.object({ deviceId: z.string().optional(), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getSolarLogContext(ctx.user.id); return getDeviceProductionSnapshot(context, input.deviceId ?? "solar-log-1", input.anchorDate); }),
});
