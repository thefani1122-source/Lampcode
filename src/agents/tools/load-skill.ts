import { readFile } from "fs/promises";
import { join } from "path";
import { parseSkillFrontmatter, ALL_SKILL_NAMES } from "../prompt-builder.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

const SKILLS_DIR = join(process.cwd(), "src", "skills");
const KNOWN_SKILL_NAMES = new Set<string>(ALL_SKILL_NAMES);
export const loadSkillHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
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
  
};

