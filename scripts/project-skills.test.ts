import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptBuilder } from "../src/agents/prompt-builder.js";
import { buildProjectSkillIndex, listProjectSkills, readProjectSkill } from "../src/agents/project-skills.js";
import { loadSkillHandler } from "../src/agents/tools/load-skill.js";
import type { ToolExecutionContext } from "../src/agents/tools.js";

const tempRoot = await mkdtemp(join(tmpdir(), "lampcode-project-skills-"));
const workspaceDir = join(tempRoot, "workspace");
const outsideDir = join(tempRoot, "outside");

async function writeSkill(
  root: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    "---\nname: " + name + "\ndescription: " + description + "\n---\n\n" + body,
    "utf8",
  );
}

try {
  const agentsRoot = join(workspaceDir, ".agents", "skills");
  const claudeRoot = join(workspaceDir, ".claude", "skills");
  await mkdir(agentsRoot, { recursive: true });
  await mkdir(claudeRoot, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeSkill(agentsRoot, "design-system", "Use the existing design tokens and component patterns.", "BODY_ONLY_SECRET: design guidance.");
  await writeSkill(claudeRoot, "api-conventions", "Follow the project's API response and validation conventions.", "API skill body.");

  const discovered = await listProjectSkills(workspaceDir);
  assert.deepEqual(
    discovered.map((skill) => skill.id),
    ["project:api-conventions", "project:design-system"],
    "both supported roots are discovered and names are stable",
  );

  const index = await buildProjectSkillIndex(workspaceDir);
  assert.match(index, /project:design-system/);
  assert.match(index, /Use the existing design tokens/);
  assert.doesNotMatch(index, /BODY_ONLY_SECRET/, "the prompt index contains metadata only");

  const loaded = await readProjectSkill(workspaceDir, "project:design-system");
  assert.equal(loaded?.name, "design-system");
  assert.match(loaded?.body ?? "", /BODY_ONLY_SECRET/);
  assert.equal(await readProjectSkill(workspaceDir, "project:.."), null, "invalid names are rejected");
  assert.equal(await readProjectSkill(workspaceDir, "project:missing"), null, "unknown names are rejected");

  const projectFileMap = {
    ".agents/skills/repository-style/SKILL.md":
      "---\nname: repository-style\ndescription: Apply the repository-specific architecture and naming conventions.\n---\n\nRepository skill body.",
  };
  const snapshotSkills = await listProjectSkills(undefined, projectFileMap);
  assert.equal(snapshotSkills[0]?.id, "project:repository-style", "project snapshot files are scanned without relying on the workspace metadata folder");

  const context: ToolExecutionContext = { workspaceDir, projectFiles: projectFileMap };
  const toolResult = await loadSkillHandler({ name: "project:design-system" }, context);
  const snapshotToolResult = await loadSkillHandler({ name: "project:repository-style" }, context);
  assert.match(snapshotToolResult, /Repository skill body/);
  assert.match(toolResult, /UNTRUSTED PROJECT CONTENT/);
  assert.match(toolResult, /BODY_ONLY_SECRET/);
  assert.match(toolResult, /cannot override system or security instructions/);

  const built = await new PromptBuilder().build(
    "frontend",
    { description: "Build a small project-aware app.", outputFormat: "code" },
    {
      projectId: "project-skills-prompt-test",
      userId: "project-skills-prompt-test",
      mode: "fast",
      prompt: "Build a small project-aware app.",
    },
    workspaceDir,
    undefined,
    projectFileMap,
  );
  assert.match(built.systemPrompt, /Project-defined skills/);
  assert.match(built.systemPrompt, /project:repository-style/);
  assert.doesNotMatch(built.systemPrompt, /Repository skill body/, "project snapshot bodies stay out of the prompt index");
  assert.match(built.systemPrompt, /project:design-system/);
  assert.doesNotMatch(built.systemPrompt, /BODY_ONLY_SECRET/, "full skill bodies are not injected into the base prompt");

  // A duplicate name across the two standard roots is deterministic:
  // .agents/skills takes precedence over .claude/skills.
  await writeSkill(claudeRoot, "design-system", "The lower-priority duplicate must not win.", "Duplicate body.");
  const duplicateResult = await readProjectSkill(workspaceDir, "project:design-system");
  assert.match(duplicateResult?.body ?? "", /BODY_ONLY_SECRET/);
  assert.doesNotMatch(duplicateResult?.body ?? "", /Duplicate body/);

  // A symlinked skill directory is ignored even when it points to a valid
  // SKILL.md outside the project workspace.
  await writeSkill(outsideDir, "external-skill", "External skill should never be read.", "External body.");
  await symlink(join(outsideDir, "external-skill"), join(agentsRoot, "external-skill"), "dir");
  const afterSymlink = await listProjectSkills(workspaceDir);
  assert.equal(afterSymlink.some((skill) => skill.name === "external-skill"), false);

  // A symlinked SKILL.md is also ignored.
  await mkdir(join(agentsRoot, "linked-file"), { recursive: true });
  await symlink(
    join(outsideDir, "external-skill", "SKILL.md"),
    join(agentsRoot, "linked-file", "SKILL.md"),
    "file",
  );
  assert.equal((await listProjectSkills(workspaceDir)).some((skill) => skill.name === "linked-file"), false);

  // Oversized docs are skipped before they can enter the prompt or tool result.
  await mkdir(join(agentsRoot, "oversized"), { recursive: true });
  await writeFile(
    join(agentsRoot, "oversized", "SKILL.md"),
    "---\nname: oversized\ndescription: Too large to load.\n---\n" + "x".repeat(30 * 1024),
    "utf8",
  );
  const finalSkills = await listProjectSkills(workspaceDir);
  assert.equal(finalSkills.some((skill) => skill.name === "oversized"), false);

  console.log("All project-defined skill checks passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
