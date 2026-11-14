import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUserSkillDocument, parseUserSkillPackage, USER_SKILL_MAX_BYTES, USER_SKILL_MAX_REFERENCE_FILE_BYTES } from "../src/agents/user-skills.js";

const valid = [
  "---",
  "name: react-accessibility",
  "description: Apply accessible React component patterns when creating or reviewing UI.",
  "version: 1.2.0",
  "---",
  "",
  "# React accessibility",
  "",
  "Use semantic HTML and label form controls.",
].join("\n");

const parsed = parseUserSkillDocument(valid);
assert.equal(parsed.name, "react-accessibility");
assert.equal(parsed.slug, "react-accessibility");
assert.equal(parsed.version, "1.2.0");
assert.match(parsed.description, /accessible React component patterns/);
assert.match(parsed.body, /semantic HTML/);
assert.equal(parsed.contentHash.length, 64);

assert.equal(parsed.normalizedContent, valid);

const withReferences = parseUserSkillPackage(valid, {
  "references/api/auth.md": "Check ownership and tenant membership on every protected request.",
  "references/api/errors.md": "Return stable error codes and never expose stack traces.",
});
assert.equal(Object.keys(withReferences.resources).length, 2);
assert.match(withReferences.resources["references/api/auth.md"] ?? "", /tenant membership/);
assert.notEqual(withReferences.contentHash, parseUserSkillDocument(valid).contentHash);
assert.equal(
  withReferences.contentHash,
  parseUserSkillPackage(valid, {
    "references/api/errors.md": "Return stable error codes and never expose stack traces.",
    "references/api/auth.md": "Check ownership and tenant membership on every protected request.",
  }).contentHash,
);
assert.throws(
  () => parseUserSkillPackage(valid, { "assets/logo.png": "not a reference" }),
  /Unsupported skill reference path/,
);
assert.throws(
  () => parseUserSkillPackage(valid, { "references/control.md": "bad\u0001content" }),
  /unsupported control characters/,
);

assert.throws(
  () => parseUserSkillPackage(valid, { "../secrets.md": "do not load" }),
  /Unsupported skill reference path/,
);
assert.throws(
  () => parseUserSkillPackage(valid, { "references/../secrets.md": "do not load" }),
  /Unsupported skill reference path/,
);
assert.throws(
  () => parseUserSkillPackage(valid, { "references/null.md": "bad\u0000content" }),
  /null bytes/,
);
assert.throws(
  () => parseUserSkillPackage(valid, { "references/too-large.md": "x".repeat(USER_SKILL_MAX_REFERENCE_FILE_BYTES + 1) }),
  /32 KiB per-file limit/,
);
assert.throws(
  () => parseUserSkillPackage(valid, Object.fromEntries(
    Array.from({ length: 21 }, (_, i) => ["references/r" + i + ".md", ""]),
  )),
  /at most 20 reference/,
);
assert.throws(
  () => parseUserSkillPackage(valid, Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => ["references/r" + i + ".md", "x".repeat(30 * 1024)]),
  )),
  /256 KiB limit/,
);

const buildVersion = parseUserSkillDocument(
  "---\nname: semver-build\ndescription: Validate stable package versions.\nversion: 2.3.4-beta.1+build.7\n---\n\nInstructions.",
);
assert.equal(buildVersion.version, "2.3.4-beta.1+build.7");

const quoted = parseUserSkillDocument(
  "---\r\nname: api-review\r\ndescription: 'Review API contracts: auth, validation, and errors.'\r\n---\r\n\r\nCheck ownership on every request.",
);
assert.equal(quoted.description, "Review API contracts: auth, validation, and errors.");
assert.match(quoted.body, /Check ownership/);

const folded = parseUserSkillDocument(
  "---\nname: long-description\ndescription: >\n  Review server routes carefully.\n  Check validation and authorization.\n---\n\nUse the checklist.",
);
assert.equal(folded.description, "Review server routes carefully. Check validation and authorization.");

assert.throws(() => parseUserSkillDocument("No YAML frontmatter"), /YAML frontmatter/);
assert.throws(() => parseUserSkillDocument("---\nname: duplicate\nname: attacker\ndescription: Invalid duplicate metadata.\n---\n\nInstructions."), /duplicate name/);
assert.throws(() => parseUserSkillDocument("---\nname: duplicate-description\ndescription: First description.\ndescription: Second description.\n---\n\nInstructions."), /duplicate description/);
assert.throws(() => parseUserSkillDocument("---\nname: duplicate-version\ndescription: Duplicate version.\nversion: 1.0.0\nversion: 2.0.0\n---\n\nInstructions."), /duplicate version/);
assert.throws(() => parseUserSkillDocument("---\nname: invalid-semver\ndescription: Invalid semantic version.\nversion: 01.2.3\n---\n\nInstructions."), /semantic version/);
assert.throws(() => parseUserSkillDocument("---\nname: missing-description\n---\n\nInstructions."), /description is required/);
assert.throws(() => parseUserSkillDocument("---\nname: Not_Valid\ndescription: Invalid name.\n---\n\nInstructions."), /Skill name/);
assert.throws(() => parseUserSkillDocument("---\nname: -bad\ndescription: Invalid name.\n---\n\nInstructions."), /Skill name/);
assert.throws(() => parseUserSkillDocument("---\nname: valid-name\ndescription: ok\n---\n"), /instructions/);
assert.throws(() => parseUserSkillDocument("---\nname: valid-name\ndescription: " + "x".repeat(1025) + "\n---\n\nInstructions."), /description is required/);
assert.throws(() => parseUserSkillDocument("---\nname: valid-name\ndescription: ok\nversion: latest\n---\n\nInstructions."), /semantic version/);
assert.throws(() => parseUserSkillDocument("---\nname: valid-name\ndescription: ok\n---\n\n" + "x".repeat(USER_SKILL_MAX_BYTES)), /48 KiB/);
assert.throws(() => parseUserSkillDocument("---\nname: valid-name\ndescription: ok\n---\n\na\u0000b"), /null byte/);

console.log("All user skill document validation checks passed.");


// The table is user-private. The browser's Supabase anon key must not be
// able to read it directly; only the authenticated backend API accesses it.
const skillsMigration = readFileSync(join(process.cwd(), "drizzle", "0014_user_skills.sql"), "utf8");
assert.match(skillsMigration, /ALTER TABLE\s+"public"\."user_skills"\s+ENABLE ROW LEVEL SECURITY;/i);
assert.doesNotMatch(skillsMigration, /^\s*CREATE\s+POLICY\b/im, "user skills must remain inaccessible to browser/PostgREST roles");


// Route-level security and lifecycle contract regression checks. These guard
// the critical API wiring; the full behaviour still needs the authenticated
// integration test against a provisioned database.
const skillsRouteSource = readFileSync(join(process.cwd(), "src", "server", "routes", "skills.ts"), "utf8");
assert.match(skillsRouteSource, /skillsRouter\.get\("\/:id"/);
assert.match(skillsRouteSource, /skillsRouter\.put\("\/:id"/);
assert.match(skillsRouteSource, /skillsRouter\.patch\("\/:id"/);
assert.match(skillsRouteSource, /skillsRouter\.delete\("\/:id"/);
assert.match(skillsRouteSource, /eq\(userSkills\.id, id\),\s*eq\(userSkills\.userId, userId\)/);
assert.match(skillsRouteSource, /parsed\.slug !== existing\.slug/);
assert.match(skillsRouteSource, /revision: sql\x60\$\{userSkills\.revision\} \+ 1\x60/);
assert.match(skillsMigration, /"resources" jsonb NOT NULL DEFAULT '\{\}'::jsonb/i);
assert.match(skillsRouteSource, /resources: parsed\.resources/);
assert.match(skillsRouteSource, /parsedBody\.data\.resources \?\? existing\.resources/);
assert.match(skillsMigration, /ADD COLUMN IF NOT EXISTS "resources"/i);
assert.match(skillsRouteSource, /MAX_SKILL_REQUEST_BYTES = 640 \* 1024/);
assert.match(skillsRouteSource, /async function readBoundedJson\(/);
assert.match(skillsRouteSource, /new Uint8Array\(maxBytes\)/);
assert.match(skillsRouteSource, /body\.getReader\(\)/);
assert.doesNotMatch(skillsRouteSource, /c\.req\.json\(/, "skill API must not buffer unbounded JSON before applying its size limit");
assert.match(skillsMigration, /"resource_paths" jsonb NOT NULL DEFAULT '\[\]'::jsonb/i);
assert.match(skillsMigration, /ADD COLUMN IF NOT EXISTS "resource_paths"/i);
assert.match(skillsRouteSource, /resourcePaths: Object\.keys\(parsed\.resources\)/);

const listSkillsSource = readFileSync(join(process.cwd(), "src", "agents", "tools", "list-skills.ts"), "utf8");
assert.match(listSkillsSource, /resourcePaths: userSkills\.resourcePaths/);
assert.doesNotMatch(listSkillsSource, /resources: userSkills\.resources/, "skill discovery must not load all reference bodies");
const loadSkillSource = readFileSync(join(process.cwd(), "src", "agents", "tools", "load-skill.ts"), "utf8");
assert.match(loadSkillSource, /userSkills\.resources}->>\$\{resourcePath\}/);
assert.match(loadSkillSource, /parseUserSkillDocument\(skill\.content\)/);
