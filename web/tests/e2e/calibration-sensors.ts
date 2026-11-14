// The simulated sensors' process for calibration journeys: the sensor library with its simulated hooks, several
// instances in one process sharing one simulated room (calibration_sensors.py, which lists the commands). Point it at
// any service by origin and sensor key: the local journeys use their own service and the dev key.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { webRoot } from "../ports.ts";

const python = path.join(webRoot, "..", ".venv", "bin", "python");

// Add and change boards by command; each command waits for its answer. The library's log is in `log`.
export class SimulatedSensors {
  private readonly proc: ChildProcess;
  private readonly lines: Interface;
  readonly log: string;

  constructor(origin: string, sensorKey: string) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fp-calibration-"));
    this.log = path.join(dir, "sensors.log");
    // The key goes in the environment, never the command line, which any process on the machine can list.
    this.proc = spawn(python, [path.join(webRoot, "tests", "e2e", "calibration_sensors.py"), origin, dir], {
      stdio: ["pipe", "pipe", openSync(this.log, "w")],
      env: { ...process.env, FP_SENSOR_KEY: sensorKey },
    });
    this.lines = createInterface({ input: this.proc.stdout! });
  }

  send(command: Record<string, unknown>): Promise<void> {
    const answer = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${JSON.stringify(command)}; see ${this.log}`)), 60_000);
      this.lines.once("line", (line) => {
        clearTimeout(timer);
        if (line === "ok") resolve();
        else reject(new Error(`${line} (log: ${this.log})`));
      });
    });
    this.proc.stdin!.write(JSON.stringify(command) + "\n");
    return answer;
  }

  // Stops every simulated sensor (they stop checking in) and resolves once the process has exited.
  async stop(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise((r) => this.proc.once("exit", r));
    await this.send({ stop: true }).catch(() => this.proc.kill());
    await exited;
  }
}
