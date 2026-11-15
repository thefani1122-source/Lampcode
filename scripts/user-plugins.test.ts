import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseUserPluginPackage } from "../src/agents/user-plugins.js";

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
  ".mcp.json": JSON.stringify({ mcpServers: { docs: { command: "node", args: ["server.js"] } } }),
  "README.md": "# Frontend Toolkit",
};
const parsed = parseUserPluginPackage(manifest, files, "example", "frontend-toolkit");
assert.equal(parsed.pluginId, "example.frontend-toolkit");
assert.equal(parsed.version, "1.2.0");
assert.equal(parsed.license, "MIT");
assert.deepEqual(parsed.capabilities.map((cap) => cap.kind).sort(), ["agent", "command", "mcp", "skill"]);
assert.equal(parsed.capabilities.find((cap) => cap.kind === "skill")?.path, "skills/react/SKILL.md");
assert.equal(parsed.capabilities.find((cap) => cap.kind === "mcp")?.name, "docs");
assert.equal(parsed.contentHash.length, 64);

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
const registry = readFileSync("src/agents/tools/registry.ts", "utf8");
for (const name of ["install_plugin_from_github", "list_plugins", "load_plugin_capability", "manage_plugin"]) {
  assert.ok(registry.includes('["' + name + '"'), "missing runtime handler for " + name);
}
console.log("All declarative plugin package checks passed.");
