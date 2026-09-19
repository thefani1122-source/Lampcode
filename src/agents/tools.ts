import { randomUUID } from "node:crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "./model-gateway.js";
import { parseSkillFrontmatter, ALL_SKILL_NAMES } from "./prompt-builder.js";
import { logger } from "../server/logger.js";
import { createPendingApproval, resolveApproval, APPROVAL_TIMEOUT_MS } from "./pending-approvals.js";
import { getWebSocketServer } from "../websocket/server.js";
import { writeFilesToSandbox, verifyBrowserRender, runTypeCheck } from "../preview/e2b-service.js";
import type { WriteProxyRegistry } from "./mcp-tool-classifier.js";

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
    name: "write_files",
    description:
      "Write files into the project's live preview sandbox. Use this instead of printing " +
      "code in your reply — files only exist once written. Call it as many times as you " +
      "need; later writes to the same path replace earlier ones, and files you don't " +
      "write are left alone. After writing, verify with check_page before you finish.",
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
];

const SKILLS_DIR = join(process.cwd(), "src", "skills");

// Allowlist check before touching the filesystem — `name` is a model-chosen
// string derived from user input, so this is defense in depth against path
// traversal even though ALL_SKILL_NAMES already constrains what's meaningful.
const KNOWN_SKILL_NAMES = new Set<string>(ALL_SKILL_NAMES);

// How long to wait for a callTool() response after the user approves.
const CALL_TOOL_TIMEOUT_MS = 30_000;

export interface ToolExecutionContext {
  /** Same set already inlined into the user message by buildContextBlock() —
   *  read_project_file re-serves from here, it doesn't reach the filesystem. */
  contextFiles?: Array<{ path: string; content: string }> | undefined;
  /** Required for write-proxy tools — used as the correlation key and WS room. */
  sessionId?: string | undefined;
  /** Registry of write-proxy tool names → MCP execution metadata.
   *  Populated by dispatcher from classifier results when enableTools is true. */
  writeMcpRegistry?: WriteProxyRegistry | undefined;
  /** Shared flag: set to true after any write-proxy in this turn is denied.
   *  Subsequent write-proxy calls in the same turn auto-deny without prompting,
   *  preventing partial execution of a multi-step write sequence. */
  writeDenied?: { value: boolean } | undefined;
  /** Anthropic tool_use block ID — used as the pending-approval correlation key. */
  toolCallId?: string | undefined;
  /** Required by the agentic build tools — identifies the live sandbox. */
  projectId?: string | undefined;
  /** Accumulator the agentic build path reads back once the model is done.
   *  write_files records into this as well as writing to the sandbox, so the
   *  caller ends up with the same file map the old fence-parsing path produced
   *  and every downstream gate keeps working unchanged. */
  generatedFiles?: Record<string, string> | undefined;
  /** Forwards sandbox/dev-server output to the client's build log. */
  onLog?: ((line: string) => void) | undefined;
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

  if (name === "write_files" || name === "check_page" || name === "check_types") {
    const projectId = ctx.projectId;
    if (!projectId) return "Error: no project sandbox is attached to this build.";

    if (name === "write_files") {
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
      if (ctx.generatedFiles) Object.assign(ctx.generatedFiles, files);
      const toWrite = ctx.generatedFiles ?? files;

      try {
        const url = await writeFilesToSandbox(projectId, toWrite, ctx.onLog);
        return (
          `Wrote ${Object.keys(files).length} file(s): ${Object.keys(files).join(", ")}.\n` +
          `The app is running at ${url}. Call check_page to see what it actually renders.`
        );
      } catch (err) {
        return `Error writing files: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (name === "check_page") {
      try {
        const { ok, issues } = await verifyBrowserRender(projectId);
        if (ok || issues.length === 0) return "The page rendered successfully with no console errors.";
        return `The page has problems:\n${issues.map((i) => `- ${i.source}: ${i.message}`).join("\n")}`;
      } catch (err) {
        return `Error checking the page: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    try {
      const { ok, issues } = await runTypeCheck(projectId);
      if (ok || issues.length === 0) return "No type errors.";
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

    // User approved — execute via a fresh MCP client (not the discovery client).
    const client = new Client({ name: "lampcode-write-proxy", version: "1.0.0" });
    const headers: Record<string, string> = {};
    if (meta.authToken !== null) headers["Authorization"] = `Bearer ${meta.authToken}`;
    const transport = new StreamableHTTPClientTransport(new URL(meta.serverUrl), {
      requestInit: { headers },
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await client.connect(transport as any);

      const callTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("callTool timed out")), CALL_TOOL_TIMEOUT_MS),
      );
      const callResult = await Promise.race([
        client.callTool({ name: meta.mcpToolName, arguments: args }),
        callTimeout,
      ]);

      const blocks = callResult.content as Array<{ type: string; text?: string }>;
      const text = blocks.map((b) => b.text ?? `[${b.type}]`).join("\n");

      if (callResult.isError) {
        logger.warn({ toolName: meta.mcpToolName, serverSlug: meta.serverSlug, text }, "[tools] Write-proxy callTool returned isError");
        return `Error from ${meta.serverSlug}: ${text}`;
      }
      return text || "(tool returned no content)";
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), toolName: meta.mcpToolName, serverSlug: meta.serverSlug },
        "[tools] Write-proxy callTool failed",
      );
      return `Error: could not execute ${meta.mcpToolName} on ${meta.serverSlug}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  return `Error: unknown tool "${name}".`;
}
