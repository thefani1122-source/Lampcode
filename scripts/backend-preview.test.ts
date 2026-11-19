import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/preview/e2b-service.ts", import.meta.url), "utf8");
const backendStart = source.indexOf("async function ensureBackendServer");
const backendEnd = source.indexOf("// Recent backend stdout/stderr", backendStart);
assert.ok(backendStart >= 0 && backendEnd > backendStart, "backend lifecycle helper must exist");
const backend = source.slice(backendStart, backendEnd);

assert.ok(
  backend.includes("/opt/lampcode-python/bin/python3 -m uvicorn main:app"),
  "FastAPI must use the dedicated Ubuntu Python venv rather than a system-Python fallback",
);
assert.ok(
  backend.includes("BACKEND_READY_HTTP_"),
  "background process acceptance is not readiness; an HTTP response must be observed",
);
assert.ok(
  backend.includes("timeoutMs: 45_000"),
  "backend readiness polling must have a bounded timeout",
);
assert.ok(
  backend.includes("backend did not respond on port 3001 after startup"),
  "a backend that never becomes ready must return a diagnostic error",
);
assert.ok(
  backend.includes("Failed to start the "),
  "a failed background command must be surfaced to the preview caller",
);

const ensureDevStart = source.indexOf("async function ensureDevServer");
const ensureDevEnd = source.indexOf("/**\n * Starts the app's REAL backend", ensureDevStart);
assert.ok(ensureDevStart >= 0 && ensureDevEnd > ensureDevStart, "preview readiness function must exist");
const ensureDev = source.slice(ensureDevStart, ensureDevEnd);
assert.ok(
  ensureDev.includes("await ensureBackendServer(sandbox, log);"),
  "backend failure must propagate instead of being swallowed",
);
assert.ok(
  !ensureDev.includes("ensureBackendServer(sandbox, log).catch(() => {})"),
  "frontend preview must not be reported ready after backend startup failure",
);

console.log("Backend preview readiness contract tests passed.");
