import { getIntegrationByProvider, upsertIntegration, getOAuthCredential } from "../db";
import { refreshGoogleToken } from "../services/google";
import { refreshMicrosoftToken } from "../services/microsoft";
import { refreshWhoopToken } from "../services/whoop";

export async function getValidGoogleToken(userId: number): Promise<string> {
  const integration = await getIntegrationByProvider(userId, "google");
  
  if (!integration?.accessToken) {
    throw new Error("Google not connected");
  }

  // Check if token is expired or will expire in the next 5 minutes
  const now = new Date();
  const expiresAt = integration.expiresAt ? new Date(integration.expiresAt) : null;
  const needsRefresh = !expiresAt || expiresAt.getTime() - now.getTime() < 5 * 60 * 1000;

  if (needsRefresh && integration.refreshToken) {
    console.log("[Token Refresh] Google token expired or expiring soon, refreshing...");
    try {
      // Get OAuth credentials from database
      const creds = await getOAuthCredential(userId, "google");
      if (!creds?.clientId || !creds?.clientSecret) {
        throw new Error("Google OAuth credentials not configured");
      }

      const tokenData = await refreshGoogleToken(integration.refreshToken, creds.clientId, creds.clientSecret);
      const newExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

      // Update the integration with new token
      await upsertIntegration({
        ...integration,
        accessToken: tokenData.access_token,
        expiresAt: newExpiresAt,
      });

      console.log("[Token Refresh] Google token refreshed successfully");
      return tokenData.access_token;
    } catch (error) {
      console.error("[Token Refresh] Failed to refresh Google token:", error);
      throw new Error("Failed to refresh Google token. Please reconnect your Google account.");
    }
  }

  return integration.accessToken;
}

export async function getValidMicrosoftToken(userId: number): Promise<string> {
  const integration = await getIntegrationByProvider(userId, "microsoft");
  
  if (!integration?.accessToken) {
    throw new Error("Microsoft not connected");
  }

  // Check if token is expired or will expire in the next 5 minutes
  const now = new Date();
  const expiresAt = integration.expiresAt ? new Date(integration.expiresAt) : null;
  const needsRefresh = !expiresAt || expiresAt.getTime() - now.getTime() < 5 * 60 * 1000;

  if (needsRefresh && integration.refreshToken) {
    console.log("[Token Refresh] Microsoft token expired or expiring soon, refreshing...");
    try {
      const tokenData = await refreshMicrosoftToken(integration.refreshToken);
      const newExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

      // Update the integration with new token
      await upsertIntegration({
        ...integration,
        accessToken: tokenData.access_token,
        expiresAt: newExpiresAt,
      });

      console.log("[Token Refresh] Microsoft token refreshed successfully");
      return tokenData.access_token;
    } catch (error) {
      console.error("[Token Refresh] Failed to refresh Microsoft token:", error);
      throw new Error("Failed to refresh Microsoft token. Please reconnect your Microsoft account.");
    }
  }

  return integration.accessToken;
}

export async function getValidWhoopToken(userId: number): Promise<string> {
  const integration = await getIntegrationByProvider(userId, "whoop");

  if (!integration?.accessToken) {
    throw new Error("WHOOP not connected");
  }

  const now = new Date();
  const expiresAt = integration.expiresAt ? new Date(integration.expiresAt) : null;
  const needsRefresh = !expiresAt || expiresAt.getTime() - now.getTime() < 5 * 60 * 1000;

  if (needsRefresh && integration.refreshToken) {
    console.log("[Token Refresh] WHOOP token expired or expiring soon, refreshing...");
    try {
      const creds = await getOAuthCredential(userId, "whoop");
      if (!creds?.clientId || !creds?.clientSecret) {
        throw new Error("WHOOP OAuth credentials not configured");
      }

      const tokenData = await refreshWhoopToken(
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

      console.log("[Token Refresh] WHOOP token refreshed successfully");
      return tokenData.access_token;
    } catch (error) {
      console.error("[Token Refresh] Failed to refresh WHOOP token:", error);
      throw new Error("Failed to refresh WHOOP token. Please reconnect your WHOOP account.");
    }
  }

  return integration.accessToken;
}
