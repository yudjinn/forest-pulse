// Starts the Worker locally on this run's ports with fresh local D1 and R2 state.
// Used by the journey harness and by hand checks: FP_E2E_PORT_BASE=8810 npm run serve
// FP_E2E_SKIP_BUILD=1 reuses the existing dist/ (a second service started while the first one serves it).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mirrorBucket } from "../scripts/deploy-bucket.ts";
import { appPort, inspectorPort, stateDir, webRoot } from "./ports.ts";

const wrangler = path.join(webRoot, "node_modules", ".bin", "wrangler");

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: webRoot, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

rmSync(stateDir, { recursive: true, force: true });
if (!process.env.FP_E2E_SKIP_BUILD) run("python3", ["build.py"]);

const devVars = path.join(webRoot, ".dev.vars");
if (!existsSync(devVars)) {
  writeFileSync(devVars, "DASHBOARD_PASSWORD=dev-password\nDEVICE_KEY=dev-key\nSESSION_SECRET=dev-session-secret\n");
}

// Seed steps, run in order on the fresh local state before the Worker starts. Additive only: add a step at the end,
// never reorder or rewrite one (docs/agents/ownership.md). Seed only what every run needs; a journey seeds its own
// prerequisites through the service.
const seedSteps: { name: string; run(): void }[] = [
  {
    name: "apply the D1 migrations",
    run: () => run(wrangler, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir]),
  },
  {
    name: "mirror the committed bucket data into local storage",
    run: () => mirrorBucket({ localStateDir: stateDir }),
  },
];
for (const step of seedSteps) {
  console.log(`seed: ${step.name}`);
  step.run();
}

const dev = spawn(
  wrangler,
  ["dev", "--ip", "127.0.0.1", "--port", String(appPort), "--inspector-port", String(inspectorPort),
   "--persist-to", stateDir, "--show-interactive-dev-session=false"],
  { cwd: webRoot, stdio: "inherit" },
);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => dev.kill(sig));
dev.on("exit", (code) => process.exit(code ?? 0));
