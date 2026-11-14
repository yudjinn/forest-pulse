// Bindings and secrets the Worker reads (see wrangler.jsonc; secrets are Worker secrets, locally web/.dev.vars).
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  STORAGE: R2Bucket;
  DASHBOARD_PASSWORD?: string;
  DEVICE_KEY?: string;
  SESSION_SECRET?: string;
}
