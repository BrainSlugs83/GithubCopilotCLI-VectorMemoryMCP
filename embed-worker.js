import { parentPort } from "worker_threads";
import { pipeline } from "@huggingface/transformers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { statSync, rmSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = join(__dirname, "node_modules", "@huggingface", "transformers", ".cache",
  "Xenova", "gte-small");
const MODEL_PATH = join(MODEL_DIR, "onnx", "model_quantized.onnx");
const MIN_MODEL_SIZE = 5_000_000; // 5MB — real model is ~34MB

// Delete corrupt/truncated model so the library re-downloads it
try {
  const size = statSync(MODEL_PATH).size;
  if (size < MIN_MODEL_SIZE) {
    rmSync(MODEL_DIR, { recursive: true, force: true });
  }
} catch {}

let extractor = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getExtractor() {
  if (!extractor) {
    // Retry with backoff — Windows Defender can lock newly downloaded files
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        extractor = await pipeline("feature-extraction", "Xenova/gte-small", { dtype: "q8" });
        parentPort.postMessage({ type: "ready" });
        return extractor;
      } catch (err) {
        if (attempt === 3) throw err;
        await sleep(attempt * 3000);
      }
    }
  }
  return extractor;
}

// Pre-warm the model on startup
getExtractor().catch((err) => {
  parentPort.postMessage({ type: "error", message: err.message });
});

parentPort.on("message", async ({ id, text }) => {
  const ext = await getExtractor();
  const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
  const output = await ext(truncated, { pooling: "mean", normalize: true });
  const buffer = Buffer.from(output.data.buffer);
  parentPort.postMessage({ id, embedding: buffer });
});
