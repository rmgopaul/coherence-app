import { toNonEmptyString } from "../../services/core/addressCleaning";
import { IntegrationNotConnectedError } from "../../errors";
import { getIntegrationByProvider, upsertIntegration } from "../../db";
import { refreshEnphaseV4AccessToken } from "../../services/solar/enphaseV4";
import {
  ENPHASE_V2_PROVIDER,
  ENPHASE_V4_PROVIDER,
  SOLAR_EDGE_PROVIDER,
  ENNEX_OS_PROVIDER,
  ZENDESK_PROVIDER,
  TESLA_SOLAR_PROVIDER,
  TESLA_POWERHUB_PROVIDER,
  CLOCKIFY_PROVIDER,
  FRONIUS_PROVIDER,
  EGAUGE_PROVIDER,
  SOLIS_PROVIDER,
  GOODWE_PROVIDER,
  GENERAC_PROVIDER,
  LOCUS_PROVIDER,
  GROWATT_PROVIDER,
  APSYSTEMS_PROVIDER,
  EKM_PROVIDER,
  HOYMILES_PROVIDER,
  SOLAR_LOG_PROVIDER,
} from "./constants";
import {
  parseEnphaseV2Metadata,
  parseEnphaseV4Metadata,
  parseSolarEdgeMetadata,
  parseEnnexOsMetadata,
  parseFroniusMetadata,
  parseZendeskMetadata,
  parseTeslaSolarMetadata,
  parseEgaugeMetadata,
  parseTeslaPowerhubMetadata,
  parseClockifyMetadata,
  parseSolisMetadata,
  parseGoodWeMetadata,
  parseGeneracMetadata,
  parseLocusMetadata,
  parseGrowattMetadata,
  parseAPsystemsMetadata,
  parseEkmMetadata,
  parseHoymilesMetadata,
  parseSolarLogMetadata,
  selectEgaugeConnection,
  type EgaugeAccessType,
} from "./providerMetadata";

// ---------------------------------------------------------------------------
// getXxxContext helper functions
// ---------------------------------------------------------------------------

export async function getFroniusContext(
  userId: number
): Promise<{ accessKeyId: string; accessKeyValue: string }> {
  const integration = await getIntegrationByProvider(userId, FRONIUS_PROVIDER);
  const metadata = parseFroniusMetadata(
    integration?.metadata,
    toNonEmptyString(integration?.accessToken)
  );
  const activeConnection =
    metadata.connections.find(c => c.id === metadata.activeConnectionId) ??
    metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Fronius");
  return {
    accessKeyId: activeConnection.accessKeyId,
    accessKeyValue: activeConnection.accessKeyValue,
  };
}

export async function getEnnexOsContext(
  userId: number
): Promise<{ accessToken: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, ENNEX_OS_PROVIDER);
  const metadata = parseEnnexOsMetadata(
    integration?.metadata,
    toNonEmptyString(integration?.accessToken)
  );
  const activeConnection =
    metadata.connections.find(
      connection => connection.id === metadata.activeConnectionId
    ) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("ennexOS");
  return {
    accessToken: activeConnection.accessToken,
    baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
  };
}

export async function getEnphaseV2Credentials(
  userId: number
): Promise<{ apiKey: string; userId: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(
    userId,
    ENPHASE_V2_PROVIDER
  );
  const apiKey = toNonEmptyString(integration?.accessToken);
  const metadata = parseEnphaseV2Metadata(integration?.metadata);
  if (!apiKey || !metadata.userId)
    throw new IntegrationNotConnectedError("Enphase v2");
  return { apiKey, userId: metadata.userId, baseUrl: metadata.baseUrl };
}

export async function getEnphaseV4Context(
  userId: number
): Promise<{ accessToken: string; apiKey: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(
    userId,
    ENPHASE_V4_PROVIDER
  );
  if (!integration?.accessToken)
    throw new IntegrationNotConnectedError("Enphase v4");
  const metadata = parseEnphaseV4Metadata(integration.metadata);
  if (!metadata.apiKey || !metadata.clientId || !metadata.clientSecret)
    throw new Error(
      "Enphase v4 connection is incomplete. Reconnect with API key + client credentials."
    );
  const now = Date.now();
  const expiresAt = integration.expiresAt
    ? new Date(integration.expiresAt).getTime()
    : null;
  const needsRefresh = !expiresAt || expiresAt - now < 5 * 60 * 1000;
  let accessToken = integration.accessToken;
  if (needsRefresh) {
    if (!integration.refreshToken)
      throw new Error(
        "Enphase token expired and no refresh token is available. Reconnect first."
      );
    const refreshed = await refreshEnphaseV4AccessToken({
      clientId: metadata.clientId,
      clientSecret: metadata.clientSecret,
      refreshToken: integration.refreshToken,
    });
    accessToken = refreshed.access_token;
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
    await upsertIntegration({
      ...integration,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || integration.refreshToken,
      expiresAt: newExpiresAt,
      scope: refreshed.scope || integration.scope,
    });
  }
  return { accessToken, apiKey: metadata.apiKey, baseUrl: metadata.baseUrl };
}

export async function getSolarEdgeContext(
  userId: number
): Promise<{ apiKey: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(
    userId,
    SOLAR_EDGE_PROVIDER
  );
  const metadata = parseSolarEdgeMetadata(
    integration?.metadata,
    toNonEmptyString(integration?.accessToken)
  );
  const activeConnection =
    metadata.connections.find(
      connection => connection.id === metadata.activeConnectionId
    ) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("SolarEdge");
  return {
    apiKey: activeConnection.apiKey,
    baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
  };
}

export async function getZendeskContext(
  userId: number
): Promise<{ subdomain: string; email: string; apiToken: string }> {
  const integration = await getIntegrationByProvider(userId, ZENDESK_PROVIDER);
  const apiToken = toNonEmptyString(integration?.accessToken);
  const metadata = parseZendeskMetadata(integration?.metadata);
  if (!apiToken || !metadata.subdomain || !metadata.email)
    throw new IntegrationNotConnectedError("Zendesk");
  return { subdomain: metadata.subdomain, email: metadata.email, apiToken };
}

export async function getTeslaSolarContext(
  userId: number
): Promise<{ accessToken: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(
    userId,
    TESLA_SOLAR_PROVIDER
  );
  const accessToken = toNonEmptyString(integration?.accessToken);
  const metadata = parseTeslaSolarMetadata(integration?.metadata);
  if (!accessToken) throw new IntegrationNotConnectedError("Tesla Solar");
  return { accessToken, baseUrl: metadata.baseUrl };
}

export async function getEgaugeContext(
  userId: number,
  connectionId?: string | null
): Promise<{
  connectionId: string;
  connectionName: string;
  meterId: string;
  baseUrl: string;
  accessType: EgaugeAccessType;
  username: string | null;
  password: string | null;
}> {
  const integration = await getIntegrationByProvider(userId, EGAUGE_PROVIDER);
  const metadata = parseEgaugeMetadata(
    integration?.metadata,
    toNonEmptyString(integration?.accessToken)
  );
  const selectedConnection = selectEgaugeConnection(metadata, connectionId);
  if (!selectedConnection) {
    if (toNonEmptyString(connectionId)) {
      throw new Error("Selected eGauge profile was not found.");
    }
    throw new IntegrationNotConnectedError("eGauge");
  }
  const requiresCredentials = selectedConnection.accessType !== "public";
  if (
    requiresCredentials &&
    (!selectedConnection.username || !selectedConnection.password)
  ) {
    throw new Error(
      "eGauge login is incomplete for the selected profile. Save username and password."
    );
  }
  return {
    connectionId: selectedConnection.id,
    connectionName: selectedConnection.name,
    meterId: selectedConnection.meterId,
    baseUrl: selectedConnection.baseUrl,
    accessType: selectedConnection.accessType,
    username: selectedConnection.username,
    password: selectedConnection.password,
  };
}

export async function getTeslaPowerhubContext(
  userId: number
): Promise<{
  clientId: string;
  clientSecret: string;
  tokenUrl: string | null;
  apiBaseUrl: string | null;
  portalBaseUrl: string | null;
}> {
  const integration = await getIntegrationByProvider(
    userId,
    TESLA_POWERHUB_PROVIDER
  );
  const clientSecret = toNonEmptyString(integration?.accessToken);
  const metadata = parseTeslaPowerhubMetadata(integration?.metadata);
  if (!clientSecret || !metadata.clientId)
    throw new IntegrationNotConnectedError("Tesla Powerhub");
  return {
    clientId: metadata.clientId,
    clientSecret,
    tokenUrl: metadata.tokenUrl,
    apiBaseUrl: metadata.apiBaseUrl,
    portalBaseUrl: metadata.portalBaseUrl,
  };
}

export async function getClockifyContext(
  userId: number
): Promise<{
  apiKey: string;
  workspaceId: string;
  workspaceName: string | null;
  clockifyUserId: string;
  userName: string | null;
  userEmail: string | null;
}> {
  const integration = await getIntegrationByProvider(userId, CLOCKIFY_PROVIDER);
  const apiKey = toNonEmptyString(integration?.accessToken);
  const metadata = parseClockifyMetadata(integration?.metadata);
  if (!apiKey) throw new IntegrationNotConnectedError("Clockify");
  if (!metadata.workspaceId || !metadata.userId)
    throw new Error(
      "Clockify setup is incomplete. Reconnect Clockify from Settings."
    );
  return {
    apiKey,
    workspaceId: metadata.workspaceId,
    workspaceName: metadata.workspaceName,
    clockifyUserId: metadata.userId,
    userName: metadata.userName,
    userEmail: metadata.userEmail,
  };
}

export async function getSolisContext(
  userId: number
): Promise<{ apiKey: string; apiSecret: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, SOLIS_PROVIDER);
  const metadata = parseSolisMetadata(
    integration?.metadata,
    toNonEmptyString(integration?.accessToken)
  );
  const activeConnection =
    metadata.connections.find(c => c.id === metadata.activeConnectionId) ??
    metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Solis");
  return {
    apiKey: activeConnection.apiKey,
    apiSecret: activeConnection.apiSecret,
    baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
  };
}

export async function getGoodWeContext(
  userId: number
): Promise<{ account: string; password: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, GOODWE_PROVIDER);
  const metadata = parseGoodWeMetadata(integration?.metadata);
  const activeConnection =
    metadata.connections.find(c => c.id === metadata.activeConnectionId) ??
    metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("GoodWe");
  return {
    account: activeConnection.account,
    password: activeConnection.password,
    baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
  };
}

export async function getGeneracContext(
  userId: number
): Promise<{ apiKey: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, GENERAC_PROVIDER);
  const metadata = parseGeneracMetadata(
    integration?.metadata,
    toNonEmptyString(integration?.accessToken)
  );
  const activeConnection =
    metadata.connections.find(c => c.id === metadata.activeConnectionId) ??
    metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Generac");
  return {
    apiKey: activeConnection.apiKey,
    baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
  };
}

export async function getLocusContext(
  userId: number
): Promise<{
  clientId: string;
  clientSecret: string;
  partnerId: string;
  baseUrl: string | null;
}> {
  const integration = await getIntegrationByProvider(userId, LOCUS_PROVIDER);
  const metadata = parseLocusMetadata(integration?.metadata);
  const activeConnection =
    metadata.connections.find(c => c.id === metadata.activeConnectionId) ??
    metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Locus Energy");
  return {
    clientId: activeConnection.clientId,
    clientSecret: activeConnection.clientSecret,
    partnerId: activeConnection.partnerId,
    baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
  };
}

export async function getGrowattContext(
  userId: number
): Promise<{ username: string; password: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, GROWATT_PROVIDER);
  const metadata = parseGrowattMetadata(integration?.metadata);
  const activeConnection =
    metadata.connections.find(c => c.id === metadata.activeConnectionId) ??
    metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Growatt");
  return {
    username: activeConnection.username,
    password: activeConnection.password,
    baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
  };
}

export async function getAPsystemsContext(
  userId: number
): Promise<{ appId: string; appSecret: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(
    userId,
    APSYSTEMS_PROVIDER
  );
  const metadata = parseAPsystemsMetadata(
    integration?.metadata,
    toNonEmptyString(integration?.accessToken)
  );
  const activeConnection =
    metadata.connections.find(c => c.id === metadata.activeConnectionId) ??
    metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("APsystems");
  if (!activeConnection.appSecret)
    throw new Error(
      "APsystems App Secret is missing. Please reconnect with both App ID and App Secret."
    );
  return {
    appId: activeConnection.appId,
    appSecret: activeConnection.appSecret,
    baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
  };
}

export async function getEkmContext(
  userId: number
): Promise<{ apiKey: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, EKM_PROVIDER);
  const metadata = parseEkmMetadata(
    integration?.metadata,
    toNonEmptyString(integration?.accessToken)
  );
  const activeConnection =
    metadata.connections.find(c => c.id === metadata.activeConnectionId) ??
    metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("EKM");
  return {
    apiKey: activeConnection.apiKey,
    baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
  };
}

export async function getHoymilesContext(
  userId: number
): Promise<{ username: string; password: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, HOYMILES_PROVIDER);
  const metadata = parseHoymilesMetadata(integration?.metadata);
  const activeConnection =
    metadata.connections.find(c => c.id === metadata.activeConnectionId) ??
    metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Hoymiles");
  return {
    username: activeConnection.username,
    password: activeConnection.password,
    baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
  };
}

export async function getSolarLogContext(
  userId: number
): Promise<{ baseUrl: string; password: string | null }> {
  const integration = await getIntegrationByProvider(
    userId,
    SOLAR_LOG_PROVIDER
  );
  const metadata = parseSolarLogMetadata(integration?.metadata);
  const activeConnection =
    metadata.connections.find(c => c.id === metadata.activeConnectionId) ??
    metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Solar-Log");
  return {
    baseUrl: activeConnection.baseUrl,
    password: activeConnection.password,
  };
}
