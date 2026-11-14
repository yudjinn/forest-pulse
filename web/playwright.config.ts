import { defineConfig } from "@playwright/test";
import { baseURL } from "./tests/ports.ts";

export default defineConfig({
  testDir: "tests/e2e",
  workers: Number(process.env.FP_E2E_WORKERS ?? 2),
  reporter: process.env.CI ? "dot" : "list",
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: "node tests/serve.ts",
    url: `${baseURL}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
