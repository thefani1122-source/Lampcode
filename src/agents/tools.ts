import { randomUUID } from "node:crypto";
import { describeTier } from "../mcp/tiers.js";
import { logger } from "../server/logger.js";
import type { ToolDefinition } from "./model-gateway.js";
import { createPendingApproval, resolveApproval, APPROVAL_TIMEOUT_MS } from "./pending-approvals.js";
import { getWebSocketServer } from "../websocket/server.js";
import type { WriteProxyRegistry } from "./mcp-tool-classifier.js";
import { callMcpTool } from "../mcp/call-tool.js";
import { callApprovedMcpTool } from "../mcp/approved-call.js";
import { DEFERRED_STATIC_HANDLERS, REGISTRY } from "./tools/registry.js";
import type { Checkpoint } from "../verify/checkpoints.js";
import type { RenderReport } from "../verify/render.js";
import type { AgentDispatcher } from "./dispatcher.js";

const SANDBOX_REQUIRED = new Set(["delete_file", "write_files", "edit_file", "list_files", "read_file", "fetch_reference", "read_logs", "check_page", "run_tests", "check_types", "look_at_page"]);

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
    name: "checkpoint",
    description:
      "Save a named snapshot of the current project files for this build. Checkpoints are " +
      "private to this build and do not change files or verification results. Keep the label " +
      "short and use it later with revert if an experiment should be undone.",
    input_schema: {
      type: "object",
      properties: { label: { type: "string", description: "A short name for this snapshot." } },
      required: ["label"],
    },
  },
  {
    name: "revert",
    description:
      "Restore the project to a named checkpoint. This restores changed or deleted files and " +
      "removes files created after the checkpoint. The checkpoint remains available after a " +
      "restore. If any live or stored file operation fails, the tool rolls back its attempted " +
      "changes and reports incomplete paths.",
    input_schema: {
      type: "object",
      properties: { label: { type: "string", description: "The exact checkpoint label to restore." } },
      required: ["label"],
    },
  },
  {
    name: "diff_since",
    description:
      "Show a unified diff of the current project against the build-start files, or against " +
      "an exact named checkpoint. This reads only the in-memory project state and works even " +
      "while the sandbox is unavailable. It does not change files or verification results. " +
      "If output or safety limits omit changes, the result says whether its counts are exact " +
      "or cover only the computed portion.",
    input_schema: {
      type: "object",
      properties: {
        checkpoint: { type: "string", description: "Optional exact checkpoint label to compare from." },
        context: { type: "number", description: "Context lines around changes; defaults to 3." },
        max_chars: { type: "number", description: "Output character budget; defaults to 12000 and is capped at 24000." },
      },
      required: [],
    },
  },
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
    name: "delete_file",
    description:
      "Remove one or more files from the current project. Pass project-relative paths in " +
      "paths. Template-owned files and the app entry point are protected. Missing files are " +
      "reported as already absent; each path reports whether live and stored deletion both " +
      "succeeded.",
    input_schema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          description: "Project-relative paths to remove.",
          items: { type: "string" },
        },
      },
      required: ["paths"],
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
    name: "find_wiring_gaps",
    description:
      "List everything in the project that RENDERS but does nothing: buttons with no " +
      "handler, handlers wired to an empty body, forms that submit nowhere, links to routes " +
      "nothing declares, and fetches against endpoints the backend never defined.\n" +
      "Call this before you say a multi-page app or anything with a backend is done. " +
      "check_page proves a page rendered, check_types proves it compiles, and run_tests " +
      "proves a module behaves — none of them proves a control the user can see will respond " +
      "when clicked, because a test imports a module directly whether or not the app ever " +
      "wires it in. This is the question those three cannot answer.\n" +
      "It is free, needs no sandbox, and takes no arguments. The analysis is textual, so a " +
      "control receiving its handler from a parent may be reported — confirm with read_file " +
      "before changing it, and never satisfy a finding by deleting the element.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "deploy_app",
    description:
      "Put this app live on the user's OWN Vercel account, then check the live URL actually " +
      "answers.\n" +
      "ONLY call this when the user asks for it — 'deploy', 'publish', 'put it live', 'give me " +
      "a link I can share'. NEVER call it on your own initiative. It publishes to an account " +
      "that belongs to them and spends their build minutes, and a build you have not finished " +
      "verifying is not something to put in front of their users.\n" +
      "It deploys the WHOLE app — the frontend and, if there is one, the backend as a function " +
      "so '/api/...' keeps working. It takes no arguments; everything comes from the files you " +
      "have written.\n" +
      "If the user has not connected Vercel it will say so, and that is the answer to pass on — " +
      "not a failure to retry. A deployed URL is reported as working only once it has been " +
      "checked; if the check fails, say that plainly rather than handing over the link as done.",
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
    name: "code_intel",
    description:
      "Ask what a symbol IS and who uses it, resolved by the TypeScript compiler rather than " +
      "by text matching. Give `symbol` for its definition and every real reference, or `path` " +
      "for what that file exports.\n" +
      "Prefer this over search_code whenever the question is about MEANING — \"where does this " +
      "come from\", \"who calls this\", \"what does this file give me\". search_code finds the " +
      "word in comments and strings too; this finds the actual thing. Use it BEFORE renaming " +
      "or changing a signature, so you change every caller rather than the one you were " +
      "looking at.\n" +
      "A file that does not parse is handled with a text fallback instead of failing the " +
      "call, and the result says when that happened — so a mid-edit broken file does not cost " +
      "you the answer about the rest of the project.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "The function, component, type or variable to resolve." },
        path: { type: "string", description: "A file whose exported symbols you want listed instead." },
      },
      required: [],
    },
  },
  {
    name: "impact_analysis",
    description:
      "Before you change a symbol, find out what else depends on it: the callers, the routes " +
      "and endpoints in the files that reach it, whether the change crosses from client code " +
      "into server or database code, and — the part that matters most — WHICH OF THOSE FILES " +
      "HAVE NO TEST.\n" +
      "That last list is the point. A change inside well-tested code is cheap to get wrong " +
      "because something will say so; the same change in a file nothing covers is how a build " +
      "ships broken while every gate passes. Use it before renaming a field, changing a " +
      "function's arguments, or altering anything shared, and let it tell you where to look " +
      "rather than guessing which files were affected.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "The symbol you are about to change." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "search_code",
    description:
      "Search the current project source already held in this build, without reading from " +
      "the sandbox or disk. Use this to find definitions, usages, or related code across " +
      "files instead of opening files one at a time. Literal search is the default; set " +
      "is_regex to true to use a regular expression. Results include the matching line and " +
      "up to two nearby lines. Vendor, build, oversized, and binary-like files are skipped, " +
      "and the result says how many files were skipped. Invalid regular expressions are " +
      "reported as an ordinary error.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to find, or a regular expression when regex is true." },
        is_regex: { type: "boolean", description: "Treat query as a regular expression instead of literal text." },
        path_glob: { type: "string", description: "Optional project-relative glob, e.g. \"src/**/*.ts\"." },
        max_results: { type: "number", description: "Maximum matches to return. Defaults to 40." },
      },
      required: ["query"],
    },
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
    name: "look_at_page",
    description:
      "LOOK at the page you built — a screenshot, which you will see in the next message.\n" +
      "Use this when the problem is visual: layout, spacing, contrast, something overlapping or " +
      "cut off, or a design the user described that you want to compare against. check_page reads " +
      "the DOM and the console, so it catches a blank page or a crash but can never see that the " +
      "header sits on top of the hero.\n" +
      "Expensive in tokens — an image is not cheap. Call it when you have a visual question, not " +
      "after every write. If it tells you the model cannot see images, believe it and stop.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "web_search",
    description:
      "Look something up on the web. Use this ONLY when you need information you do not " +
      "already have: an unfamiliar package's real API, the meaning of an error message you " +
      "have not seen before, or whether a library still works the way you remember.\n" +
      "Do NOT use it for anything about THIS project — `search_code` finds text in these " +
      "files, `code_intel` says what a symbol is and who uses it, and `impact_analysis` says " +
      "what a change would break. Those are free and exact; the web knows nothing about this " +
      "codebase.\n" +
      "If you already have the URL, use `fetch_reference` instead — it reads the page.\n" +
      "You get at most 5 results with short snippets. One search, then get on with the build: " +
      "if it returns nothing useful, continue with what you know and say so in your reply.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to look up, as you would type it into a search box. Be specific — include " +
            "the package name and version, or the exact error text.",
        },
        limit: {
          type: "number",
          description: "How many results you want, 1-5. Defaults to 5.",
        },
      },
      required: ["query"],
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
  /** Screenshots a tool took for the MODEL to look at (F2). A tool result is a
   *  string, so an image has to travel as its own content block in the next
   *  turn — the dispatch loop drains this after each round. Only ever filled
   *  when `visionSupported()` is true. */
  pendingImages?: { value: Array<{ mediaType: string; dataBase64: string; label: string }> } | undefined;
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
  /** Paths removed this dispatch; projectFiles remains the build-start snapshot. */
  deletedFiles?: Set<string> | undefined;
  /** Named snapshots live only for this agentic dispatch. */
  checkpoints?: Map<string, Checkpoint> | undefined;
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
  /** The previous render sweep, so a repeat check can report only what moved.
   *  The browser work is nearly free; what costs money is that everything this
   *  tool returns is re-paid in the context of every later round. A build that
   *  calls check_page eight times should not pay eight times for the same
   *  unchanged page. Last sweep wins. */
  lastRender?: { report: RenderReport | null } | undefined;
  /** Whether the controls have been operated yet this build. The probe drives
   *  a real browser and costs seconds, so it runs ONCE — the first time every
   *  page renders cleanly, which is the first moment its answer can mean
   *  anything. Before that a dead button is indistinguishable from a page that
   *  never loaded. */
  interactionsProbed?: { value: boolean } | undefined;
  /** Monotonic count of write_files/edit_file calls this build. Only meaningful
   *  relative to itself — it exists to date the gate results above. */
  writeCounter?: { value: number } | undefined;
  /** How much code this build added and removed. Until now a build recorded
   *  `filesWritten` and nothing about SIZE, so "do repeated edits grow the
   *  project without cutting anything?" was not a question the data could
   *  answer — and an unmeasured problem stays unmanaged. `removed` staying near
   *  zero while `added` climbs is the signature of an edit that bolts a new
   *  path on beside the old one. */
  churn?: { added: number; removed: number; created: number; replaced: number; edited: number; deleted: number } | undefined;
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
  /**
   * What `deploy_app` needs, resolved by `build.ts` BEFORE the agent runs.
   *
   * Passed in rather than looked up here on purpose. Resolving it would mean
   * importing `integrations.ts` into this file, which pulls the database and the
   * crypto helpers along with it — and `scripts/mcp-tools.test.ts` imports this
   * module, so that import would drag both into a free test that currently needs
   * no credentials. That is trap 9's exact shape (importing `e2b-service.ts`
   * outside the server process hangs for the same reason). `build.ts` already
   * calls `getConnectedMcpServers` and already resolves
   * `getUserSupabaseMcpAuth` this way, so the pattern is the established one.
   *
   * Absent means the user has not connected Vercel — which is a thing to TELL
   * them, not an error.
   */
  deploy?:
    | {
        vercelToken: string;
        teamId?: string | undefined;
        /** What the user called their project; becomes the Vercel project slug. */
        projectName: string;
      }
    | undefined;
}

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

  const handler = REGISTRY.get(name);
  if (handler && !DEFERRED_STATIC_HANDLERS.has(name)) {
    if (SANDBOX_REQUIRED.has(name) && !ctx.projectId) {
      return "Error: no project sandbox is attached to this build.";
    }
    return handler(args, ctx);
  }

  // Keep runtime MCP dispatch here: write proxies must pass the existing approval gate.
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
      // `tier` and `tierNote` are carried for the client; today's UI renders
      // neither, and NOTHING here pretends it does. A separate, stronger
      // confirmation for an irreversible action is a frontend change that has
      // not been made — so the stronger classification is enforced on this
      // side (it is in the registry, in the tool's own description, and in the
      // log below), and the user still answers through the one explicit
      // approval prompt that exists. Inventing a second prompt the client
      // cannot show would be worse than saying so.
      getWebSocketServer().emitToRoom(sessionId, "build:write_action_approval_required", {
        toolCallId,
        serverSlug: meta.serverSlug,
        toolName: meta.mcpToolName,
        toolInput: args,
        timeoutMs: APPROVAL_TIMEOUT_MS,
        tier: meta.tier,
        tierNote: describeTier(meta.tier),
        sessionId,
      });
      logger.info(
        {
          sessionId,
          tool: meta.mcpToolName,
          server: meta.serverSlug,
          tier: meta.tier,
          capability: meta.capability,
        },
        meta.tier === "strong-approval"
          ? "[mcp] asking the user to approve a POSSIBLY IRREVERSIBLE action"
          : "[mcp] asking the user to approve a write action",
      );
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

    if (!approved && ctx.writeDenied) ctx.writeDenied.value = true;
    // Shared post-gate execution point is covered by local MCP integration tests.
    return callApprovedMcpTool(meta, args, approved);
  }

  // Preserve the existing write-proxy precedence for ask_user, then allow other static handlers.
  if (handler) return handler(args, ctx);

  // Read-only MCP tools remain runtime dispatch, separate from static handlers.
if (ctx.readMcpRegistry?.has(name)) {
    return callMcpTool(ctx.readMcpRegistry.get(name)!, args, "lampcode-mcp-read");
  }

  return `Error: unknown tool "${name}".`;

}

