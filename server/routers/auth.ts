import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "../_core/cookies";
import {
  adminProcedure,
  publicProcedure,
  protectedProcedure,
  twoFactorPendingProcedure,
  router,
} from "../_core/trpc";
import { sdk } from "../_core/sdk";
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  generateTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  generateQrDataUrl,
  verifyTotpCode,
} from "../_core/totp";
import { parse as parseCookieHeader } from "cookie";
import {
  consumeRecoveryCode,
  deleteIntegration,
  deleteOAuthCredential,
  deleteRecoveryCodes,
  deleteTotpSecret,
  getOAuthCredential,
  getTotpSecret,
  getUnusedRecoveryCodeCount,
  getUserIntegrations,
  getUserPreferences,
  listRecentUserFeedback,
  listUserFeedback,
  markTotpVerified,
  saveRecoveryCodes,
  saveTotpSecret,
  submitUserFeedback,
  upsertOAuthCredential,
  upsertUserPreferences,
} from "../db";
import { toNonEmptyString } from "./helpers";
import { fetchMarketQuotes } from "../services/integrations/marketData";
import { fetchNewsHeadlines } from "../services/integrations/newsHeadlines";
import { fetchTrumpApprovalRatings } from "../services/core/approvalRatings";
import { fetchPoliticalOdds } from "../services/core/politicalOdds";
import { fetchMNSportsGames } from "../services/integrations/sports";

export const authRouter = router({
  me: publicProcedure.query(async (opts) => {
    if (!opts.ctx.user) return null;
    const totp = await getTotpSecret(opts.ctx.user.id);
    const has2FA = totp?.verified === true;
    return {
      ...opts.ctx.user,
      twoFactorEnabled: has2FA,
      twoFactorPending: has2FA && !opts.ctx.twoFactorVerified,
    };
  }),
  logout: publicProcedure.mutation(({ ctx }) => {
    const cookieOptions = getSessionCookieOptions(ctx.req);
    ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
    return {
      success: true,
    } as const;
  }),
});

export const twoFactorRouter = router({
  status: twoFactorPendingProcedure.query(async ({ ctx }) => {
    const totp = await getTotpSecret(ctx.user.id);
    const enabled = totp?.verified === true;
    const recoveryCodesRemaining = enabled ? await getUnusedRecoveryCodeCount(ctx.user.id) : 0;
    return { enabled, recoveryCodesRemaining };
  }),

  setup: protectedProcedure.mutation(async ({ ctx }) => {
    const { secret, otpauthUri } = generateTotpSecret(ctx.user.email || ctx.user.name || "user");
    const qrDataUrl = await generateQrDataUrl(otpauthUri);
    const recoveryCodes = generateRecoveryCodes();
    const codeHashes = recoveryCodes.map(hashRecoveryCode);

    await saveTotpSecret(ctx.user.id, secret);
    await saveRecoveryCodes(ctx.user.id, codeHashes);

    return { qrDataUrl, secret, recoveryCodes };
  }),

  confirmSetup: twoFactorPendingProcedure
    .input(z.object({ code: z.string().length(6) }))
    .mutation(async ({ ctx, input }) => {
      const totp = await getTotpSecret(ctx.user.id);
      if (!totp || totp.verified) {
        return { success: false, error: "No pending 2FA setup found" };
      }

      if (!verifyTotpCode(totp.secret, input.code)) {
        return { success: false, error: "Invalid code" };
      }

      await markTotpVerified(ctx.user.id);
      return { success: true };
    }),

  verify: twoFactorPendingProcedure
    .input(z.object({ code: z.string().min(1).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const totp = await getTotpSecret(ctx.user.id);
      if (!totp?.verified) {
        return { success: false, error: "2FA not enabled" };
      }

      const code = input.code.trim();
      let valid = false;

      // Try TOTP code first (6 digits)
      if (/^\d{6}$/.test(code)) {
        valid = verifyTotpCode(totp.secret, code);
      }

      // Try recovery code if TOTP didn't match
      if (!valid) {
        const hash = hashRecoveryCode(code);
        valid = await consumeRecoveryCode(ctx.user.id, hash);
      }

      if (!valid) {
        return { success: false, error: "Invalid code" };
      }

      // Re-sign JWT with twoFactorVerified: true
      const cookies = parseCookieHeader(ctx.req.headers.cookie ?? "");
      const sessionCookie = cookies[COOKIE_NAME];
      const newToken = await sdk.reissueSessionWith2FA(sessionCookie);
      if (newToken) {
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, newToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      }

      return { success: true };
    }),

  disable: protectedProcedure
    .input(z.object({ code: z.string().min(1).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const totp = await getTotpSecret(ctx.user.id);
      if (!totp?.verified) {
        return { success: false, error: "2FA not enabled" };
      }

      if (!verifyTotpCode(totp.secret, input.code.trim())) {
        return { success: false, error: "Invalid code" };
      }

      await deleteTotpSecret(ctx.user.id);
      await deleteRecoveryCodes(ctx.user.id);
      return { success: true };
    }),

  regenerateRecoveryCodes: protectedProcedure
    .input(z.object({ code: z.string().length(6) }))
    .mutation(async ({ ctx, input }) => {
      const totp = await getTotpSecret(ctx.user.id);
      if (!totp?.verified) {
        return { success: false, error: "2FA not enabled", recoveryCodes: [] };
      }

      if (!verifyTotpCode(totp.secret, input.code.trim())) {
        return { success: false, error: "Invalid code", recoveryCodes: [] };
      }

      const recoveryCodes = generateRecoveryCodes();
      const codeHashes = recoveryCodes.map(hashRecoveryCode);
      await saveRecoveryCodes(ctx.user.id, codeHashes);

      return { success: true, recoveryCodes };
    }),
});

export const integrationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return getUserIntegrations(ctx.user.id);
  }),
  delete: protectedProcedure.input(z.object({ id: z.string().max(64) })).mutation(async ({ input }) => {
    await deleteIntegration(input.id);
    return { success: true };
  }),
});

export const oauthCredsRouter = router({
  get: protectedProcedure
    .input(z.object({ provider: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      return getOAuthCredential(ctx.user.id, input.provider);
    }),
  save: protectedProcedure
    .input(
      z.object({
        provider: z.string().min(1).max(64),
        clientId: z.string().min(1).max(512),
        clientSecret: z.string().min(1).max(512),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await upsertOAuthCredential({
        id: nanoid(),
        userId: ctx.user.id,
        provider: input.provider,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
      });
      return { success: true };
    }),
  delete: protectedProcedure
    .input(z.object({ provider: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      await deleteOAuthCredential(ctx.user.id, input.provider);
      return { success: true };
    }),
});

export const preferencesRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    return getUserPreferences(ctx.user.id);
  }),
  update: protectedProcedure
    .input(
      z.object({
        displayName: z.string().max(120).nullable().optional(),
        enabledWidgets: z.string().optional(),
        widgetLayout: z.string().optional(),
        theme: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await upsertUserPreferences({
        id: nanoid(),
        userId: ctx.user.id,
        ...input,
      });
      return { success: true };
    }),
});

export const marketDashboardRouter = (() => {
  type MarketQuoteItem = Awaited<ReturnType<typeof fetchMarketQuotes>>[number];
  type HeadlineItem = Awaited<ReturnType<typeof fetchNewsHeadlines>>[number];
  type ApprovalRatingItem = Awaited<ReturnType<typeof fetchTrumpApprovalRatings>>[number];
  type PoliticalOddsItem = Awaited<ReturnType<typeof fetchPoliticalOdds>>[number];
  // In-memory cache with 5-minute TTL; stale data served if fresh fetch fails.
  const cacheBySymbolKey = new Map<string, {
    quotes: MarketQuoteItem[];
    headlines: HeadlineItem[];
    approvalRatings: ApprovalRatingItem[];
    politicalOdds: PoliticalOddsItem[];
    fetchedAt: string;
    marketRateLimited?: boolean;
    usingStaleQuotes?: boolean;
  }>();
  const cacheExpiryBySymbolKey = new Map<string, number>();
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const APPROVAL_FETCH_TIMEOUT_MS = 4_500;
  const POLITICAL_ODDS_FETCH_TIMEOUT_MS = 5_000;
  const DEFAULT_STOCK_SYMBOLS = ["GEVO", "MNTK", "PLUG", "ALTO", "REX"] as const;
  const DEFAULT_CRYPTO_SYMBOLS = ["BTC-USD", "ETH-USD"] as const;

  function normalizeStockSymbols(symbols: string[] | undefined): string[] {
    const raw = symbols?.length ? symbols : [...DEFAULT_STOCK_SYMBOLS];
    const seen = new Set<string>();
    const normalized: string[] = [];

    raw.forEach((symbol) => {
      const next = String(symbol ?? "").trim().toUpperCase().replace(/\s+/g, "");
      if (!next) return;
      if (!/^[A-Z0-9.\-]{1,20}$/.test(next)) return;
      if (seen.has(next)) return;
      seen.add(next);
      normalized.push(next);
    });

    return normalized.length > 0 ? normalized : [...DEFAULT_STOCK_SYMBOLS];
  }

  function normalizeCryptoSymbols(symbols: string[] | undefined): string[] {
    const raw = symbols?.length ? symbols : [...DEFAULT_CRYPTO_SYMBOLS];
    const seen = new Set<string>();
    const normalized: string[] = [];

    raw.forEach((symbol) => {
      const cleaned = String(symbol ?? "").trim().toUpperCase().replace(/\s+/g, "");
      if (!cleaned) return;
      const next = cleaned.includes("-") ? cleaned : `${cleaned}-USD`;
      if (!/^[A-Z0-9.\-]{1,20}$/.test(next)) return;
      if (seen.has(next)) return;
      seen.add(next);
      normalized.push(next);
    });

    return normalized.length > 0 ? normalized : [...DEFAULT_CRYPTO_SYMBOLS];
  }

  // Mirror of `getDashboardMarketSymbols` from the web client's
  // `lib/dashboardPreferences.ts`. Lets the server fall back to a
  // user's saved tickers when the caller (Android, etc.) doesn't pass
  // explicit symbols. Returns `null` lists rather than DEFAULT_*
  // so the caller can chain `?? userSymbols.X` without short-
  // circuiting on legitimate empty arrays.
  function parseDashboardSymbolsFromWidgetLayout(
    widgetLayout: string | null | undefined,
  ): { stocks: string[] | undefined; crypto: string[] | undefined } {
    if (!widgetLayout) return { stocks: undefined, crypto: undefined };
    let parsed: Record<string, unknown> = {};
    try {
      const json = JSON.parse(widgetLayout);
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
      }
    } catch {
      return { stocks: undefined, crypto: undefined };
    }
    function extract(field: string): string[] | undefined {
      const value = parsed[field];
      if (!Array.isArray(value)) return undefined;
      const list = value
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => entry.length > 0);
      return list.length > 0 ? list : undefined;
    }
    return {
      stocks: extract("dashboardMarketStockSymbols"),
      crypto: extract("dashboardMarketCryptoSymbols"),
    };
  }

  async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  return router({
    getMarketData: protectedProcedure
      .input(
        z.object({
          stockSymbols: z.array(z.string().min(1).max(20)).max(30).optional(),
          cryptoSymbols: z.array(z.string().min(1).max(20)).max(30).optional(),
        }).optional()
      )
      .query(async ({ ctx, input }) => {
      const now = Date.now();

      // Fall back to the user's saved tickers (stored in
      // userPreferences.widgetLayout under
      // `dashboardMarketStockSymbols` / `dashboardMarketCryptoSymbols`)
      // when the caller doesn't pass explicit symbols. The Android
      // client passes nothing, so without this lookup it'd see only
      // the hardcoded DEFAULT_*_SYMBOLS while the web — which reads
      // preferences locally and forwards them — sees the user's
      // configured tickers. (User report 2026-04-27.)
      const userPrefs =
        !input?.stockSymbols && !input?.cryptoSymbols
          ? await getUserPreferences(ctx.user.id).catch(() => null)
          : null;
      const userSymbols = parseDashboardSymbolsFromWidgetLayout(userPrefs?.widgetLayout ?? null);

      const stockSymbols = normalizeStockSymbols(
        input?.stockSymbols ?? userSymbols.stocks,
      );
      const cryptoSymbols = normalizeCryptoSymbols(
        input?.cryptoSymbols ?? userSymbols.crypto,
      );
      const combinedSymbols = Array.from(new Set([...stockSymbols, ...cryptoSymbols]));
      const symbolCacheKey = `stocks:${stockSymbols.join(",")}|crypto:${cryptoSymbols.join(",")}`;

      const cachedData = cacheBySymbolKey.get(symbolCacheKey) ?? null;
      const cacheExpiry = cacheExpiryBySymbolKey.get(symbolCacheKey) ?? 0;
      if (cachedData && now < cacheExpiry) {
        return cachedData;
      }

      try {
        const [quotesResult, headlinesResult, approvalResult, politicalOddsResult] = await Promise.allSettled([
          fetchMarketQuotes(combinedSymbols),
          fetchNewsHeadlines(),
          withTimeout(fetchTrumpApprovalRatings(), APPROVAL_FETCH_TIMEOUT_MS, [] as any[]),
          withTimeout(fetchPoliticalOdds(), POLITICAL_ODDS_FETCH_TIMEOUT_MS, [] as any[]),
        ]);

        const quotes = quotesResult.status === "fulfilled" ? quotesResult.value : [];
        const headlines = headlinesResult.status === "fulfilled" ? headlinesResult.value : [];
        const approvalRatings = approvalResult.status === "fulfilled" ? approvalResult.value : [];
        const politicalOdds = politicalOddsResult.status === "fulfilled" ? politicalOddsResult.value : [];
        const quotesError =
          quotesResult.status === "rejected" ? String((quotesResult.reason as any)?.message ?? quotesResult.reason ?? "") : "";
        const marketRateLimited =
          quotesResult.status === "rejected" &&
          /429|rate limit|too many requests/i.test(quotesError);

        if (quotesResult.status === "rejected") {
          console.warn("[MarketDashboard] Market quotes fetch failed:", quotesResult.reason);
        }
        if (headlinesResult.status === "rejected") {
          console.warn("[MarketDashboard] Headlines fetch failed:", headlinesResult.reason);
        }
        if (approvalResult.status === "rejected") {
          console.warn("[MarketDashboard] Approval ratings fetch failed:", approvalResult.reason);
        }
        if (politicalOddsResult.status === "rejected") {
          console.warn("[MarketDashboard] Political odds fetch failed:", politicalOddsResult.reason);
        }

        // If Yahoo is rate-limited, prefer serving the last good cached quotes
        // instead of returning an empty market section.
        if (marketRateLimited && cachedData?.quotes?.length) {
          const staleSafeData = {
            ...cachedData,
            headlines: headlines.length > 0 ? headlines : cachedData.headlines,
            approvalRatings:
              approvalRatings.length > 0 ? approvalRatings : cachedData.approvalRatings,
            politicalOdds:
              politicalOdds.length > 0 ? politicalOdds : cachedData.politicalOdds,
            marketRateLimited: true,
            usingStaleQuotes: true,
          };
          cacheBySymbolKey.set(symbolCacheKey, staleSafeData);
          cacheExpiryBySymbolKey.set(symbolCacheKey, now + CACHE_TTL_MS);
          return staleSafeData;
        }

        const freshData = {
          quotes,
          headlines,
          approvalRatings,
          politicalOdds,
          fetchedAt: new Date().toISOString(),
          marketRateLimited,
        };
        // Only update cache if we got meaningful data
        if (
          quotes.length > 0 ||
          headlines.length > 0 ||
          approvalRatings.length > 0 ||
          politicalOdds.length > 0
        ) {
          cacheBySymbolKey.set(symbolCacheKey, freshData);
          cacheExpiryBySymbolKey.set(symbolCacheKey, now + CACHE_TTL_MS);
        }
        return freshData;
      } catch (error) {
        console.warn("[MarketDashboard] Fetch failed, returning stale cache if available:", error);
        // Return stale data rather than nothing
        if (cachedData) return cachedData;
        return {
          quotes: [],
          headlines: [],
          approvalRatings: [],
          politicalOdds: [],
          fetchedAt: new Date().toISOString(),
        };
      }
    }),
  });
})();

export const sportsRouter = (() => {
  type SportsGame = Awaited<ReturnType<typeof fetchMNSportsGames>>[number];
  let cachedGames: SportsGame[] | null = null;
  let cacheExpiry = 0;
  // Live games: refresh every 30s. No live games: cache 5 minutes.
  const LIVE_CACHE_TTL = 30_000;
  const IDLE_CACHE_TTL = 5 * 60_000;

  return router({
    getGames: protectedProcedure.query(async () => {
      const now = Date.now();
      if (cachedGames && now < cacheExpiry) {
        return { games: cachedGames, fetchedAt: new Date(cacheExpiry - (cachedGames.some((g: SportsGame) => g.status === "in" || g.status === "halftime") ? LIVE_CACHE_TTL : IDLE_CACHE_TTL)).toISOString() };
      }

      try {
        const games = await fetchMNSportsGames();
        cachedGames = games;
        const hasLive = games.some(g => g.status === "in" || g.status === "halftime");
        cacheExpiry = now + (hasLive ? LIVE_CACHE_TTL : IDLE_CACHE_TTL);
        return { games, fetchedAt: new Date().toISOString() };
      } catch (error) {
        console.warn("[Sports] Fetch failed:", error);
        if (cachedGames) return { games: cachedGames, fetchedAt: new Date().toISOString(), stale: true };
        return { games: [], fetchedAt: new Date().toISOString() };
      }
    }),
  });
})();

export const feedbackRouter = router({
  submit: protectedProcedure
    .input(
      z.object({
        pagePath: z.string().min(1).max(255),
        sectionId: z.string().max(191).optional(),
        category: z
          .enum(["improvement", "bug", "ui", "data", "workflow", "other"])
          .optional(),
        note: z.string().min(3).max(4000),
        contextJson: z.string().max(16000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const row = await submitUserFeedback({
        userId: ctx.user.id,
        pagePath: input.pagePath.trim(),
        sectionId: toNonEmptyString(input.sectionId),
        category: input.category ?? "improvement",
        note: input.note.trim(),
        status: "open",
        contextJson: toNonEmptyString(input.contextJson),
      });

      return {
        success: Boolean(row),
        feedbackId: row?.id ?? null,
      };
    }),
  listMine: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      return listUserFeedback(ctx.user.id, input?.limit ?? 25);
    }),
  listRecent: adminProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(500).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      return listRecentUserFeedback(input?.limit ?? 200);
    }),
});
