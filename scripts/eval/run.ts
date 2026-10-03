/**
 * Eval runner — drives real builds through the real API and scores them.
 *
 * It deliberately talks HTTP, not the internals: it creates a project, posts to
 * /api/build/fast, polls /api/build/:id/status and reads the generated files
 * back the same way the frontend does. So it exercises the actual path a user
 * takes, against whatever is deployed, and it can be pointed at production or a
 * local `npm run dev` without any code change.
 *
 * It costs real money. Every task is a real build: model tokens and an E2B
 * sandbox. Four smoke tasks is a pulse check; the full set is twenty builds.
 *
 *   EVAL_EMAIL=you@example.com EVAL_PASSWORD=… EVAL_SUPABASE_ANON_KEY=… \
 *   EVAL_BASE_URL=https://lampcode-production.up.railway.app \
 *     npx tsx scripts/eval/run.ts --tier smoke
 *
 * It signs in itself and refreshes the session, because a full run outlasts the
 * one-hour life of a Supabase access token. See auth.ts.
 *
 * Flags:
 *   --tier smoke|core|hard   repeatable; default smoke
 *   --only id,id             run exactly these task ids, ignoring tiers
 *   --concurrency N          parallel builds, default 1
 *   --label text             stored on the run, e.g. "agentic+split-prompt"
 *   --timeout N              per-build seconds, default 900
 *   --keep-projects          leave the projects unarchived afterwards
 *   --dry-run                print what would run, spend nothing
 *
 * Results are written to eval-results/<timestamp>.json. Score them with
 * `npx tsx scripts/eval/report.ts` — see README.md in this directory.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tasksFor, type EvalTask } from "./tasks.js";
import { collectFiles, scoreChecks, type BuildOutcome, type FileEntry } from "./score.js";
import { createTokenProvider, type TokenProvider } from "./auth.js";

// ── Config ────────────────────────────────────────────────────────────────────

const BASE_URL = (process.env["EVAL_BASE_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
// Created in main(), after --dry-run has had its chance to exit — a dry run
// must not need credentials.
let auth: TokenProvider | null = null;
const RESULTS_DIR = join(process.cwd(), "eval-results");
const POLL_INTERVAL_MS = 5_000;

type Args = {
  tiers: Array<EvalTask["tier"]>;
  only: string[];
  concurrency: number;
  label: string;
  timeoutSec: number;
  keepProjects: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    tiers: [],
    only: [],
    concurrency: 1,
    label: "",
    timeoutSec: 900,
    keepProjects: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--tier") {
      const t = next();
      if (t === "smoke" || t === "core" || t === "hard") out.tiers.push(t);
      else throw new Error(`Unknown tier "${t}" — expected smoke, core or hard.`);
    } else if (a === "--only") {
      out.only = next().split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--concurrency") {
      out.concurrency = Math.max(1, Number.parseInt(next(), 10) || 1);
    } else if (a === "--label") {
      out.label = next();
    } else if (a === "--timeout") {
      out.timeoutSec = Math.max(60, Number.parseInt(next(), 10) || 900);
    } else if (a === "--keep-projects") {
      out.keepProjects = true;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--help" || a === "-h") {
      console.log(HELP);
      process.exit(0);
    } else if (a !== undefined) {
      throw new Error(`Unknown flag "${a}". Run with --help.`);
    }
  }
  if (out.tiers.length === 0 && out.only.length === 0) out.tiers = ["smoke"];
  return out;
}

const HELP = `
scripts/eval/run.ts — run the fixed eval set against a deployed Lampcode.

  EVAL_EMAIL / EVAL_PASSWORD           the account that may build (admin, while WAITLIST_MODE is on)
  EVAL_SUPABASE_ANON_KEY               the PUBLIC client key, as the frontend ships it
  EVAL_TOKEN                           alternative to the above; expires in ~1h, no refresh
  EVAL_BASE_URL=<api base>             default http://localhost:3000

  --tier smoke|core|hard   repeatable; default smoke
  --only id,id             exactly these task ids
  --concurrency N          parallel builds (default 1)
  --label text             a note stored on the run
  --timeout N              per-build seconds (default 900)
  --keep-projects          leave the projects unarchived afterwards
  --dry-run                list what would run and exit
`.trim();

// ── Shapes we read back ───────────────────────────────────────────────────────

type StatusResponse = {
  status: string;
  phase: number | null;
  creditsUsed: number | null;
  usageUsd: number | null;
  previewUrl: string | null;
  buildOutcome: BuildOutcome | null;
  error: string | null;
};


export type TaskResult = {
  taskId: string;
  title: string;
  tier: string;
  projectId: string | null;
  sessionId: string | null;
  /** "pass" = built and every check held. "soft-fail" = built but a check
   *  failed — the interesting case, because the build looked successful.
   *  "fail" = the build itself failed. "error" = the harness couldn't run it. */
  verdict: "pass" | "soft-fail" | "fail" | "error";
  buildStatus: string | null;
  failedChecks: string[];
  fileCount: number;
  largestFileLines: number;
  wallClockSec: number;
  outcome: BuildOutcome | null;
  error: string | null;
};

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function api<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      // Asked for per request rather than captured once: a run can outlast a
      // single token, and the provider refreshes behind this call.
      authorization: `Bearer ${await auth!.token()}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    // The message matters more than the status here: a 403 is almost always
    // WAITLIST_MODE with a non-admin token, and that is worth saying out loud
    // rather than leaving as "403".
    throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── One task ──────────────────────────────────────────────────────────────────

async function runTask(task: EvalTask, args: Args): Promise<TaskResult> {
  const startedMs = Date.now();
  const base: TaskResult = {
    taskId: task.id,
    title: task.title,
    tier: task.tier,
    projectId: null,
    sessionId: null,
    verdict: "error",
    buildStatus: null,
    failedChecks: [],
    fileCount: 0,
    largestFileLines: 0,
    wallClockSec: 0,
    outcome: null,
    error: null,
  };

  try {
    const created = await api<{ project: { id: string } }>("POST", "/api/projects", {
      name: `eval-${task.id}-${Date.now().toString(36)}`,
      description: `Eval run: ${task.title}`,
      mode: "fast",
    });
    base.projectId = created.project.id;
    const projectId = created.project.id;

    const started = await api<{ sessionId: string }>("POST", "/api/build/fast", {
      projectId,
      prompt: task.prompt,
    });
    base.sessionId = started.sessionId;
    console.log(`  [${task.id}] session ${started.sessionId}`);

    // Poll to a terminal status. The build runs in the background on the
    // server, so there is nothing to await but this.
    const deadline = Date.now() + args.timeoutSec * 1_000;
    let status: StatusResponse | null = null;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      try {
        status = await api<StatusResponse>("GET", `/api/build/${started.sessionId}/status`);
      } catch (err) {
        // A transient 5xx mid-build shouldn't throw away the whole task.
        console.warn(`  [${task.id}] status poll failed: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (status.status !== "running" && status.status !== "paused") break;
    }

    base.wallClockSec = Math.round((Date.now() - startedMs) / 1_000);
    base.buildStatus = status?.status ?? null;
    base.outcome = status?.buildOutcome ?? null;

    if (!status || status.status === "running" || status.status === "paused") {
      base.verdict = "fail";
      base.error = `still ${status?.status ?? "unknown"} after ${args.timeoutSec}s`;
      return base;
    }
    if (status.status !== "success" && status.status !== "completed") {
      base.verdict = "fail";
      base.error = status.error ?? `build ended as ${status.status}`;
      return base;
    }

    const filesRes = await api<{ groups: Record<string, FileEntry[]> }>(
      "GET",
      `/api/build/${started.sessionId}/files`,
    );
    const files = collectFiles(filesRes.groups ?? {});
    base.fileCount = files.length;
    base.largestFileLines = files.reduce((m, f) => Math.max(m, f.lines), 0);

    base.failedChecks = scoreChecks(task, files, base.outcome);
    base.verdict = base.failedChecks.length === 0 ? "pass" : "soft-fail";
    return base;
  } catch (err) {
    base.wallClockSec = Math.round((Date.now() - startedMs) / 1_000);
    base.error = err instanceof Error ? err.message : String(err);
    return base;
  } finally {
    // DELETE /api/projects/:id archives rather than removes, which is what we
    // want: the session, its outcome and its files stay readable for the
    // report, they just leave the user's project list.
    if (!args.keepProjects && base.projectId) {
      await api("DELETE", `/api/projects/${base.projectId}`).catch(() => {
        console.warn(`  [${task.id}] could not archive project ${base.projectId}`);
      });
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tasks = tasksFor(args.tiers, args.only);

  if (tasks.length === 0) {
    console.error("No tasks matched. Check --tier / --only against scripts/eval/tasks.ts.");
    process.exit(1);
  }

  if (args.dryRun) {
    console.log(`Would run ${tasks.length} task(s) against ${BASE_URL}:`);
    for (const t of tasks) console.log(`  ${t.id.padEnd(18)} ${t.tier.padEnd(6)} ${t.title}`);
    return;
  }

  try {
    auth = createTokenProvider(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Fail here, before the first build is paid for, rather than on task one.
  try {
    await auth.token();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(
    `Running ${tasks.length} task(s) against ${BASE_URL}, concurrency ${args.concurrency}\n` +
    `Auth: ${auth.describe()}`,
  );
  const results: TaskResult[] = [];
  const queue = [...tasks];

  const worker = async (): Promise<void> => {
    for (;;) {
      const task = queue.shift();
      if (!task) return;
      console.log(`▶ ${task.id} — ${task.title}`);
      const result = await runTask(task, args);
      results.push(result);
      const mark =
        result.verdict === "pass" ? "✔" : result.verdict === "soft-fail" ? "~" : "✘";
      console.log(
        `${mark} ${task.id} ${result.verdict} (${result.wallClockSec}s, ${result.fileCount} files` +
        `${result.outcome ? `, ${result.outcome.rounds} rounds` : ""})` +
        (result.error ? ` — ${result.error}` : "") +
        (result.failedChecks.length > 0 ? `\n    ${result.failedChecks.join("\n    ")}` : ""),
      );
    }
  };

  await Promise.all(Array.from({ length: args.concurrency }, worker));

  // Keep the stored order stable regardless of which worker finished first,
  // so two runs diff cleanly.
  const order = new Map(tasks.map((t, i) => [t.id, i]));
  results.sort((a, b) => (order.get(a.taskId) ?? 0) - (order.get(b.taskId) ?? 0));

  const run = {
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    label: args.label,
    tiers: args.tiers,
    only: args.only,
    results,
  };
  await mkdir(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify(run, null, 2), "utf8");

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {});
  const spend = results.reduce((sum, r) => sum + (r.outcome?.costUsd ?? 0), 0);
  console.log(
    `\n${results.length} task(s): ` +
    Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") +
    `\nmodel spend (our reckoning, a ceiling): $${spend.toFixed(3)}` +
    `\nwritten to ${file}`,
  );

  // Non-zero only when the harness itself couldn't run something. A soft-fail
  // is a finding, not a broken run — exiting non-zero on it would make the
  // script useless in any automation that treats that as "don't continue".
  if ((counts["error"] ?? 0) > 0) process.exit(2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
