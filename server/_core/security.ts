import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import type { Express } from "express";
import { ENV } from "./env";

/**
 * Registers security middleware: Helmet (HTTP headers), CORS, and rate limiting.
 * Must be called before any route handlers.
 */
export function registerSecurityMiddleware(app: Express) {
  // ── Helmet: secure HTTP headers ──
  app.use(
    helmet({
      contentSecurityPolicy: ENV.isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:", "https:"],
              connectSrc: [
                "'self'",
                "https://api.openai.com",
                "https://api.todoist.com",
                "https://www.googleapis.com",
                "https://graph.microsoft.com",
              ],
              fontSrc: ["'self'", "data:"],
              objectSrc: ["'none'"],
              frameAncestors: ["'none'"],
              upgradeInsecureRequests: [],
            },
          }
        : false, // Disable CSP in development (Vite injects inline scripts)
      crossOriginEmbedderPolicy: false, // Allow loading external images/resources
    })
  );

  // ── CORS ──
  const allowedOrigins = ENV.publishedUrl
    ? [ENV.publishedUrl.replace(/\/$/, "")]
    : [`http://localhost:${process.env.PORT || "3000"}`];

  app.use(
    cors({
      origin: ENV.isProduction
        ? allowedOrigins
        : true, // Allow all origins in development
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );

  // ── Rate limiting ──
  // General API rate limit: 100 requests per minute per IP
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });
  app.use("/api", apiLimiter);

  // Stricter limit for auth-related endpoints: 20 requests per minute per IP
  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication attempts, please try again later." },
  });
  app.use("/api/oauth", authLimiter);
}
