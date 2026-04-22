import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import axios from "axios";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Decode the OAuth state parameter.
 * Supports two formats:
 *  - Legacy: base64(redirectUri)
 *  - Extended: base64(JSON { r: redirectUri, p?: platform })
 */
function decodeOAuthState(state: string): {
  redirectUri: string;
  platform?: string;
} {
  const decoded = atob(state);
  try {
    const parsed = JSON.parse(decoded);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.r === "string") {
      return {
        redirectUri: parsed.r,
        platform: typeof parsed.p === "string" ? parsed.p : undefined,
      };
    }
  } catch {
    // Not JSON — legacy format
  }
  return { redirectUri: decoded };
}

/**
 * Extract Google's OAuth error code from an axios error so we can surface
 * `redirect_uri_mismatch`, `invalid_grant`, etc. to the client instead of a
 * generic 500. Secrets are never in the response body, so this is safe.
 */
function extractGoogleError(error: unknown): { code?: string; description?: string; status?: number } {
  if (!axios.isAxiosError(error)) return {};
  const data = error.response?.data;
  const status = error.response?.status;
  if (data && typeof data === "object") {
    const { error: code, error_description: description } = data as {
      error?: unknown;
      error_description?: unknown;
    };
    return {
      code: typeof code === "string" ? code : undefined,
      description: typeof description === "string" ? description : undefined,
      status,
    };
  }
  return { status };
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");
    const providerError = getQueryParam(req, "error");

    if (providerError) {
      console.error("[OAuth] Provider returned error", {
        error: providerError,
        description: getQueryParam(req, "error_description"),
      });
      res.status(400).json({
        error: "oauth_provider_error",
        provider_error: providerError,
        description: getQueryParam(req, "error_description"),
      });
      return;
    }

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    let redirectUri: string;
    let platform: string | undefined;
    try {
      ({ redirectUri, platform } = decodeOAuthState(state));
    } catch (error) {
      console.error("[OAuth] Failed to decode state", error);
      res.status(400).json({ error: "invalid_state" });
      return;
    }

    let tokenResponse;
    try {
      tokenResponse = await sdk.exchangeCodeForToken(code, redirectUri);
    } catch (error) {
      const googleError = extractGoogleError(error);
      console.error("[OAuth] Token exchange failed", {
        redirectUri,
        platform,
        ...googleError,
        message: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        error: "token_exchange_failed",
        step: "exchangeCodeForToken",
        provider_error: googleError.code,
        description: googleError.description,
      });
      return;
    }

    let userInfo;
    try {
      userInfo = await sdk.getUserInfo(tokenResponse.access_token);
    } catch (error) {
      const googleError = extractGoogleError(error);
      console.error("[OAuth] User info fetch failed", {
        ...googleError,
        message: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({
        error: "userinfo_failed",
        step: "getUserInfo",
        provider_error: googleError.code,
        description: googleError.description,
      });
      return;
    }

    if (!userInfo.openId) {
      res.status(400).json({ error: "openId missing from user info" });
      return;
    }

    try {
      // Migration: if a user exists with this email but a different openId
      // (e.g., from a previous OAuth provider), update their openId to the
      // new Google one so all integrations carry over seamlessly.
      if (userInfo.email) {
        const existingByEmail = await db.getUserByEmail(userInfo.email);
        if (existingByEmail && existingByEmail.openId !== userInfo.openId) {
          // Also clean up any orphan record that may have been created with
          // the new openId from a prior login attempt.
          const orphan = await db.getUserByOpenId(userInfo.openId);
          if (orphan && orphan.id !== existingByEmail.id) {
            console.log(`[OAuth] Removing orphan user ${orphan.id} (openId: ${userInfo.openId})`);
            await db.deleteUser(orphan.id);
          }

          console.log(
            `[OAuth] Migrating user ${existingByEmail.id} openId: ${existingByEmail.openId} -> ${userInfo.openId}`
          );
          await db.updateUserOpenId(existingByEmail.id, userInfo.openId);
        }
      }

      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod,
        lastSignedIn: new Date(),
      });

      // Check if user has 2FA enabled to set twoFactorVerified in the JWT
      const user = await db.getUserByOpenId(userInfo.openId);
      const totpSecret = user ? await db.getTotpSecret(user.id) : undefined;
      const has2FA = totpSecret?.verified === true;

      // Android app has its own PIN gate, so skip the 2FA challenge.
      // Web users still go through the normal 2FA verification flow.
      const skip2FA = platform === "android";

      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
        twoFactorVerified: skip2FA || !has2FA,
      });

      if (platform === "android") {
        // Android app: redirect to custom scheme with token in URL
        const callbackUrl = `coherence://auth-callback?token=${encodeURIComponent(sessionToken)}`;
        res.redirect(302, callbackUrl);
      } else {
        // Web: set session cookie and redirect to dashboard
        const cookieOptions = getSessionCookieOptions(req);
        res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
        res.redirect(302, "/");
      }
    } catch (error) {
      console.error("[OAuth] Session creation failed", error);
      res.status(500).json({
        error: "session_creation_failed",
        step: "persistUserAndSign",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
