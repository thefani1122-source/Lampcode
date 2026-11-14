import { createHash } from "node:crypto";

export const USER_SKILL_MAX_BYTES = 48 * 1024;
export const USER_SKILL_MAX_REFERENCE_FILES = 20;
export const USER_SKILL_MAX_REFERENCE_FILE_BYTES = 32 * 1024;
export const USER_SKILL_MAX_REFERENCE_TOTAL_BYTES = 256 * 1024;
export const USER_SKILL_NAME_PREFIX = "library:";
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedUserSkill {
  name: string;
  slug: string;
  description: string;
  version: string;
  body: string;
  normalizedContent: string;
  resources: Record<string, string>;
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
 * Validate a bounded set of portable Markdown reference documents.
 * Only Markdown files in the references/ tree are persisted in this release; scripts and binary
 * assets are intentionally unsupported and never executed.
 */
function validateSkillResources(input: Record<string, string>): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Skill references must be a path-to-text map.");
  }

  const entries = Object.entries(input);
  if (entries.length > USER_SKILL_MAX_REFERENCE_FILES) {
    throw new Error(`A skill can include at most ${USER_SKILL_MAX_REFERENCE_FILES} reference Markdown files.`);
  }

  const validated: Record<string, string> = {};
  let totalBytes = 0;
  for (const [path, content] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const segments = path.split("/");
    const validPath =
      path.length <= 240 &&
      /^references\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/i.test(path) &&
      segments.every((segment) => segment !== "." && segment !== ".." && segment.length > 0);
    if (!validPath) {
      throw new Error(`Unsupported skill reference path: ${path}. Only safe references/**/*.md paths are accepted.`);
    }
    if (typeof content !== "string" || content.includes("\u0000")) {
      throw new Error(`Skill reference "${path}" must be plain text without null bytes.`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > USER_SKILL_MAX_REFERENCE_FILE_BYTES) {
      throw new Error(`Skill reference "${path}" exceeds the 32 KiB per-file limit.`);
    }
    totalBytes += bytes;
    if (totalBytes > USER_SKILL_MAX_REFERENCE_TOTAL_BYTES) {
      throw new Error("Combined skill references exceed the 256 KiB limit.");
    }
    validated[path] = content;
  }
  return validated;
}

/**
 * Parse a portable Agent Skills package.
 *
 * The package entry point is SKILL.md and optional Markdown references are
 * stored separately so the model can retrieve them on demand. YAML, scripts
 * and any content from the package are never evaluated.
 */
export function parseUserSkillPackage(
  raw: string,
  resources: Record<string, string> = {},
): ParsedUserSkill {
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

  const validatedResources = validateSkillResources(resources);
  const hash = createHash("sha256").update(normalizedContent, "utf8");
  for (const [path, content] of Object.entries(validatedResources)) {
    hash.update("\u0000" + path + "\u0000" + Buffer.byteLength(content, "utf8") + "\u0000");
    hash.update(content, "utf8");
  }

  return {
    name,
    slug: name,
    description,
    version,
    body,
    normalizedContent,
    resources: validatedResources,
    contentHash: hash.digest("hex"),
  };
}

/** Backward-compatible single-file parser used by existing project callers/tests. */
export function parseUserSkillDocument(raw: string): ParsedUserSkill {
  return parseUserSkillPackage(raw, {});
}
