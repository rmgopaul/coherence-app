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
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("pdfjs-dist")) return "vendor-pdfjs";
          if (id.includes("jspdf")) return "vendor-jspdf";
          if (id.includes("xlsx")) return "vendor-xlsx";
          if (id.includes("recharts")) return "vendor-recharts";
          if (id.includes("@tiptap") || id.includes("prosemirror")) return "vendor-tiptap";
          if (id.includes("react-markdown") || id.includes("remark") || id.includes("micromark") || id.includes("mdast"))
            return "vendor-markdown";
          if (id.includes("framer-motion")) return "vendor-framer";
          if (id.includes("date-fns")) return "vendor-datefns";
          if (id.includes("@radix-ui")) return "vendor-radix";
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
