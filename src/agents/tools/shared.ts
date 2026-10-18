import { declaredRoutes } from "../../verify/wiring.js";
import { currentProjectFiles } from "../file-deletion.js";
import { routesToVisit, formatRenderForAgent, allRoutesOk } from "../../verify/render.js";
import { formatInteractions } from "../../verify/interactions.js";
import { checkInteractions, checkRender } from "../../preview/e2b-service.js";
import type { ToolExecutionContext } from "../tools.js";

export const NOT_READY =
  "The sandbox is still starting, so there is nothing to read yet. This is normal at " +
  "the beginning of a new build — go ahead and write your files with write_files, " +
  "then read and check afterwards.";
export const isNoSandbox = (e: unknown): boolean =>
  e instanceof Error && e.message.includes("no live sandbox");

export function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

export function noteChurn(
  ctx: ToolExecutionContext,
  before: string,
  after: string,
  kind: "created" | "replaced" | "edited" | "deleted",
): void {
  const c = ctx.churn;
  if (!c) return;
  c.removed += lineCount(before);
  c.added += lineCount(after);
  c[kind] += 1;
}

export function noteWrite(ctx: ToolExecutionContext): void {
  if (ctx.writeCounter) ctx.writeCounter.value += 1;
  const g = ctx.gateResults;
  if (!g) return;
  if (g.checkPage) g.writesAfterCheckPage = (g.writesAfterCheckPage ?? 0) + 1;
  if (g.checkTypes) g.writesAfterCheckTypes = (g.writesAfterCheckTypes ?? 0) + 1;
  if (g.checkTests) g.writesAfterCheckTests = (g.writesAfterCheckTests ?? 0) + 1;
}

export async function runPageSweep(
  ctx: ToolExecutionContext,
  projectId: string,
  trigger: "asked" | "never" | "stale",
): Promise<string | null> {
  const files = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles);
  const declared = new Set<string>();
  for (const code of Object.values(files)) {
    for (const r of declaredRoutes(code)) declared.add(r);
  }
  const routes = routesToVisit([...declared]);

  const { report, ran } = await checkRender(projectId, routes);
  if (!ran || !report) return null;

  if (ctx.gateResults) {
    ctx.gateResults.checkPage = allRoutesOk(report) ? "pass" : "fail";
    ctx.gateResults.writesAfterCheckPage = 0;
  }

  // Only what moved since last time. The sweep costs the same either way; what
  // this saves is the tokens every later round pays to carry a repeat of the
  // same working pages.
  const previous = ctx.lastRender?.report ?? null;
  if (ctx.lastRender) ctx.lastRender.report = report;
  let out = formatRenderForAgent(report, previous);

  // Pages render — so now ask whether anything on them WORKS.
  //
  // This is the question the render sweep cannot answer and the one the owner
  // keeps asking: buttons that are there and do nothing. The probe already
  // existed, but it ran at the end of finishPreview, after the build was
  // delivered, so the model never saw a word of it. A finding the builder
  // cannot act on is a report, not a check.
  //
  // Gated twice on purpose. Only when every route renders — a dead button and
  // a page that never loaded are indistinguishable otherwise — and only ONCE
  // per build, because driving a real browser over several pages costs seconds
  // and the answer rarely changes twice.
  if (allRoutesOk(report) && ctx.interactionsProbed && !ctx.interactionsProbed.value) {
    ctx.interactionsProbed.value = true;
    const routes = report.routes.map((r) => r.route);
    const { findings, ran } = await checkInteractions(projectId, routes);
    console.log(
      `[tools] interactions in-build trigger=${trigger} routes=${routes.length} ` +
      `ran=${ran} findings=${findings.length}`,
    );
    if (ran && findings.length > 0) {
      out += `\n\n${formatInteractions(findings)}`;
    } else if (ran) {
      out += `\n\nI also operated the controls on those pages: every button, link and form I ` +
        `could try produced a visible response.`;
    }
  }

  // This tool's result goes to the MODEL and nowhere else, so without this
  // line there is no way to tell from outside whether the sweep ran, how many
  // pages it saw, or whether the diff is doing its job. `chars` is the figure
  // the cost argument rests on.
  console.log(
    `[tools] page sweep trigger=${trigger} routes=${report.routes.length} ` +
    `broken=${report.routes.filter((r) => !r.ok).length} ` +
    `unreachable=${report.unreachable.length} ` +
    `repeat=${previous !== null} chars=${out.length}`,
  );
  return out;
}

