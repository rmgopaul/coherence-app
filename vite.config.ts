import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "path";
import { defineConfig } from "vite";


const plugins = [react(), tailwindcss(), jsxLocPlugin()];

export default defineConfig(({ mode }) => ({
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
    // "hidden" keeps source maps out of the shipped HTML/JS (no
    // //# sourceMappingURL=...) but still emits .map files so error
    // trackers can symbolicate traces server-side.
    sourcemap: "hidden",
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "client", "index.html"),
        solarRec: path.resolve(import.meta.dirname, "client", "solar-rec.html"),
      },
      output: {
        // Split heavy third-party libs into dedicated chunks so routes
        // that don't touch them skip the download, and routes that do
        // only pay for the shared chunk once (browser cache hit across
        // lazy-loaded tabs).
        //
        // Matches are scoped to `/node_modules/<pkg>/` to avoid false
        // positives from repo paths (e.g. `src/xlsx-helpers.ts`) or
        // unrelated packages whose names happen to share a substring.
        manualChunks(id) {
          const marker = "/node_modules/";
          const idx = id.lastIndexOf(marker);
          if (idx === -1) return undefined;
          const rest = id.slice(idx + marker.length);
          // Handle scoped packages: `@scope/name/...`
          const pkg = rest.startsWith("@")
            ? rest.split("/").slice(0, 2).join("/")
            : rest.split("/")[0];

          if (pkg === "pdfjs-dist") return "vendor-pdfjs";
          if (pkg === "jspdf" || pkg === "jspdf-autotable") return "vendor-jspdf";
          if (pkg === "xlsx") return "vendor-xlsx";
          if (pkg === "recharts") return "vendor-recharts";
          if (pkg.startsWith("@tiptap/") || pkg.startsWith("prosemirror-"))
            return "vendor-tiptap";
          if (
            pkg === "react-markdown" ||
            pkg === "remark-gfm" ||
            pkg.startsWith("remark-") ||
            pkg.startsWith("rehype-") ||
            pkg.startsWith("micromark") ||
            pkg.startsWith("mdast-") ||
            pkg.startsWith("hast-") ||
            pkg === "unified"
          )
            return "vendor-markdown";
          if (pkg === "framer-motion") return "vendor-framer";
          if (pkg === "date-fns") return "vendor-datefns";
          if (pkg.startsWith("@radix-ui/")) return "vendor-radix";
          return undefined;
        },
      },
    },
  },
  esbuild:
    mode === "production"
      ? {
          // Strip console.* and debugger statements from production bundles.
          drop: ["console", "debugger"],
        }
      : undefined,
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
}));
