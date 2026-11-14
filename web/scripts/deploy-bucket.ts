// The committed bucket data in web/bucket/, mirrored into the STORAGE bucket by relative path: web/bucket/player/a.wav
// is the object "player/a.wav". The deploy uploads it to the live bucket and the journey harness seeds local storage
// with it, so both hold the same objects. Objects are overwritten by name and never deleted: the bucket also holds
// files the service writes itself. web/bucket/README.md and dotfiles are not data and are never uploaded.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const bucketDir = path.join(webRoot, "bucket");
export const wrangler = path.join(webRoot, "node_modules", ".bin", "wrangler");

// R2 keeps one content type per object, served back as is; anything not listed is stored without one.
const CONTENT_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

export interface BucketObject {
  key: string;
  file: string;
  contentType: string | undefined;
}

// Every committed object, in key order.
export function bucketObjects(): BucketObject[] {
  const found: BucketObject[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = path.join(dir, entry.name);
      const key = prefix + entry.name;
      if (entry.isDirectory()) walk(file, key + "/");
      else if (entry.isFile() && key !== "README.md") {
        found.push({ key, file, contentType: CONTENT_TYPES[path.extname(entry.name).toLowerCase()] });
      }
    }
  };
  walk(bucketDir, "");
  return found.sort((a, b) => (a.key < b.key ? -1 : 1));
}

// The parts of wrangler.jsonc the deploy reads, through Wrangler's own config reader (loaded only when needed: it
// takes most of a second). Wrangler does not ship the config's type, so the shape is declared here.
export interface WranglerConfig {
  account_id?: string;
  d1_databases: { binding: string; database_name?: string; jurisdiction?: string }[];
  r2_buckets: { binding: string; bucket_name?: string; jurisdiction?: string }[];
}

export function wranglerConfig(): WranglerConfig {
  const { unstable_readConfig } = createRequire(import.meta.url)("wrangler") as typeof import("wrangler");
  return unstable_readConfig({ config: path.join(webRoot, "wrangler.jsonc") }) as WranglerConfig;
}

export interface StorageBucket {
  name: string;
  jurisdiction?: string;
}

// The bucket bound as STORAGE.
export function storageBucket(): StorageBucket {
  const bucket = wranglerConfig().r2_buckets.find((b) => b.binding === "STORAGE");
  if (!bucket?.bucket_name) throw new Error("wrangler.jsonc has no R2 bucket bound as STORAGE");
  return { name: bucket.bucket_name, jurisdiction: bucket.jurisdiction };
}

export type BucketTarget = { remote: true; env?: NodeJS.ProcessEnv } | { localStateDir: string };

// Uploads every committed object to the target and returns how many. Throws if an upload fails.
export function mirrorBucket(target: BucketTarget): number {
  const objects = bucketObjects();
  if (objects.length === 0) return 0;
  if ("localStateDir" in target) {
    // Every service start pays for this, twice in a journey that starts a second service, so it is one local runtime
    // in a child process (about 1 s) that sets each object's own content type, never a `wrangler r2 bulk put` launch
    // per content type (about 2 s each).
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--local", target.localStateDir], {
      cwd: webRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (r.status !== 0) throw new Error("seeding the local bucket failed");
    return objects.length;
  }
  const bucket = storageBucket();
  const where = ["--remote", ...(bucket.jurisdiction ? ["--jurisdiction", bucket.jurisdiction] : [])];
  const byType = new Map<string | undefined, BucketObject[]>();
  for (const o of objects) byType.set(o.contentType, [...(byType.get(o.contentType) ?? []), o]);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "fp-bucket-"));
  try {
    for (const [contentType, group] of byType) {
      const manifest = path.join(tmp, "objects.json");
      writeFileSync(manifest, JSON.stringify(group.map(({ key, file }) => ({ key, file }))));
      const args = ["r2", "bulk", "put", bucket.name, "--filename", manifest, ...where];
      if (contentType) args.push("--content-type", contentType);
      const r = spawnSync(wrangler, args, { cwd: webRoot, stdio: ["ignore", "inherit", "inherit"], env: target.env });
      if (r.status !== 0) throw new Error(`uploading the bucket data to "${bucket.name}" failed`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return objects.length;
}

interface LocalBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

// Puts every object into the local STORAGE bucket that `wrangler dev --persist-to <stateDir>` serves.
async function putLocal(stateDir: string) {
  const { getPlatformProxy } = await import("wrangler");
  // getPlatformProxy persists to the folder itself; `wrangler dev --persist-to <dir>` keeps its state in <dir>/v3.
  const proxy = await getPlatformProxy<{ STORAGE: LocalBucket }>({
    configPath: path.join(webRoot, "wrangler.jsonc"),
    persist: { path: path.join(stateDir, "v3") },
  });
  try {
    for (const o of bucketObjects()) {
      const contentType = o.contentType;
      await proxy.env.STORAGE.put(o.key, readFileSync(o.file), contentType ? { httpMetadata: { contentType } } : {});
    }
  } finally {
    await proxy.dispose();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--local" && process.argv[3]) {
  await putLocal(process.argv[3]);
}
