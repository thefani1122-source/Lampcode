import { randomUUID } from "node:crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import type { ToolDefinition } from "./model-gateway.js";
import { parseSkillFrontmatter, ALL_SKILL_NAMES } from "./prompt-builder.js";
import { logger } from "../server/logger.js";
import { createPendingApproval, resolveApproval, APPROVAL_TIMEOUT_MS } from "./pending-approvals.js";
import { createPendingAnswer, resolveAnswer, ANSWER_TIMEOUT_MS } from "./pending-answers.js";
import { getWebSocketServer } from "../websocket/server.js";
import { findDeadCode, tallyDeadCode, formatDeadCode } from "../verify/dead-code.js";
import { reviewProject, formatReview } from "../verify/code-review.js";
import type { AgentDispatcher } from "./dispatcher.js";
import {
  writeFilesToSandbox,
  verifyBrowserRender,
  runTypeCheck,
  runTests,
  readProjectFile,
  listProjectFiles,
  readSandboxLogs,
  fetchReferenceDesign,
  isFetchableReferenceUrl,
  isTemplateOwnedFile,
} from "../preview/e2b-service.js";
import { persistFilesAsWritten } from "../storage/project-files.js";
import type { WriteProxyRegistry } from "./mcp-tool-classifier.js";
import { callMcpTool } from "../mcp/call-tool.js";

// ── Tool definitions (Anthropic tool-use shape) ─────────────────────────────

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "load_skill",
    description:
      "Fetch the full reference document for a named house-style convention. See the " +
      "\"House-style references\" index in your instructions for the available names and " +
      "what each one covers. Call this when a build clearly needs one of those conventions " +
      "in depth, even if the user's wording doesn't match any exact keyword.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill name exactly as it appears in the House-style references index, e.g. \"animation-expert\".",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "read_project_file",
    description:
      "Re-read the current content of a project file already provided in your context, " +
      "if you want to double-check it before editing.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Project-relative file path exactly as it appears in your context, e.g. \"src/App.tsx\".",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "request_write_action",
    description:
      "Call this when the user's request needs a WRITE or destructive action on one of their " +
      "connected services AND no specific proxy tool for that service/action appears in your " +
      "tool list (e.g. the service isn't connected, or only read-only tools were discovered). " +
      "This tells the user clearly instead of silently building something unrelated or " +
      "pretending the action happened.",
    input_schema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "The connected service involved, e.g. \"github\", \"vercel\", \"slack\".",
        },
        description: {
          type: "string",
          description: "One sentence describing the write action the user asked for.",
        },
      },
      required: ["service", "description"],
    },
  },
];

// ── Agentic build tools ─────────────────────────────────────────────────────
// Offered ONLY on the agentic build path (see dispatcher's agenticBuild option).
// These are what turn the model from a text generator into something that can
// check its own work: it writes into the real sandbox, looks at the rendered
// page, and repairs what it finds — the loop build.ts used to drive from the
// outside with fixed if-statements. Each one delegates to an e2b-service export
// that the existing fix loops already use, so nothing new touches the sandbox.
export const AGENTIC_BUILD_TOOLS: ToolDefinition[] = [
  {
    name: "ask_user",
    description:
      "Ask the person a question and WAIT for their answer. The build pauses until they " +
      "reply. Use it ONLY when the answer would change what you build and you cannot settle " +
      "it yourself — a genuine fork in the product, like which of two workflows the app is " +
      "for, or whether data should live only in the browser. Do NOT use it for anything you " +
      "can decide with ordinary judgement, for permission to continue, or to confirm " +
      "something you already know; asking costs the person their attention and most builds " +
      "should finish without a single question. Offer concrete options whenever you can, " +
      "mark the one you would pick as recommended, and write every option so somebody who " +
      "does not code can choose between them. Their reply comes back as the tool result.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question, in plain language. One question, not several at once.",
        },
        options: {
          type: "array",
          description:
            "Two to four concrete choices. Omit entirely when the answer is genuinely " +
            "open-ended and the person should type it.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "A short name for the choice." },
              description: {
                type: "string",
                description: "What this choice means for their app, in non-technical terms.",
              },
              recommended: {
                type: "boolean",
                description:
                  "True on AT MOST ONE option — the one you would pick. Say why in its " +
                  "description, so the person is agreeing with a reason rather than guessing.",
              },
            },
            required: ["label"],
          },
        },
      },
      required: ["question"],
    },
  },
  {
    name: "write_files",
    description:
      "Write files into the project's live preview sandbox. Use this instead of printing " +
      "code in your reply — files only exist once written.\n" +
      "Each file's `content` REPLACES THAT FILE ENTIRELY. There is no merging, patching or " +
      "appending: whatever you send becomes the whole file, and anything you leave out is " +
      "gone. To change one line of a file, send the complete file with that line changed — " +
      "never send only the changed part.\n" +
      "Files you do not write are untouched. Call it as many times as you need; a later " +
      "write to the same path replaces the earlier one. After writing, verify with " +
      "check_page before you finish.\n" +
      "Some files belong to the project template and cannot be written — src/styles.css, " +
      "package.json, vite.config.ts, tsconfig.json, index.html. For custom CSS (keyframes, " +
      "animations, anything styles.css doesn't cover) create your OWN stylesheet, e.g. " +
      "src/app.css, and import it from src/App.tsx.",
    input_schema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "The files to write.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Project-relative path, e.g. \"src/App.tsx\"." },
              content: { type: "string", description: "The complete file content." },
            },
            required: ["path", "content"],
          },
        },
      },
      required: ["files"],
    },
  },
  {
    name: "edit_file",
    description:
      "Change part of an existing file by replacing an exact piece of its text. Prefer this " +
      "over write_files for anything that already exists — it does not require you to " +
      "reproduce the rest of the file, so it is far cheaper and cannot lose the parts you " +
      "are not changing.\n" +
      "`old_string` must match the file EXACTLY, including indentation and line breaks, and " +
      "must appear exactly ONCE. If it appears more than once, include more surrounding " +
      "lines until it is unique. Read the file first if you are not certain of its contents.\n" +
      "To delete something, pass an empty `new_string`.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project-relative path, e.g. \"src/App.tsx\"." },
        old_string: {
          type: "string",
          description: "The exact text to replace. Must appear exactly once in the file.",
        },
        new_string: { type: "string", description: "What to put in its place. May be empty." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "find_dead_code",
    description:
      "List everything in the project that nothing else reaches: imports that are never " +
      "used, exports that no other file imports, and components that are never rendered.\n" +
      "Call this after you CHANGE how something works, before you say you are done. " +
      "Replacing a feature leaves the old implementation behind unless you delete it, and " +
      "you cannot see that from one file — reachability is a property of the whole project, " +
      "which is why this is a tool and not something to reason about. Two implementations of " +
      "one feature means the next edit has to guess which one is live.\n" +
      "It is free, needs no sandbox, and takes no arguments. The analysis is textual rather " +
      "than a compiler, so confirm anything surprising with read_file before deleting it.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "review_code",
    description:
      "Review the whole project the way a senior engineer reviews a pull request, and report " +
      "what is wrong with COVERAGE stated — how many files got a real look and how many did " +
      "not.\n" +
      "Call this when the person asks for a review, or asks you to find bugs in code that " +
      "already exists. Do NOT call it on your own fresh work: check_page, check_types and " +
      "run_tests answer that faster and for far less.\n" +
      "It reads every file, ranks them by how many other files depend on them and whether " +
      "anything tests them, then looks at them ONE AT A TIME — which is why it finds things a " +
      "single pass over forty files does not. It costs real money and takes a while, so call " +
      "it once and act on what it reports.",
    input_schema: {
      type: "object",
      properties: {
        max_files: {
          type: "number",
          description:
            "How many files to look at in depth, riskiest first. Omit for the default. The " +
            "report always states how many were skipped.",
        },
      },
      required: [],
    },
  },
  {
    name: "check_page",
    description:
      "Open the running app in a real headless browser and report what actually rendered, " +
      "including any runtime errors from the console. This is the only way to find out " +
      "whether the page is genuinely working or silently blank — a file that compiles can " +
      "still render nothing. Call this after writing files, and fix anything it reports.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "check_types",
    description:
      "Run the TypeScript compiler against the project in the sandbox and report real type " +
      "errors, resolved against its actual dependencies and tsconfig. Use it when you've " +
      "written code you want verified before relying on it.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "run_tests",
    description:
      "Run the project's test suite with vitest and report which tests passed and which " +
      "failed, with the failure messages. This is the only tool that tells you whether the " +
      "code is CORRECT — check_page tells you the app rendered and check_types tells you it " +
      "compiles, and code can do both while computing the wrong answer.\n" +
      "Write tests for logic whose correctness is not obvious by reading it: a reducer, a " +
      "total, a date or currency calculation, a formula evaluator, validation rules, " +
      "sorting and filtering, anything with an edge case. Put them next to the code as " +
      "`<name>.test.ts` (or `.test.tsx`) under src/, import from \"vitest\" explicitly " +
      "(`import { describe, it, expect } from \"vitest\"`), and test the exported function " +
      "rather than the component wrapped around it. jsdom and @testing-library/react are " +
      "available if you do need to render one.\n" +
      "Do not write tests that only restate the implementation, and do not test layout or " +
      "styling — check_page covers what rendered.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_files",
    description:
      "List the project's source files as they exist right now in the sandbox. Use this " +
      "before editing an existing project so you know what is actually there, instead of " +
      "assuming a file exists or guessing its path. Dependencies, build output and " +
      "environment files are not listed.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_file",
    description:
      "Read one project file's current contents from the sandbox. This is the real file on " +
      "disk, including any edit you just made — use it to understand existing code before " +
      "changing it, and to check what a file actually contains when something doesn't work " +
      "the way you expect. Call list_files first if you're not sure of the path.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Project-relative path, e.g. \"src/components/Header.tsx\".",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "fetch_reference",
    description:
      "Look at a reference page the user linked and get its design vocabulary back: theme " +
      "(dark/light), the colours it actually uses, its fonts, its heading sizes, and its " +
      "sections in order. Call this FIRST whenever the user gives you a URL to work from — " +
      "otherwise you are guessing at a page you have never seen.\n" +
      "You get a style guide, not the page. Use its palette, type and section rhythm to make " +
      "something that feels like it; write your own copy and your own layout. Do not try to " +
      "reproduce the original.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The reference page's URL, as the user gave it." },
      },
      required: ["url"],
    },
  },
  {
    name: "read_logs",
    description:
      "Read recent output from the running dev server and, if the app has one, its backend. " +
      "This is where the real reason for a broken page usually is — a failed import, a " +
      "compile error, a crashed server — in wording check_page cannot show you. Read this " +
      "when something is wrong and you don't yet know why.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export type GateOutcome = "pass" | "fail" | "unavailable";
/** run_tests has a fourth answer the other gates cannot give: it ran, and the
 *  project has no tests. That is not a pass — an agent told "tests passed"
 *  after writing none has been handed proof it never earned. */
export type TestGateOutcome = GateOutcome | "none";

const SKILLS_DIR = join(process.cwd(), "src", "skills");

// Allowlist check before touching the filesystem — `name` is a model-chosen
// string derived from user input, so this is defense in depth against path
// traversal even though ALL_SKILL_NAMES already constrains what's meaningful.
const KNOWN_SKILL_NAMES = new Set<string>(ALL_SKILL_NAMES);


export interface ToolExecutionContext {
  /** Same set already inlined into the user message by buildContextBlock() —
   *  read_project_file re-serves from here, it doesn't reach the filesystem. */
  contextFiles?: Array<{ path: string; content: string }> | undefined;
  /** Required for write-proxy tools — used as the correlation key and WS room. */
  sessionId?: string | undefined;
  /** Registry of write-proxy tool names → MCP execution metadata.
   *  Populated by dispatcher from classifier results when enableTools is true. */
  writeMcpRegistry?: WriteProxyRegistry | undefined;
  /** Registry of READ-ONLY MCP tool names → execution metadata. Only populated
   *  on gateways that cannot reach MCP themselves (the OpenAI-compatible path);
   *  on Anthropic the connector runs these server-side and this stays empty.
   *  Checked AFTER writeMcpRegistry so a name present in both can never bypass
   *  the approval gate — see executeTool. */
  readMcpRegistry?: WriteProxyRegistry | undefined;
  /** Shared flag: set to true after any write-proxy in this turn is denied.
   *  Subsequent write-proxy calls in the same turn auto-deny without prompting,
   *  preventing partial execution of a multi-step write sequence. */
  writeDenied?: { value: boolean } | undefined;
  /** Anthropic tool_use block ID — used as the pending-approval correlation key. */
  toolCallId?: string | undefined;
  /** Required by the agentic build tools — identifies the live sandbox. */
  projectId?: string | undefined;
  /** The project's existing files on a follow-up edit, as build.ts already
   *  loaded them. read_file/list_files serve from here first, so the model can
   *  see the real project without depending on a sandbox that may still be
   *  warming — and write_files writes these alongside its own output, so the
   *  sandbox holds the WHOLE project and check_page tests the real thing
   *  rather than a template with three edited files dropped into it. */
  projectFiles?: Record<string, string> | undefined;
  /** Accumulator the agentic build path reads back once the model is done.
   *  write_files records into this as well as writing to the sandbox, so the
   *  caller ends up with the same file map the old fence-parsing path produced
   *  and every downstream gate keeps working unchanged. */
  generatedFiles?: Record<string, string> | undefined;
  /** Forwards sandbox/dev-server output to the client's build log. */
  onLog?: ((line: string) => void) | undefined;
  /** Where the verification tools record what they found, so the build can be
   *  scored afterwards. The tools return prose to the model; nothing else sees
   *  whether the page actually rendered, which left a finished build with no
   *  evidence beyond status = success. Last call wins — the model is expected
   *  to check, fix, and check again, and the final state is the real one. */
  gateResults?:
    | {
        checkPage?: GateOutcome;
        checkTypes?: GateOutcome;
        checkTests?: TestGateOutcome;
        /** Files written since the last gate call, per gate. A gate is only
         *  evidence about the code that existed when it ran: on 2026-10-04 a
         *  build wrote, called check_page, wrote again, and then reported "the
         *  page renders without errors" — true of the code it looked at, false
         *  of the code it shipped. Non-zero means the verdict above is STALE
         *  and should not be read as proof. */
        writesAfterCheckPage?: number;
        writesAfterCheckTypes?: number;
        writesAfterCheckTests?: number;
      }
    | undefined;
  /** Monotonic count of write_files/edit_file calls this build. Only meaningful
   *  relative to itself — it exists to date the gate results above. */
  writeCounter?: { value: number } | undefined;
  /** How much code this build added and removed. Until now a build recorded
   *  `filesWritten` and nothing about SIZE, so "do repeated edits grow the
   *  project without cutting anything?" was not a question the data could
   *  answer — and an unmeasured problem stays unmanaged. `removed` staying near
   *  zero while `added` climbs is the signature of an edit that bolts a new
   *  path on beside the old one. */
  churn?: { added: number; removed: number; created: number; replaced: number; edited: number } | undefined;
  /** What find_dead_code reported, and whether the model called it at all.
   *  `called: false` is its own fact — the same distinction build_outcome keeps
   *  between a gate that failed and a gate nobody ran. */
  deadCode?: { called: boolean; unusedImports: number; unreferencedExports: number; neverRendered: number } | undefined;
  /** What review_code did, so a review's COVERAGE is recorded and not merely
   *  printed into the conversation. `deep` versus `total` is the number that
   *  makes "I reviewed it" checkable. */
  review?: {
    called: boolean; deep: number; total: number; unreviewed: number;
    findings: number; dropped: number; costUsd: number;
  } | undefined;
  /** Needed only by review_code, which is the one tool that dispatches a model
   *  of its own. Absent on any path that cannot pay for it. */
  dispatcher?: AgentDispatcher | undefined;
  userId?: string | undefined;
  provider?: "anthropic" | "modal" | undefined;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

/**
 * Record the size of one change.
 *
 * For `edit_file` this is exact: the replaced text out, the new text in. For
 * `write_files` on an existing file it counts the whole old file as removed and
 * the whole new one as added, which is literally what that tool does — it
 * replaces the file — so the useful figure there is the NET, not either side.
 */
function noteChurn(
  ctx: ToolExecutionContext,
  before: string,
  after: string,
  kind: "created" | "replaced" | "edited",
): void {
  const c = ctx.churn;
  if (!c) return;
  c.removed += lineCount(before);
  c.added += lineCount(after);
  c[kind] += 1;
}

/**
 * Record that the project changed, which dates every gate verdict held so far.
 *
 * A gate is only evidence about the code that existed when it ran. On
 * 2026-10-04 a build wrote files, called check_page, wrote more files, and then
 * told the user "the page renders without errors" — true of what it looked at,
 * false of what it shipped, and nothing anywhere could tell the two apart.
 */
function noteWrite(ctx: ToolExecutionContext): void {
  if (ctx.writeCounter) ctx.writeCounter.value += 1;
  const g = ctx.gateResults;
  if (!g) return;
  if (g.checkPage) g.writesAfterCheckPage = (g.writesAfterCheckPage ?? 0) + 1;
  if (g.checkTypes) g.writesAfterCheckTypes = (g.writesAfterCheckTypes ?? 0) + 1;
  if (g.checkTests) g.writesAfterCheckTests = (g.writesAfterCheckTests ?? 0) + 1;
}

/** Execute one tool call and return the text to send back as its tool_result. */
export async function executeTool(
  name: string,
  argsJson: string,
  ctx: ToolExecutionContext,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch {
    return "Error: could not parse tool arguments as JSON.";
  }

  if (name === "load_skill") {
    const skillName = typeof args["name"] === "string" ? args["name"] : "";
    if (!KNOWN_SKILL_NAMES.has(skillName)) {
      return `Error: "${skillName}" is not a known skill. Available: ${ALL_SKILL_NAMES.join(", ")}.`;
    }
    try {
      const raw = await readFile(join(SKILLS_DIR, `${skillName}.md`), "utf-8");
      const { body } = parseSkillFrontmatter(raw, skillName);
      return body;
    } catch {
      return `Error: skill "${skillName}" is listed but its file could not be read.`;
    }
  }

  if (name === "read_project_file") {
    const path = typeof args["path"] === "string" ? args["path"] : "";
    const file = ctx.contextFiles?.find((f) => f.path === path);
    return file ? file.content : `Error: "${path}" is not part of this project's current context.`;
  }

  // ── Agentic build tools ───────────────────────────────────────────────────

  if (
    name === "write_files" ||
    name === "edit_file" ||
    name === "check_page" ||
    name === "check_types" ||
    name === "run_tests" ||
    name === "list_files" ||
    name === "read_file" ||
    name === "read_logs" ||
    name === "find_dead_code" ||
    name === "review_code" ||
    name === "fetch_reference"
  ) {
    // Handled before the sandbox check on purpose: this one reads the file set
    // this build already holds, so it works on a cold sandbox and costs
    // nothing. Requiring a projectId would make it unavailable in exactly the
    // early rounds where the model is deciding what to keep.
    if (name === "find_dead_code") {
      const files = { ...(ctx.projectFiles ?? {}), ...(ctx.generatedFiles ?? {}) };
      if (Object.keys(files).length === 0) {
        return (
          "There are no files to analyse yet. Call this after you have written or changed " +
          "code, not before."
        );
      }
      const findings = findDeadCode(files);
      if (ctx.deadCode) {
        const t = tallyDeadCode(findings);
        ctx.deadCode.unusedImports = t.unusedImports;
        ctx.deadCode.unreferencedExports = t.unreferencedExports;
        ctx.deadCode.neverRendered = t.neverRendered;
        ctx.deadCode.called = true;
      }
      return formatDeadCode(findings);
    }

    // Also before the sandbox check: the review reads the file set, not the
    // running app. It is the one tool here that costs real money, so it needs
    // the dispatcher and the identity to bill against, and it refuses rather
    // than silently doing nothing when either is missing.
    if (name === "review_code") {
      const files = { ...(ctx.projectFiles ?? {}), ...(ctx.generatedFiles ?? {}) };
      if (Object.keys(files).length === 0) {
        return "There is no code to review yet.";
      }
      if (!ctx.dispatcher || !ctx.userId) {
        return "Error: the review pass is not available in this build.";
      }
      const maxUnits = typeof args["max_files"] === "number" && args["max_files"] > 0
        ? Math.min(Math.floor(args["max_files"]), 60)
        : undefined;
      const result = await reviewProject({
        dispatcher: ctx.dispatcher,
        files,
        sessionId: ctx.sessionId ?? "",
        userId: ctx.userId,
        projectId: ctx.projectId ?? "",
        provider: ctx.provider ?? "modal",
        ...(maxUnits === undefined ? {} : { maxUnits }),
        onProgress: (done, total, path) =>
          ctx.onLog?.(`Reviewing ${done}/${total}: ${path}`),
      });
      if (ctx.review) {
        ctx.review.called = true;
        ctx.review.deep = result.coverage.deep;
        ctx.review.total = result.coverage.total;
        ctx.review.unreviewed = result.coverage.unreviewed;
        ctx.review.findings = result.findings.length;
        ctx.review.dropped = result.droppedUncorroborated;
        ctx.review.costUsd = result.costUsd;
      }
      return formatReview(result);
    }

    const projectId = ctx.projectId;
    if (!projectId) return "Error: no project sandbox is attached to this build.";

    if (name === "write_files") {
      noteWrite(ctx);
      const raw = Array.isArray(args["files"]) ? (args["files"] as unknown[]) : [];
      const files: Record<string, string> = {};
      for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e["path"] === "string" && typeof e["content"] === "string") {
          files[e["path"]] = e["content"];
        }
      }
      if (Object.keys(files).length === 0) {
        return "Error: no valid files provided. Each entry needs a string `path` and string `content`.";
      }

      // Merge into the running set first, then write the WHOLE set. The
      // sandbox's own writer skips template-owned files (package.json,
      // vite.config, etc.) on its own, so the model can't break the scaffold.
      // Recorded BEFORE the write deliberately: if the sandbox write fails,
      // the model still authored this content, and the caller writes the set
      // to disk and pushes it through the normal preview path afterwards.
      // Dropping it on a sandbox hiccup would throw away real work; the model
      // is told about the failure either way and can retry.
      // Refuse template-owned paths here, out loud, instead of accepting them
      // and letting them be dropped further down. A model asked for scroll
      // animations wrote them into src/styles.css, was told "Wrote 2 files",
      // and reported the animations as done — while the file was discarded on
      // the way in and the page never changed. Silent rejection is how an agent
      // ends up honestly describing work that does not exist.
      // Refuse fragments carrying unresolved edit markers. Those belong to the
      // pipeline, where file-parser.ts splices them into the existing file;
      // here the content IS the file, so writing it destroys the real one. The
      // prompt no longer offers markers on this path, but a model can still
      // reach for them, and the cost of being wrong is a working app replaced
      // by a syntax error. build.ts's validateAppTsx refuses the same thing on
      // the pipeline side.
      const marked = Object.keys(files).filter((p) =>
        /\/\/\s*(BEGIN_EDIT|END_EDIT)\b/.test(files[p] ?? ""),
      );
      if (marked.length > 0) {
        return (
          `Nothing was written. ${marked.join(", ")} contained // BEGIN_EDIT or // END_EDIT ` +
          `markers.\n` +
          `write_files replaces a file entirely — nothing splices those markers, so writing a ` +
          `fragment would destroy the rest of the file. Send the COMPLETE content of each file ` +
          `you are changing, every line, including the parts you are not changing.`
        );
      }

      const refused = Object.keys(files).filter((p) => isTemplateOwnedFile(p));
      for (const p of refused) delete files[p];
      if (Object.keys(files).length === 0) {
        return (
          `Nothing was written. ${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} ` +
          `owned by the project template and cannot be changed.\n` +
          `For custom CSS, create your own stylesheet — e.g. src/app.css — and import it from ` +
          `src/App.tsx. It will be picked up normally. Do not put it in src/styles.css.`
        );
      }

      // Measured before the merge, while the previous content is still
      // reachable. A path this build has not seen before counts as created
      // rather than replaced, so a new project does not read as churn.
      for (const [path, content] of Object.entries(files)) {
        const before = (ctx.generatedFiles ?? {})[path] ?? (ctx.projectFiles ?? {})[path];
        noteChurn(ctx, before ?? "", content, before === undefined ? "created" : "replaced");
      }

      if (ctx.generatedFiles) Object.assign(ctx.generatedFiles, files);
      // The sandbox gets the WHOLE project, not just this turn's files. On an
      // edit the model writes only what it changed (correctly — that is what
      // preserves everything else), but the sandbox may be a fresh template,
      // and checking a template with three edited files dropped into it tells
      // the model nothing about the real app. Existing files first so this
      // turn's writes win on any path they both have.
      const toWrite = { ...(ctx.projectFiles ?? {}), ...(ctx.generatedFiles ?? files) };

      let url: string | undefined;
      let writeError: string | undefined;
      try {
        url = await writeFilesToSandbox(projectId, toWrite, ctx.onLog);
      } catch (err) {
        writeError = err instanceof Error ? err.message : String(err);
      }

      // Store them NOW, not at the end of the build. A build that dies partway
      // — the cost ceiling mid-dispatch, a provider error, a restart — used to
      // leave a sandbox full of working files and nothing recoverable. Done
      // even when the sandbox write failed: the model authored this content,
      // and the same reasoning that records it in generatedFiles above applies
      // to keeping it.
      await persistFilesAsWritten(projectId, files);

      if (writeError !== undefined) return `Error writing files: ${writeError}`;

      const note = refused.length > 0
        ? `\nNOT written: ${refused.join(", ")} — owned by the project template. ` +
          `Put custom CSS in your own file (e.g. src/app.css) and import it from src/App.tsx.`
        : "";
      return (
        `Wrote ${Object.keys(files).length} file(s): ${Object.keys(files).join(", ")}.${note}\n` +
        `The app is running at ${url}. Call check_page to see what it actually renders.`
      );
    }

    // Reads resolve newest-first: what the model wrote this turn, then the
    // project as it stood when the build started, then the sandbox. The first
    // two are already in memory and authoritative, so an edit doesn't have to
    // wait on a sandbox that may still be warming — and can't be misled into
    // thinking the project is empty because it asked a second too early.
    const known = { ...(ctx.projectFiles ?? {}), ...(ctx.generatedFiles ?? {}) };

    // "No sandbox" must never read as "tools don't work here". On a brand-new
    // build the sandbox is still warming while the model takes its first turn,
    // and these reads legitimately have nothing to show yet. Reporting that as
    // a bare error made a model conclude the harness was unavailable — its own
    // words were "No sandbox; output files in reply per task format" — and
    // abandon the tools for the rest of the build. Every message below keeps it
    // on the tool path.
    const NOT_READY =
      "The sandbox is still starting, so there is nothing to read yet. This is normal at " +
      "the beginning of a new build — go ahead and write your files with write_files, " +
      "then read and check afterwards.";
    const isNoSandbox = (e: unknown): boolean =>
      e instanceof Error && e.message.includes("no live sandbox");

    if (name === "edit_file") {
      noteWrite(ctx);
      const path = typeof args["path"] === "string" ? args["path"].trim() : "";
      const oldString = typeof args["old_string"] === "string" ? args["old_string"] : "";
      const newString = typeof args["new_string"] === "string" ? args["new_string"] : "";

      if (!path) return "Error: `path` is required.";
      if (oldString === "") {
        return (
          "Error: `old_string` is required and cannot be empty. To create a new file, use " +
          "write_files instead."
        );
      }
      if (oldString === newString) {
        return "Nothing was changed: `old_string` and `new_string` are identical.";
      }
      if (isTemplateOwnedFile(path)) {
        return (
          `${path} is owned by the project template and cannot be changed.\n` +
          `For custom CSS, create your own stylesheet — e.g. src/app.css — and import it from ` +
          `src/App.tsx.`
        );
      }

      // Same precedence as read_file: what this turn wrote, then the project as
      // it stood at build start, then the sandbox. Editing anything staler than
      // that would silently undo the model's own previous edit.
      const current =
        (ctx.generatedFiles ?? {})[path] ??
        (ctx.projectFiles ?? {})[path] ??
        (await readProjectFile(projectId, path).catch((err: unknown) => {
          if (isNoSandbox(err)) return null;
          return undefined;
        }));

      if (current === null) return NOT_READY;
      if (current === undefined) {
        return (
          `Could not read ${path}. Call list_files to see what the project actually contains, ` +
          `or use write_files if this file does not exist yet.`
        );
      }

      // Exact match, and it has to be unambiguous. Replacing the first of
      // several matches is how an edit tool quietly changes the wrong line.
      const occurrences = current.split(oldString).length - 1;
      if (occurrences === 0) {
        return (
          `No change made: that exact text does not appear in ${path}. It must match the ` +
          `file character for character, including indentation and line breaks. Call ` +
          `read_file on ${path} and copy the text from what it returns.`
        );
      }
      if (occurrences > 1) {
        return (
          `No change made: that text appears ${occurrences} times in ${path}, so it is ` +
          `ambiguous. Include more of the surrounding lines until it identifies exactly one ` +
          `place.`
        );
      }

      // A FUNCTION replacement, not a string one: in String.replace a literal
      // replacement treats $&, $1, $` and $' as substitution patterns, so new
      // text containing them would be silently mangled — and generated code
      // contains them often, in exactly the regex replacements this tool would
      // be used to edit. Verified: replacing with "[$&]" writes "[1]" the
      // naive way and "[$&]" this way.
      const updated = current.replace(oldString, () => newString);
      // Exact here, unlike write_files: only the replaced span changed, so this
      // is the one measurement that cleanly answers whether an edit removed
      // anything or only added.
      noteChurn(ctx, oldString, newString, "edited");
      if (ctx.generatedFiles) ctx.generatedFiles[path] = updated;

      // Write the WHOLE project, as write_files does: the sandbox may be a fresh
      // template, and checking one edited file dropped into it would tell the
      // model nothing about the real app.
      const toWrite = { ...(ctx.projectFiles ?? {}), ...(ctx.generatedFiles ?? { [path]: updated }) };
      let url: string | undefined;
      let writeError: string | undefined;
      try {
        url = await writeFilesToSandbox(projectId, toWrite, ctx.onLog);
      } catch (err) {
        writeError = err instanceof Error ? err.message : String(err);
      }

      // Same reason as write_files: store the edited file now, so a build that
      // dies later is still recoverable. Only this one file — uploads are
      // upserts keyed on path, so the stored project stays whole.
      await persistFilesAsWritten(projectId, { [path]: updated });

      if (writeError !== undefined) return `Error writing ${path}: ${writeError}`;
      const removed = newString === "";
      return (
        `Edited ${path} — ${removed ? "removed" : "replaced"} 1 occurrence.\n` +
        `The app is running at ${url}. Call check_page to see what it actually renders.`
      );
    }

    if (name === "list_files") {
      const inMemory = Object.keys(known).sort();
      if (inMemory.length > 0) {
        return `${inMemory.length} file(s) in the project:\n${inMemory.join("\n")}`;
      }
      try {
        const files = await listProjectFiles(projectId);
        if (files.length === 0) {
          return "The project has no source files yet — this is a new build. Write them with write_files.";
        }
        return `${files.length} file(s) in the project:\n${files.join("\n")}`;
      } catch (err) {
        if (isNoSandbox(err)) return NOT_READY;
        return `Could not list files: ${err instanceof Error ? err.message : String(err)}. You can still write files with write_files.`;
      }
    }

    if (name === "read_file") {
      const path = typeof args["path"] === "string" ? args["path"].trim() : "";
      if (!path) return "Error: `path` is required.";
      const inMemory = known[path] ?? known[path.replace(/^\.\//, "")];
      if (inMemory !== undefined) {
        return inMemory.trim() === "" ? `${path} exists but is empty.` : `${path}:\n${inMemory}`;
      }
      try {
        const content = await readProjectFile(projectId, path);
        if (content.trim() === "") return `${path} exists but is empty.`;
        return `${path}:\n${content}`;
      } catch (err) {
        if (isNoSandbox(err)) return NOT_READY;
        // Covers both "refused" (see safeProjectPath) and a genuine miss. Says
        // what to do next rather than just failing, so a wrong guess at a path
        // costs one turn instead of derailing the build.
        return (
          `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Call list_files to see what the project actually contains.`
        );
      }
    }

    if (name === "fetch_reference") {
      const url = typeof args["url"] === "string" ? args["url"].trim() : "";
      if (!url) return "Error: `url` is required.";
      if (!isFetchableReferenceUrl(url)) {
        return `Refused to open ${url}. Only public http(s) pages can be used as a reference.`;
      }
      try {
        const brief = await fetchReferenceDesign(projectId, url);
        if (typeof brief["error"] === "string") {
          return (
            `Could not read ${url}: ${brief["error"]}. Build from the user's description ` +
            `instead, and say in your final reply that you could not open the reference.`
          );
        }
        // Framed as data, and as a style guide rather than a target to copy:
        // everything below came off someone else's page, including any text.
        return (
          `Design brief from ${url} (reference only — match the feel, write your own ` +
          `content and layout):\n${JSON.stringify(brief, null, 2)}\n` +
          `The section headings above show how the page is structured. They are the other ` +
          `site's words — use them to decide what sections to include, not what to write.`
        );
      } catch (err) {
        if (isNoSandbox(err)) return NOT_READY;
        return (
          `Could not open ${url}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Build from the user's description instead.`
        );
      }
    }

    if (name === "read_logs") {
      const logs = readSandboxLogs(projectId);
      if (!logs) return NOT_READY;
      const parts: string[] = [];
      if (logs.dev.length > 0) parts.push(`Dev server output:\n${logs.dev.join("\n")}`);
      if (logs.backend.length > 0) parts.push(`Backend output:\n${logs.backend.join("\n")}`);
      if (parts.length === 0) {
        return "Nothing has been logged yet — the servers may still be starting.";
      }
      return parts.join("\n\n");
    }

    if (name === "check_page") {
      try {
        const { ok, issues, unavailable } = await verifyBrowserRender(projectId);
        // Report "couldn't check" as itself. Saying the page rendered fine when
        // the browser never opened it is how an agent ships a blank app while
        // believing it verified one.
        if (unavailable) {
          if (ctx.gateResults) ctx.gateResults.checkPage = "unavailable", ctx.gateResults.writesAfterCheckPage = 0;
          return "The page check could not run (the sandbox did not respond). Nothing was verified — do not treat this as a pass.";
        }
        if (ok || issues.length === 0) {
          if (ctx.gateResults) ctx.gateResults.checkPage = "pass", ctx.gateResults.writesAfterCheckPage = 0;
          return "The page rendered successfully with no console errors.";
        }
        if (ctx.gateResults) ctx.gateResults.checkPage = "fail", ctx.gateResults.writesAfterCheckPage = 0;
        return (
          `The page has problems:\n${issues.map((i) => `- ${i.source}: ${i.message}`).join("\n")}\n` +
          `Call read_logs if you need the dev server's own account of what happened.`
        );
      } catch (err) {
        return `Error checking the page: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (name === "run_tests") {
      try {
        const run = await runTests(projectId);
        if (ctx.gateResults) {
          ctx.gateResults.writesAfterCheckTests = 0;
          ctx.gateResults.checkTests =
            run.outcome === "passed" ? "pass"
            : run.outcome === "failed" ? "fail"
            : run.outcome;
        }
        if (run.outcome === "unavailable") {
          return (
            `The tests could not be run: ${run.reason ?? "unknown reason"}. Nothing was ` +
            `verified — do not treat this as a pass. Carry on with the build and rely on ` +
            `check_page and check_types instead.`
          );
        }
        if (run.outcome === "none") {
          return (
            "There are no tests in this project yet, so nothing was verified. If this app " +
            "has logic whose correctness isn't obvious by reading it, write a test file " +
            "next to that code (e.g. src/lib/totals.test.ts), then call run_tests again."
          );
        }
        if (run.outcome === "passed") {
          return `All ${run.total} test(s) passed.`;
        }
        // Cap the detail: a broken shared module can fail fifty tests with the
        // same message, and fifty copies of it crowds out the context the model
        // needs to fix the one cause.
        const shown = run.failures.slice(0, 10);
        const omitted = run.failures.length - shown.length;
        return (
          `${run.failed} of ${run.total} test(s) failed.\n` +
          shown.map((f) => `- ${f.test}\n  ${f.message.replace(/\n/g, "\n  ")}`).join("\n") +
          (omitted > 0 ? `\n…and ${omitted} more failing test(s), likely the same cause.` : "") +
          `\nFix the code, not the test — unless the test itself asserts the wrong thing.`
        );
      } catch (err) {
        return `Error running the tests: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    try {
      const { ok, issues, unavailable } = await runTypeCheck(projectId);
      if (unavailable) {
        if (ctx.gateResults) ctx.gateResults.checkTypes = "unavailable", ctx.gateResults.writesAfterCheckTypes = 0;
        return "The type check could not run (tsc was unreachable in the sandbox). Nothing was verified — do not treat this as a pass.";
      }
      if (ok || issues.length === 0) {
        if (ctx.gateResults) ctx.gateResults.checkTypes = "pass", ctx.gateResults.writesAfterCheckTypes = 0;
        return "No type errors.";
      }
      if (ctx.gateResults) ctx.gateResults.checkTypes = "fail", ctx.gateResults.writesAfterCheckTypes = 0;
      return `Type errors:\n${issues.map((i) => `- ${i.source}: ${i.message}`).join("\n")}`;
    } catch (err) {
      return `Error running the type check: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (name === "request_write_action") {
    const service = typeof args["service"] === "string" ? args["service"] : "that service";
    const description = typeof args["description"] === "string" ? args["description"] : "the requested action";
    return (
      `Write/destructive actions on ${service} aren't available for that operation. ` +
      `I can't ${description} on ${service} from here. ` +
      `Continuing with the rest of your request if there's a buildable part.`
    );
  }

  // ── Write-proxy tool gate ─────────────────────────────────────────────────
  // Tools named "<serverSlug>__<toolName>" were dynamically added by dispatcher
  // from write/destructive MCP tools that require explicit user approval before
  // the backend executes them. This branch handles the pause-approve-execute flow.

  if (ctx.writeMcpRegistry?.has(name)) {
    const meta = ctx.writeMcpRegistry.get(name)!;
    const toolCallId = ctx.toolCallId ?? randomUUID();
    const sessionId = ctx.sessionId ?? "";

    // Fail-all: if any write action in this turn was already denied, auto-deny
    // this one without prompting — partial execution of a write sequence is unsafe.
    if (ctx.writeDenied?.value) {
      try {
        getWebSocketServer().emitToRoom(sessionId, "build:write_action_cancelled", {
          toolCallId,
          toolName: meta.mcpToolName,
          serverSlug: meta.serverSlug,
          sessionId,
        });
      } catch { /* ws not available */ }
      return "Action cancelled: a previous write action was denied this turn.";
    }

    // Emit approval request and await user decision (or timeout).
    const pendingPromise = createPendingApproval(toolCallId, sessionId);

    let emitSucceeded = false;
    try {
      getWebSocketServer().emitToRoom(sessionId, "build:write_action_approval_required", {
        toolCallId,
        serverSlug: meta.serverSlug,
        toolName: meta.mcpToolName,
        toolInput: args,
        timeoutMs: APPROVAL_TIMEOUT_MS,
        sessionId,
      });
      emitSucceeded = true;
    } catch {
      // WS unavailable — can't deliver prompt to user, must deny.
      resolveApproval(toolCallId, sessionId, false);
    }

    let approved: boolean;
    if (!emitSucceeded) {
      approved = false;
    } else {
      // The timeout independently resolves the pending entry false so the map
      // stays clean even when the user doesn't respond in time.
      const timeoutPromise = new Promise<boolean>((resolve) =>
        setTimeout(() => {
          resolveApproval(toolCallId, sessionId, false);
          resolve(false);
        }, APPROVAL_TIMEOUT_MS),
      );
      approved = await Promise.race([pendingPromise, timeoutPromise]);

      if (!approved) {
        // Distinguish timeout from explicit deny via a separate WS event.
        try {
          getWebSocketServer().emitToRoom(sessionId, "build:write_action_denied", {
            toolCallId,
            toolName: meta.mcpToolName,
            serverSlug: meta.serverSlug,
            sessionId,
          });
        } catch { /* ws not available */ }
      }
    }

    if (!approved) {
      if (ctx.writeDenied) ctx.writeDenied.value = true;
      return "Action denied: the write action was not approved by the user.";
    }

    // User approved — execute it.
    return callMcpTool(meta, args, "lampcode-write-proxy");
  }

  if (name === "ask_user") {
    const question = typeof args["question"] === "string" ? args["question"].trim() : "";
    if (!question) return "Error: ask_user needs a question.";
    const sessionId = ctx.sessionId;
    const toolCallId = ctx.toolCallId;
    // Same precondition as the write proxies: with no session to ask through,
    // there is nobody to answer, and inventing one would defeat the tool.
    if (!sessionId || !toolCallId) {
      return "Could not ask: no live session. Decide it yourself and say which assumption you made.";
    }

    const rawOptions = Array.isArray(args["options"]) ? args["options"] : [];
    const options = rawOptions
      .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
      .map((o) => ({
        label: String(o["label"] ?? ""),
        description: typeof o["description"] === "string" ? o["description"] : "",
        recommended: o["recommended"] === true,
      }))
      .filter((o) => o.label.length > 0)
      .slice(0, 4);

    const pending = createPendingAnswer(toolCallId, sessionId);
    try {
      getWebSocketServer().emitToRoom(sessionId, "build:question_asked", {
        toolCallId,
        question,
        options,
        timeoutMs: ANSWER_TIMEOUT_MS,
        sessionId,
      });
    } catch {
      // No websocket means the prompt never reaches anyone. Resolve the entry
      // rather than leaving it in the Map, and tell the model to proceed.
      resolveAnswer(toolCallId, sessionId, "");
      return "Could not ask: no live session. Decide it yourself and say which assumption you made.";
    }

    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => {
        resolveAnswer(toolCallId, sessionId, "");
        resolve(null);
      }, ANSWER_TIMEOUT_MS),
    );
    const answer = await Promise.race([pending, timeout]);

    if (answer === null || answer === "") {
      return (
        "No answer — the person did not reply in time. Do NOT ask again. Pick the most " +
        "reasonable option yourself, build it, and state in your summary which assumption you made."
      );
    }
    return `The person answered: ${answer}`;
  }

  // Read-only MCP tools, on a gateway that cannot run them itself. Deliberately
  // AFTER the write branch: if a name somehow appeared in both registries the
  // write path claims it first, so this can never become a way around approval.
  if (ctx.readMcpRegistry?.has(name)) {
    return callMcpTool(ctx.readMcpRegistry.get(name)!, args, "lampcode-mcp-read");
  }

  return `Error: unknown tool "${name}".`;
}
