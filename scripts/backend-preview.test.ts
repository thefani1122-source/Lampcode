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


// Optional animation/3D imports are installed only when a generated project
// actually uses them. These contracts stop a refactor from dropping scoped
// package detection or starting the dev server before the install completes.
const importScannerStart = source.indexOf("export function importedPackages(");
const importScannerEnd = source.indexOf("async function installExtraDependencies(", importScannerStart);
assert.ok(importScannerStart >= 0 && importScannerEnd > importScannerStart, "generated import scanner must exist");
const importScanner = source.slice(importScannerStart, importScannerEnd);
assert.ok(importScanner.includes("spec.startsWith(\"@\") ? parts.slice(0, 2).join(\"/\") : parts[0]"), "scoped imports such as @react-three/fiber must resolve to the package name");
assert.ok(importScanner.includes("spec.startsWith(\"node:\")"), "Node built-ins must not be installed from npm");
assert.ok(importScanner.includes("spec.startsWith(\".\")"), "relative imports must not be installed from npm");

const installerStart = source.indexOf("async function installExtraDependencies(");
const installerEnd = source.indexOf("// NOTE: no runtime `npm install`", installerStart);
assert.ok(installerStart >= 0 && installerEnd > installerStart, "optional dependency installer must exist");
const installer = source.slice(installerStart, installerEnd);
assert.ok(installer.includes("[...new Set([...declaredNames, ...importedPackages(files)])]"), "both declared dependencies and actual imports must be considered");
assert.ok(installer.includes("valid.slice(0, MAX_EXTRA_DEPS)"), "optional npm installs must be capped");
assert.ok(source.includes("const MAX_EXTRA_DEPS = 12;"), "optional installs must have a finite per-build package cap");
assert.ok(source.includes("const NPM_NAME_RE = /^(@[a-z0-9~]"), "scoped package names must be validated before shell execution");

const firstWrite = source.indexOf("await writeFiles(sandbox, files, log);");
const firstInstall = source.indexOf("await installExtraDependencies(sandbox, files, log);", firstWrite);
const firstDev = source.indexOf("await ensureDevServer(sandbox, log, framework);", firstWrite);
assert.ok(firstWrite >= 0 && firstInstall > firstWrite && firstDev > firstInstall, "initial boot must install optional dependencies before starting the dev server");
const updateWrite = source.indexOf("await writeFiles(sandbox, files, log);", firstWrite + 1);
const updateInstall = source.indexOf("await installExtraDependencies(sandbox, files, log);", updateWrite);
const updateDev = source.indexOf("await ensureDevServer(sandbox, log, framework);", updateWrite);
assert.ok(updateWrite > firstWrite && updateInstall > updateWrite && updateDev > updateInstall, "follow-up edits must install optional dependencies before restarting the dev server");
console.log("Backend preview readiness contract tests passed.");
