import { parentPort } from "worker_threads";
import { pipeline } from "@huggingface/transformers";

let extractor = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", "Xenova/gte-small", { dtype: "q8" });
    parentPort.postMessage({ type: "ready" });
  }
  return extractor;
}

// Pre-warm the model on startup
getExtractor();

parentPort.on("message", async ({ id, text }) => {
  const ext = await getExtractor();
  const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
  const output = await ext(truncated, { pooling: "mean", normalize: true });
  const buffer = Buffer.from(output.data.buffer);
  parentPort.postMessage({ id, embedding: buffer });
});
