// Trains a detector exactly as the teach request does, for teaching_pack.py: the one training function, run from Node.
// usage: node demo-kit/train_detector.ts <positives.f32> <negatives.f32>
// Both files are float32 little-endian rows of 960 summaries; prints {"weights": [...], "bias": n, "iterations": n}.
import { readFileSync } from "node:fs";
import { trainDetector } from "../web/src/teach/train.ts";

const rows = (file: string) => new Float32Array(new Uint8Array(readFileSync(file)).buffer);

const [positives, negatives] = process.argv.slice(2);
if (!positives || !negatives) {
  console.error("usage: node demo-kit/train_detector.ts <positives.f32> <negatives.f32>");
  process.exit(2);
}
process.stdout.write(JSON.stringify(trainDetector(rows(positives), rows(negatives))));
