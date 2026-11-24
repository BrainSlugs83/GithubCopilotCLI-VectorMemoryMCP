import { parentPort } from "worker_threads";
import { pipeline } from "@huggingface/transformers";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";
import { memoizeAsync, purgeIncompleteModel, markModelComplete } from "./lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = join(__dirname, "node_modules", "@huggingface", "transformers", ".cache",
  "Xenova", "gte-small");
const MODEL_FILES = {
  modelDir: MODEL_DIR,
  modelPath: join(MODEL_DIR, "onnx", "model_quantized.onnx"),
  markerPath: join(MODEL_DIR, ".complete"),
};

function purge() {
  try {
    if (purgeIncompleteModel(MODEL_FILES, fs)) {
      process.stderr.write("[vector-memory] Deleted incomplete embedding model; re-downloading.\n");
    }
  } catch (err) {
    process.stderr.write(`[vector-memory] Could not delete incomplete model: ${err.message}\n`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every caller shares ONE load. Parallel loads would read the half-written download
// (EACCES / "Protobuf parsing failed"), crash this thread and truncate the download.
const getExtractor = memoizeAsync(async () => {
  for (let attempt = 1; ; attempt++) {
    purge();
    try {
      const extractor = await pipeline("feature-extraction", "Xenova/gte-small", { dtype: "q8" });
      markModelComplete(MODEL_FILES, fs);
      parentPort.postMessage({ type: "ready" });
      return extractor;
    } catch (err) {
      // Retry with backoff -- Windows Defender can lock newly downloaded files
      if (attempt === 3) throw err;
      await sleep(attempt * 3000);
    }
  }
});

// Pre-warm the model on startup
getExtractor().catch((err) => {
  parentPort.postMessage({ type: "error", message: err.message });
});

parentPort.on("message", async ({ id, text }) => {
  try {
    const ext = await getExtractor();
    const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
    const output = await ext(truncated, { pooling: "mean", normalize: true });
    const buffer = Buffer.from(output.data.buffer);
    parentPort.postMessage({ id, embedding: buffer });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
