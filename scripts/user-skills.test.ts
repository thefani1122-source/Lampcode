import assert from "node:assert/strict";
import { parseUserSkillDocument, USER_SKILL_MAX_BYTES } from "../src/agents/user-skills.js";

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
assert.throws(() => parseUserSkillDocument("---\nname: missing-description\n---\n\nInstructions."), /description is required/);
assert.throws(() => parseUserSkillDocument("---\nname: Not_Valid\ndescription: Invalid name.\n---\n\nInstructions."), /Skill name/);
assert.throws(() => parseUserSkillDocument("---\nname: -bad\ndescription: Invalid name.\n---\n\nInstructions."), /Skill name/);
assert.throws(() => parseUserSkillDocument("---\nname: valid-name\ndescription: ok\n---\n"), /instructions/);
assert.throws(() => parseUserSkillDocument("---\nname: valid-name\ndescription: " + "x".repeat(1025) + "\n---\n\nInstructions."), /description is required/);
assert.throws(() => parseUserSkillDocument("---\nname: valid-name\ndescription: ok\nversion: latest\n---\n\nInstructions."), /semantic version/);
assert.throws(() => parseUserSkillDocument("---\nname: valid-name\ndescription: ok\n---\n\n" + "x".repeat(USER_SKILL_MAX_BYTES)), /48 KiB/);
assert.throws(() => parseUserSkillDocument("---\nname: valid-name\ndescription: ok\n---\n\na\u0000b"), /null byte/);

console.log("All user skill document validation checks passed.");
