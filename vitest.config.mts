import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      // `server-only` throws outside a React Server bundle; it's a no-op in tests.
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.test.{ts,tsx}"],
          exclude: ["node_modules/**", ".next/**", "supabase/**", "tests/db/**"],
        },
      },
      {
        // Needs local Supabase running (`npm run db:start`).
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          // Supabase URL/keys for tests that go through the real API.
          env: loadEnv("test", process.cwd(), ""),
          testTimeout: 30_000,
        },
      },
    ],
  },
});
