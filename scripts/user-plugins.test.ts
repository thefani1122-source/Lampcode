import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeUserPluginRecordId, parseUserPluginPackage, resolvePluginSkillResourcePath } from "../src/agents/user-plugins.js";

const manifest = JSON.stringify({
  name: "frontend-toolkit",
  description: "Frontend design and review capabilities.",
  version: "1.2.0",
  author: { name: "Example Publisher" },
  license: "MIT",
});
const skill = [
  "---",
  "name: react-accessibility",
  "description: Apply accessible React patterns to components and forms.",
  "version: 1.0.0",
  "---",
  "",
  "# React accessibility",
  "",
  "Use semantic HTML and label controls.",
].join("\n");
const files = {
  ".claude-plugin/plugin.json": manifest,
  "skills/react/SKILL.md": skill,
  "skills/react/references/checklist.md": "Check labels and keyboard navigation.",
  "agents/reviewer.md": "# Review agent\n\nReview changes for correctness and maintainability.",
  "commands/review.md": "# Review command\n\nInspect changed files and report concrete findings.",
  ".mcp.json": JSON.stringify({ mcpServers: { docs: { command: "node", args: ["docs.js"] }, search: { command: "node", args: ["search.js"] } } }),
  "README.md": "# Frontend Toolkit",
};
const multiMcpFiles = {
  ...files,
  ".mcp.json": JSON.stringify({ mcpServers: {
    docs: { command: "node", args: ["docs.js"] },
    search: { command: "node", args: ["search.js"] },
  } }),
};
const parsed = parseUserPluginPackage(manifest, multiMcpFiles, "example", "frontend-toolkit");
assert.equal(parsed.pluginId, "example.frontend-toolkit");
assert.equal(parsed.version, "1.2.0");
assert.equal(parsed.license, "MIT");
assert.deepEqual([...new Set(parsed.capabilities.map((cap) => cap.kind))].sort(), ["agent", "command", "mcp", "skill"]);
assert.equal(parsed.capabilities.find((cap) => cap.kind === "skill")?.path, "skills/react/SKILL.md");
assert.deepEqual(parsed.capabilities.find((cap) => cap.kind === "skill")?.resourcePaths, ["references/checklist.md"]);
assert.equal(resolvePluginSkillResourcePath("skills/react/SKILL.md", "references/checklist.md"), "skills/react/references/checklist.md");
assert.equal(resolvePluginSkillResourcePath("skills/SKILL.md", "references/nested/guide.md"), "skills/references/nested/guide.md");
assert.equal(resolvePluginSkillResourcePath("skills/react/SKILL.md", "../secrets.md"), null);
assert.equal(resolvePluginSkillResourcePath("agents/reviewer.md", "references/guide.md"), null);
const recordId = "2bfcf0d7-8e8b-4c80-8fd8-f99a8f0d1a13";
assert.equal(normalizeUserPluginRecordId(recordId), recordId);
assert.equal(normalizeUserPluginRecordId("plugin:" + recordId), recordId);
assert.equal(normalizeUserPluginRecordId("plugin:not-a-uuid"), null);
assert.deepEqual(parsed.capabilities.filter((cap) => cap.kind === "mcp").map((cap) => cap.id).sort(), [".mcp.json#docs", ".mcp.json#search"]);
assert.equal(parsed.contentHash.length, 64);

const tooManyServers = Object.fromEntries(Array.from({ length: 21 }, (_, i) => ["server-" + i, { command: "node", args: [] }]));
assert.throws(
  () => parseUserPluginPackage(manifest, { ...files, ".mcp.json": JSON.stringify({ mcpServers: tooManyServers }) }, "example", "frontend-toolkit"),
  /at most 20 server entries/,
);


assert.throws(
  () => parseUserPluginPackage(manifest, { ...files, "hooks/preToolUse.js": "console.log('no');" }, "example", "frontend-toolkit"),
  /Unsupported plugin file path/,
);
assert.throws(
  () => parseUserPluginPackage(manifest, { ...files, "../secret.md": "no" }, "example", "frontend-toolkit"),
  /Unsupported plugin file path|Unsafe plugin path/,
);
assert.throws(
  () => parseUserPluginPackage(manifest, { ...files, "skills/react/references/bad.md": "bad\u0001text" }, "example", "frontend-toolkit"),
  /unsupported control characters/,
);
const badManifest = JSON.stringify({ name: "bad", version: "1.0.0-01" });
assert.throws(
  () => parseUserPluginPackage(badManifest, { "plugin.json": badManifest, "skills/react/SKILL.md": skill }, "example", "bad"),
  /semantic version/,
);

const migration = readFileSync("drizzle/0015_user_plugins.sql", "utf8");
assert.match(migration, /ALTER TABLE\s+"public"\."user_plugins"\s+ENABLE ROW LEVEL SECURITY;/i);
assert.doesNotMatch(migration, /^\s*CREATE\s+POLICY\b/im, "plugin table must remain default-deny for browser roles");
const schema = readFileSync("src/db/schema.ts", "utf8");
assert.match(schema, /export const userPlugins = pgTable\(/);
const loader = readFileSync("src/agents/tools/load-plugin-capability.ts", "utf8");
assert.match(loader, /item.id === capabilityId/, "capability loading must select the exact declared MCP server, not the first entry in a file");

const installer = readFileSync("src/agents/tools/install-plugin-from-github.ts", "utf8");
assert.match(installer, /repository: existing\.repository/, "updates must snapshot the actual previously installed source repository");
assert.match(installer, /enabled: existing\.enabled/, "updates must preserve a disabled plugin's state");
assert.match(installer, /eq\(userPlugins\.revision, existing\.revision\)/, "updates must reject concurrent stale revisions");
const manager = readFileSync("src/agents/tools/manage-plugin.ts", "utf8");
assert.match(manager, /enabled: previous\.enabled \?\? true/, "rollback must restore the snapshot's enabled state");
assert.match(manager, /normalizeUserPluginRecordId/, "management accepts plugin:<uuid> as displayed in chat");
const runtimeLoader = readFileSync("src/agents/tools/load-plugin-capability.ts", "utf8");
assert.match(runtimeLoader, /cap\.resourcePaths\.includes\(resourcePath\)/, "references must be allowlisted by the selected skill descriptor");
assert.match(runtimeLoader, /resolvePluginSkillResourcePath/, "references must resolve only under their own skill directory");
assert.match(runtimeLoader, /parseUserSkillPackage\(row\.content, \{\}\)/, "skill loader should expose the parsed instruction body, not the YAML frontmatter");
assert.match(runtimeLoader, /JSON\.stringify\(row\.content\)/, "loaded third-party reference text must remain JSON encoded");

const registry = readFileSync("src/agents/tools/registry.ts", "utf8");
for (const name of ["install_plugin_from_github", "list_plugins", "load_plugin_capability", "manage_plugin"]) {
  assert.ok(registry.includes('["' + name + '"'), "missing runtime handler for " + name);
}
console.log("All declarative plugin package checks passed.");
