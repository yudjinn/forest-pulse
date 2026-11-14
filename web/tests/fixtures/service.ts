// A second local service a journey starts and stops itself, on the port base's reserved second-service ports with
// its own fresh state. It serves the dist/ the main server already built.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { secondAppPort, secondInspectorPort, webRoot } from "../ports.ts";

export const secondServiceURL = `http://127.0.0.1:${secondAppPort}`;

export class SecondService {
  private proc: ChildProcess | null = null;

  async start(): Promise<void> {
    this.proc = spawn(process.execPath, [path.join(webRoot, "tests", "serve.ts")], {
      cwd: webRoot,
      env: {
        ...process.env,
        FP_E2E_APP_PORT: String(secondAppPort),
        FP_E2E_INSPECTOR_PORT: String(secondInspectorPort),
        FP_E2E_SKIP_BUILD: "1",
      },
      stdio: "ignore",
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) throw new Error(`second service exited with ${this.proc.exitCode}`);
      try {
        if ((await fetch(`${secondServiceURL}/`)).ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("second service did not start within 60 s");
  }

  // Stops the service and resolves once its process has exited.
  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill("SIGTERM");
    await exited;
  }
}
