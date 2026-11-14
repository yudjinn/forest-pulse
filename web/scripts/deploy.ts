// The one way to deploy the live site: `npm run deploy` from web/ (see web/README.md). Safe to repeat.
//   1. the live Worker has every secret it reads (names only, never values)
//   2. build the site
//   3. the live D1 database exists (created in its configured jurisdiction on the first run)
//   4. apply pending migrations to it (by recorded set; nothing to do on a repeat)
//   5. upload the committed bucket data to the live bucket (overwrite by name)
//   6. deploy the Worker
// A step that fails stops the run before the Worker is deployed, so the live site keeps its current version.
// `--require-secret NAME` adds a required name, to prove the missing-secret stop without touching live secrets.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import path from "node:path";
import { mirrorBucket, webRoot, wrangler, wranglerConfig } from "./deploy-bucket.ts";

// The secrets the Worker reads (src/env.ts).
const REQUIRED_SECRETS = ["DASHBOARD_PASSWORD", "DEVICE_KEY", "SESSION_SECRET"];

class Stop extends Error {}

// Pin the account for every Wrangler call: some commands do not read it from the config and would otherwise ask.
let env: NodeJS.ProcessEnv = process.env;

function required(argv: string[]): string[] {
  const names = [...REQUIRED_SECRETS];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--require-secret" && argv[i + 1]) names.push(argv[++i]);
    else throw new Stop(`unknown option "${argv[i]}" (the only option is --require-secret NAME)`);
  }
  return names;
}

// Runs Wrangler with no terminal on stdin, so it never stops to ask. Returns its output when `capture` is set.
function run(cmd: string, args: string[], capture = false): string {
  const stdio: SpawnSyncOptions["stdio"] = ["ignore", capture ? "pipe" : "inherit", "inherit"];
  const r = spawnSync(cmd, args, { cwd: webRoot, env, encoding: "utf8", stdio });
  if (r.status !== 0) {
    if (capture && r.stdout) process.stdout.write(String(r.stdout));
    throw new Stop(`"${path.basename(cmd)} ${args.slice(0, 3).join(" ")}" failed (see above)`);
  }
  return capture ? String(r.stdout) : "";
}

function json<T>(output: string): T {
  const start = output.search(/[[{]/);
  return JSON.parse(output.slice(start)) as T;
}

function step(n: number, what: string) {
  console.log(`\n[deploy ${n}/6] ${what}`);
}

async function main() {
  const names = required(process.argv.slice(2));
  const config = wranglerConfig();
  if (config.account_id) env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.account_id };
  const database = config.d1_databases.find((d) => d.binding === "DB");
  if (!database?.database_name) throw new Stop("wrangler.jsonc has no D1 database bound as DB");
  const databaseName = database.database_name;

  step(1, "checking the live Worker's secrets");
  const secrets = json<{ name: string }[]>(run(wrangler, ["secret", "list", "--format", "json"], true));
  const present = new Set(secrets.map((s) => s.name));
  const missing = names.filter((n) => !present.has(n));
  if (missing.length > 0) {
    throw new Stop(`the live Worker has no secret ${missing.join(", ")}. Set it with "npx wrangler secret put <NAME>" and deploy again.`);
  }
  console.log(`present: ${names.join(", ")}`);

  step(2, "building the site");
  run("python3", ["build.py"]);

  step(3, `checking the live D1 database "${databaseName}"`);
  const databases = json<{ name: string; jurisdiction: string | null }[]>(run(wrangler, ["d1", "list", "--json"], true));
  const live = databases.find((d) => d.name === databaseName);
  if (live) {
    console.log(`exists (jurisdiction ${live.jurisdiction ?? "default"})`);
  } else {
    const where = database.jurisdiction ? ["--jurisdiction", database.jurisdiction] : [];
    run(wrangler, ["d1", "create", databaseName, ...where]);
  }

  step(4, "applying pending migrations");
  const migrated = run(wrangler, ["d1", "migrations", "apply", "DB", "--remote"], true);
  process.stdout.write(migrated);

  step(5, "uploading the bucket data");
  const count = mirrorBucket({ remote: true, env });
  console.log(count === 0 ? "nothing to upload" : `uploaded ${count} object(s)`);

  step(6, "deploying the Worker");
  run(wrangler, ["deploy"]);
  console.log('\nDeployed. To go back to the previous version: npx wrangler rollback --message "<why>"');
}

try {
  await main();
} catch (e) {
  const reason = e instanceof Stop ? e.message : String(e instanceof Error ? e.message : e);
  console.error(`\nDeploy stopped: ${reason}\nThe Worker was not deployed; the live site keeps its current version.`);
  process.exit(1);
}
