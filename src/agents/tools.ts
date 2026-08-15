import { readFile } from "fs/promises";
import { join } from "path";
import type { ToolDefinition } from "./model-gateway.js";
import { parseSkillFrontmatter, ALL_SKILL_NAMES } from "./prompt-builder.js";

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
];

const SKILLS_DIR = join(process.cwd(), "src", "skills");

// Allowlist check before touching the filesystem — `name` is a model-chosen
// string derived from user input, so this is defense in depth against path
// traversal even though ALL_SKILL_NAMES already constrains what's meaningful.
const KNOWN_SKILL_NAMES = new Set<string>(ALL_SKILL_NAMES);

export interface ToolExecutionContext {
  /** Same set already inlined into the user message by buildContextBlock() —
   *  read_project_file re-serves from here, it doesn't reach the filesystem. */
  contextFiles?: Array<{ path: string; content: string }> | undefined;
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

  return `Error: unknown tool "${name}".`;
}
