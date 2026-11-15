// The Forest Pulse Worker: the researchers' dashboard, its public demo and the sensor API.
import type { Env } from "./env.ts";
import { route } from "./router.ts";
import { hooks, routes } from "./routes.ts";

export default {
  fetch(request, env, ctx) {
    return route(request, env, ctx, routes, hooks);
  },
} satisfies ExportedHandler<Env>;
