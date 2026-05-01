import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "path";
import { defineConfig, type Plugin } from "vite";

/**
 * Phase 1.1 of the dashboard foundation repair (2026-04-30) —
 * generate a build ID at build time and inject it into both HTML
 * shells (`<meta name="build-id">`) and the service worker (the
 * `__BUILD_ID__` placeholder in `client/public/service-worker.js`).
 *
 * Format: `${epoch-millis}-${git-short-sha-or-fallback}`. Sortable,
 * unique per build, and human-readable in devtools. In dev the SW
 * isn't registered so we skip git lookup entirely and use "dev".
 */
function generateBuildId(): string {
  if (process.env.NODE_ENV === "development") return "dev";
  let gitSha = "local";
  try {
    gitSha = execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not in a git repo (CI without checkout, source tarball, etc.)
    // — fall through to "local". The build-id mismatch check still
    // works as long as the value is unique per deploy.
  }
  return `${Date.now()}-${gitSha}`;
}

const BUILD_ID = generateBuildId();

/**
 * Inject `BUILD_ID` into the build artifacts:
 *
 *   - HTML: replaces `%VITE_BUILD_ID%` in `index.html` and
 *     `solar-rec.html` via Vite's `transformIndexHtml` hook.
 *   - SW: replaces the `__BUILD_ID__` literal in
 *     `client/public/service-worker.js` after Vite has copied it
 *     to `dist/public/`. The closeBundle hook runs after every
 *     asset is written, so the SW file is guaranteed to exist
 *     at the rewrite point.
 */
function buildIdPlugin(): Plugin {
  return {
    name: "build-id-injector",
    transformIndexHtml(html) {
      return html.replace(/%VITE_BUILD_ID%/g, BUILD_ID);
    },
    closeBundle() {
      const swDistPath = path.resolve(
        import.meta.dirname,
        "dist/public/service-worker.js"
      );
      if (!fs.existsSync(swDistPath)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[buildIdPlugin] expected SW at ${swDistPath} but it was not present after build; skipping BUILD_ID injection`
        );
        return;
      }
      const original = fs.readFileSync(swDistPath, "utf-8");
      // Match only the BUILD_ID const declaration line, NOT every
      // occurrence of "__BUILD_ID__". Replacing globally would also
      // rewrite the dev-mode skip check
      // (`if (BUILD_ID === "__BUILD_ID__") return;`) and silently
      // disable build-id mismatch detection in prod, since the
      // injected value would compare equal to itself.
      const declRe = /const BUILD_ID = "__BUILD_ID__";/;
      if (!declRe.test(original)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[buildIdPlugin] SW at ${swDistPath} does not contain the BUILD_ID const declaration; build-id mismatch detection will be disabled`
        );
        return;
      }
      const updated = original.replace(
        declRe,
        `const BUILD_ID = "${BUILD_ID}";`
      );
      fs.writeFileSync(swDistPath, updated);
      // eslint-disable-next-line no-console
      console.log(
        `[buildIdPlugin] injected BUILD_ID="${BUILD_ID}" into ${path.relative(import.meta.dirname, swDistPath)}`
      );
    },
  };
}

const plugins = [react(), tailwindcss(), jsxLocPlugin(), buildIdPlugin()];

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      "@client": path.resolve(import.meta.dirname, "client", "src"),
      "@server": path.resolve(import.meta.dirname, "server"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "client", "index.html"),
        solarRec: path.resolve(import.meta.dirname, "client", "solar-rec.html"),
      },
    },
  },
  server: {
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1",
    ],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
