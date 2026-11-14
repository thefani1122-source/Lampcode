import { createHash } from "node:crypto";

export const USER_SKILL_MAX_BYTES = 48 * 1024;
export const USER_SKILL_NAME_PREFIX = "library:";
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface ParsedUserSkill {
  name: string;
  slug: string;
  description: string;
  version: string;
  body: string;
  normalizedContent: string;
  contentHash: string;
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Parse the portable Agent Skills SKILL.md entry point.
 *
 * This parser intentionally supports the small frontmatter subset LampCode
 * needs (name, description and optional version). It does not evaluate YAML,
 * templates, scripts or any content from the skill.
 */
export function parseUserSkillDocument(raw: string): ParsedUserSkill {
  if (typeof raw !== "string") throw new Error("SKILL.md content must be text.");
  const normalizedContent = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalizedContent) throw new Error("SKILL.md is empty.");
  if (Buffer.byteLength(normalizedContent, "utf8") > USER_SKILL_MAX_BYTES) {
    throw new Error("SKILL.md must be 48 KiB or smaller.");
  }
  if (normalizedContent.includes("\0")) throw new Error("SKILL.md contains a null byte.");

  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalizedContent);
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter (---).");

  const frontmatter = match[1] ?? "";
  const lines = frontmatter.split("\n");
  let name = "";
  let description = "";
  let version = "1.0.0";
  const seenFields = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const nameMatch = /^name:\s*(.*)$/.exec(line);
    if (nameMatch) {
      if (seenFields.has("name")) throw new Error("SKILL.md frontmatter contains duplicate name fields.");
      seenFields.add("name");
      name = parseScalar(nameMatch[1] ?? "");
      continue;
    }
    const versionMatch = /^version:\s*(.*)$/.exec(line);
    if (versionMatch) {
      if (seenFields.has("version")) throw new Error("SKILL.md frontmatter contains duplicate version fields.");
      seenFields.add("version");
      const candidate = parseScalar(versionMatch[1] ?? "");
      if (candidate) version = candidate;
      continue;
    }
    const descriptionMatch = /^description:\s*(.*)$/.exec(line);
    if (descriptionMatch) {
      if (seenFields.has("description")) throw new Error("SKILL.md frontmatter contains duplicate description fields.");
      seenFields.add("description");
      const first = (descriptionMatch[1] ?? "").trim();
      if (first === ">" || first === "|") {
        const descriptionLines: string[] = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? "")) {
          i++;
          descriptionLines.push((lines[i] ?? "").trim());
        }
        description = first === ">" ? descriptionLines.join(" ") : descriptionLines.join("\n");
      } else {
        description = parseScalar(first);
      }
    }
  }

  name = name.trim();
  description = description.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!name || name.length > 64 || !SKILL_NAME_RE.test(name)) {
    throw new Error("Skill name must be 1–64 lowercase letters, numbers or hyphens, and cannot start or end with a hyphen.");
  }
  if (!description || description.length > 1024) {
    throw new Error("Skill description is required and must be 1,024 characters or shorter.");
  }
  if (!VERSION_RE.test(version)) {
    throw new Error("Skill version must use semantic version format, for example 1.0.0.");
  }

  const body = normalizedContent.slice(match[0].length).trim();
  if (!body) throw new Error("SKILL.md must include instructions after the frontmatter.");

  return {
    name,
    slug: name,
    description,
    version,
    body,
    normalizedContent,
    contentHash: createHash("sha256").update(normalizedContent, "utf8").digest("hex"),
  };
}
