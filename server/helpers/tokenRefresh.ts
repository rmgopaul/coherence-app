import { getIntegrationByProvider, upsertIntegration, getOAuthCredential } from "../db";
import { refreshGoogleToken } from "../services/integrations/google";
import { refreshWhoopToken } from "../services/integrations/whoop";

// ---------------------------------------------------------------------------
// Generic token refresh
// ---------------------------------------------------------------------------

type TokenRefreshConfig = {
  provider: string;
  displayName: string;
  refreshFn: (
    refreshToken: string,
    clientId: string,
    clientSecret: string
  ) => Promise<{
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  }>;
};

async function getValidToken(
  userId: number,
  config: TokenRefreshConfig
): Promise<string> {
  const integration = await getIntegrationByProvider(userId, config.provider);

  if (!integration?.accessToken) {
    throw new Error(`${config.displayName} not connected`);
  }

  const now = new Date();
  const expiresAt = integration.expiresAt ? new Date(integration.expiresAt) : null;
  const needsRefresh =
    !expiresAt || expiresAt.getTime() - now.getTime() < 5 * 60 * 1000;

  if (needsRefresh && integration.refreshToken) {
    console.log(
      `[Token Refresh] ${config.displayName} token expired or expiring soon, refreshing...`
    );
    try {
      const creds = await getOAuthCredential(userId, config.provider);
      if (!creds?.clientId || !creds?.clientSecret) {
        throw new Error(
          `${config.displayName} OAuth credentials not configured`
        );
      }

      const tokenData = await config.refreshFn(
        integration.refreshToken,
        creds.clientId,
        creds.clientSecret
      );
      const newExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

      await upsertIntegration({
        ...integration,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || integration.refreshToken,
        expiresAt: newExpiresAt,
      });

      console.log(
        `[Token Refresh] ${config.displayName} token refreshed successfully`
      );
      return tokenData.access_token;
    } catch (error) {
      console.error(
        `[Token Refresh] Failed to refresh ${config.displayName} token:`,
        error
      );
      throw new Error(
        `Failed to refresh ${config.displayName} token. Please reconnect your ${config.displayName} account.`
      );
    }
  }

  return integration.accessToken;
}

// ---------------------------------------------------------------------------
// Provider-specific exports
// ---------------------------------------------------------------------------

export function getValidGoogleToken(userId: number): Promise<string> {
  return getValidToken(userId, {
    provider: "google",
    displayName: "Google",
    refreshFn: refreshGoogleToken,
  });
}

export function getValidWhoopToken(userId: number): Promise<string> {
  return getValidToken(userId, {
    provider: "whoop",
    displayName: "WHOOP",
    refreshFn: refreshWhoopToken,
  });
}
