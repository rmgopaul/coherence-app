import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client/src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "server/**/*.spec.ts",
      "client/src/solar-rec-dashboard/**/*.test.ts",
      "client/src/features/dashboard/frontpage/**/*.test.ts",
      "client/src/features/dashboard/river/**/*.test.ts",
      "client/src/features/supplements/**/*.test.ts",
      "client/src/features/habits/**/*.test.ts",
      "client/src/features/health/**/*.test.ts",
      "shared/**/*.test.ts",
    ],
    env: {
      TZ: "America/Chicago",
    },
  },
});
