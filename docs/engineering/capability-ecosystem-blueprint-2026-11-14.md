# LampCode Capability Ecosystem Blueprint

**Date:** 2026-11-14  
**Status:** Architecture proposal only; this document does not change runtime or database behaviour.  
**Backend baseline:** main at eaf9c146e080c180d408316b79665fe8ca062fce.  
**Frontend baseline:** thefani1122-source/vibe-coder-suite at d471a220bd2e5a98bf8bc527f3e95c4b7067fa1a.

## Executive decision

LampCode has useful foundations, but it does not yet have a general Claude Code-style skills/plugins ecosystem.

Today there are three separate mechanisms:

1. Built-in guidance skills in src/skills/*.md, enumerated by ALL_SKILL_NAMES in src/agents/prompt-builder.ts.
2. Project-local Agent Skills discovered from .agents/skills/<name>/SKILL.md and .claude/skills/<name>/SKILL.md. This loader is intentionally read-only and treats project content as untrusted reference data.
3. MCP/provider integrations in src/mcp/registry.ts, persisted per user, with OAuth/custom-server connection flows, encrypted credentials, remote tool discovery and separate write approval.

The frontend has an MCP Store at src/routes/mcp.tsx in vibe-coder-suite. It owns a second hardcoded provider catalogue, while the backend owns the actual MCP registry. There is no Skills manager, plugin package installer, agent/command package manager, or unified capability marketplace.

**Recommendation:** build a unified Extensions ecosystem around a portable package manifest and a server-owned capability registry. Skills, agents, commands, and MCP server definitions should be package capabilities, not independent ad-hoc features. Preserve the secure MCP execution path. Do not turn plugin installation into arbitrary code execution in the backend or generated app sandbox.

This blueprint covers the full product direction. It is not a recommendation to ship every capability in one oversized release.

## 1. Product model and terminology

| Term | Meaning | Example |
|---|---|---|
| Skill | Reusable instructions and reference material loaded when relevant | React architecture, database migrations, accessibility |
| Agent | Named specialist with a role, allowed tools and bounded task contract | Test engineer, security reviewer, API designer |
| Command | User-invokable reusable workflow or template | /review, /add-auth, /create-tests |
| MCP integration | Remote service connection that exposes tools/resources through MCP | GitHub, Linear, custom MCP server |
| Plugin / Extension | Versioned installable package that may bundle one or more capabilities | Frontend engineering toolkit |
| Marketplace / Catalog | Searchable index of packages, publishers, versions and trust information | LampCode curated catalog; trusted team catalog |

A plugin is a distribution and lifecycle unit. It is not synonymous with an MCP server. A single plugin may contain several skills and commands, one or more specialist agents, and optional MCP server declarations.

Users should be able to install a standalone skill without installing a plugin, and connect an MCP server without installing a plugin.

## 2. Portable package format

Adopt a versioned LampCode manifest while keeping skill payloads compatible with the open Agent Skills folder convention.

Proposed package layout:

    my-plugin/
      plugin.json
      README.md
      LICENSE
      skills/
        frontend-design/
          SKILL.md
          references/
            design-tokens.md
          assets/
            component-examples/
        testing/
          SKILL.md
      agents/
        test-engineer.md
      commands/
        review.md
      mcp/
        servers.json
      icons/
        plugin.svg

Illustrative manifest:

    {
      "schemaVersion": "1",
      "id": "publisher.frontend-toolkit",
      "name": "Frontend Toolkit",
      "version": "1.2.0",
      "description": "Frontend design, implementation and review capabilities.",
      "publisher": {
        "id": "publisher",
        "name": "Example Publisher",
        "homepage": "https://example.com"
      },
      "license": "MIT",
      "repository": "https://github.com/publisher/frontend-toolkit",
      "compatibility": {
        "lampcode": ">=1.0.0"
      },
      "capabilities": {
        "skills": ["skills/frontend-design", "skills/testing"],
        "agents": ["agents/test-engineer.md"],
        "commands": ["commands/review.md"],
        "mcpServers": ["mcp/servers.json"]
      },
      "permissions": {
        "tools": [],
        "networkHosts": [],
        "requiresUserApproval": []
      }
    }

Package rules:

- The manifest is declarative. It describes content and capabilities; it does not contain executable backend code.
- Every package has a stable publisher-qualified ID, semantic version, schema version, license and source provenance.
- Resolve every referenced path relative to the package root. Reject absolute paths, traversal, symlinks escaping the root, duplicate IDs, unknown capability types and undeclared files where policy requires strict packaging.
- Enforce archive/file count, total uncompressed size, per-file size, nesting-depth and text/binary limits before extraction or persistence.
- Verify package hashes; record the exact installed snapshot so upstream changes cannot silently mutate an installed package.
- Support references/ and assets/ as lazy-loadable resources. Never inject all package contents into model context.
- Scripts may be shipped as inert reference material initially, but are not executable in v1. A future controlled execution capability requires isolated execution, explicit permissions, audit events and resource limits.
- Lifecycle hooks are not executable in v1. Do not evaluate arbitrary JavaScript from a package.

### Compatibility strategy

1. Read standard Agent Skills folders directly, including SKILL.md and optional references/assets, without forcing a single skill to be wrapped in a plugin.
2. Support the manifest format above for multi-capability bundles.
3. Recognize Claude Code-style plugin layouts as an import source where declarative files can be mapped safely. Do not promise full hooks/runtime compatibility when those semantics are not implemented.
4. Show unsupported package elements before installation. Do not silently reinterpret unknown fields or scripts.

This gives LampCode a broad ecosystem without tying the product to one vendor-specific plugin format.

## 3. Sources, installation and lifecycle

The Extensions area should support these sources over time:

- LampCode Catalog: curated, searchable packages maintained or reviewed by LampCode.
- Git repository: install a specific repository, subdirectory and immutable commit/tag. Start with public GitHub; expand after source adapters are tested.
- Archive upload: install a local ZIP/folder export after safe archive inspection.
- Private/team catalog: organization-owned index with publisher and access controls.
- Standalone skill import: import a skill directory or SKILL.md file.

For GitHub installs, resolve a branch/tag to an immutable commit before fetching files. For remote catalogs, use a backend-owned source adapter with HTTPS, redirect restrictions, public-address checks, strict timeouts, content limits and provenance capture. Never let a user-supplied URL become an unrestricted backend fetch or SSRF primitive.

Each installed package should have an explicit lifecycle state:

- installed_disabled
- enabled
- update_available
- incompatible
- revoked
- uninstall_pending, only where cleanup requires a separate step

Store installed version, immutable source revision, manifest snapshot, content hashes, installation time, publisher, trust/review state and last update check. Updates must be an explicit reviewed operation; never overwrite a working version in the background.

Scope must be deliberate:

- User scope: available across the user's projects when enabled.
- Project scope: selected only for a particular project/repository.
- Team scope: centrally managed and available to team projects, in a later phase.

Project settings may override whether a user-installed capability is active for that project, but they must not override platform security rules or granted tool permissions.

## 4. Runtime architecture: discover metadata, load only what is needed

The model should see a compact capability index, not every skill body, every command and every remote tool schema.

Recommended pipeline:

1. Resolve enabled packages for the user and project.
2. Filter compatibility and trust before a package can contribute anything.
3. Build a metadata index containing capability ID, short description, package/version and source.
4. Select relevant capabilities using task type, user request, project stack, explicit user selection and prior task context.
5. Load skill/agent/command bodies on demand via controlled tools. Load references/assets only when the selected skill names them.
6. Attach MCP tools separately using the existing relevance/permission/approval pipeline. A plugin's MCP declaration does not itself grant access to a user's account.
7. Record evidence: which capabilities were considered, selected, loaded, skipped and why.

Runtime precedence must be explicit:

1. Platform/system safety and tool-permission rules.
2. Current user request and explicit user decisions.
3. Current project architecture/contracts and authoritative runtime state.
4. Enabled plugin/skill instructions as untrusted guidance.
5. General model defaults.

A plugin cannot expand its own permission grants by writing instructions that tell the model to use a tool, reveal a secret, ignore a security rule or install another package. Untrusted instructions never become executable permissions.

When a plugin is disabled or uninstalled, its capabilities must disappear from future dispatches. A running build should use the immutable capability snapshot it started with rather than changing halfway through execution.

## 5. Capability-specific contracts

### Skills

- Use standard SKILL.md as the entry point.
- Parse metadata such as name, description, license, compatibility and allowed scope.
- Keep only metadata in the base index; load body on demand.
- Support references and assets by safe relative path and bounded content retrieval.
- Keep current project skill support, but distinguish built-in, project-local, user-installed and team-installed sources.
- Record exact version/hash in build telemetry so agent behaviour is reproducible.

### Agents

- Each agent has an ID, description, instruction file and declared task profile.
- Tool access is selected from an explicit allowlist, not inherited from every tool the parent agent can see.
- Bound model, time, turns, tokens, retries and outputs.
- Treat subagent outputs as evidence/recommendations, not authoritative instructions.
- Use existing internal planner/reviewer/security/fix agents as built-in agents; avoid creating a second parallel orchestration framework.

### Commands

- Commands are user-invoked workflows with typed input schemas, confirmation requirements and expected outputs.
- A command may orchestrate existing safe LampCode tools or delegate bounded work to a named agent.
- Commands cannot directly execute shell scripts in the host backend.
- Destructive, external-write and deployment actions must continue to use existing approval flows.

### MCP integrations

- Preserve OAuth, encrypted secret storage, server discovery, connection diagnostics and read/write gating.
- A plugin may declare an MCP server template, but the user must connect their own account/credentials. Package installation alone must never establish an account connection.
- Reuse current custom MCP URL validation and safe fetch path; no plugin-specific bypass.
- Keep MCP server tool schemas out of the base skill index. Attach only relevant discovered tools within a combined context/tool budget.
- Move provider catalogue to the backend as the single source of truth. The frontend currently maintains a second hardcoded list in vibe-coder-suite/src/routes/mcp.tsx; replace that duplication with a read-only catalogue API and keep connected state user-specific.

### Hooks and executable extensions

Defer arbitrary hooks/scripts until there is a separate sandboxed extension runner. A future runner must have:

- isolated, short-lived execution environment;
- default-deny network and filesystem access;
- declared capabilities and user grants;
- CPU, memory, wall-clock, output and process limits;
- no access to platform secrets or other users' data;
- signed/hashed immutable package version;
- audit trail and kill switch;
- timeout/failure isolation so an extension cannot break a build.

Do not execute plugin code in the long-lived LampCode backend process or in the user's generated app runtime.

## 6. Security and trust model

Imported plugins are supply-chain inputs. Treat descriptions, instructions, metadata, reference documents and tool schemas as untrusted data.

Required controls:

- Strict manifest validation and canonical path checks.
- Package size, file count, archive expansion and decompression-bomb limits.
- Publisher identity, source URL, immutable revision and integrity hashes.
- Trust labels: LampCode-reviewed, verified publisher, community/unreviewed, blocked/revoked.
- User-visible review of requested permissions before enabling a package.
- Per-plugin, per-project and per-MCP-server grants; minimum necessary access.
- Explicit confirmation for tool writes, destructive operations, account changes, deployments and external side effects.
- Secrets never enter model-visible descriptions, manifests, logs or package files.
- Installation/update/uninstall and all MCP write actions are audit logged.
- Ability to disable a plugin immediately and revoke its capabilities for future dispatches.
- Security tests for malicious frontmatter, prompt injection, path traversal, symlink escape, malicious archives, SSRF, credential leakage, manifest spoofing, publisher ID collisions and revoked-package behaviour.

A trusted badge is a provenance statement, not permission to bypass tool approvals or platform policy.

## 7. UX: one Extensions hub, clear capability boundaries

The frontend should evolve from a single MCP Store into an Extensions area with these sections:

- Discover: search/filter the LampCode Catalog by capability, stack, category, publisher, compatibility and trust status.
- Installed: enabled/disabled packages, versions, update availability, source, trust and permissions.
- Skills: standalone skills and skills bundled by plugins.
- Agents: installed specialist agents and their allowed task profiles.
- Commands: installed slash/action commands with input schema and confirmation behaviour.
- Integrations: existing MCP Store, connected services, custom MCP servers and diagnostics.

Essential interactions:

- Install, enable, disable, update, uninstall.
- Import from GitHub, archive or standalone skill.
- Inspect README, manifest, files, publisher, license, source revision and trust status before install.
- Review permissions and choose user/project scope.
- Preview exactly what capabilities become available after enabling.
- Explain unsupported package elements rather than silently dropping them.
- Show runtime use: which extension the build loaded and why.
- Make disconnecting an MCP integration independent from uninstalling the plugin that declared its template.

Keep the existing /mcp route as a compatibility redirect or nested Integrations view during migration. Do not break existing saved connections.

## 8. Backend/frontend ownership

The repositories are separate deployments, so the API contract must lead the UI:

- Backend, thefani1122-source/Lampcode: package parser/validator, source adapters, plugin storage/lifecycle, capability resolver, permission grants, catalogue API, runtime loader and audit events.
- Frontend, thefani1122-source/vibe-coder-suite: Extensions hub, install/import flows, installed-package management, permission review, capability detail pages and MCP Store refactor.
- Database: user installations, immutable package versions/files or object-storage references, scope/project assignments, permission grants, catalog/publisher metadata and audit records.
- Agent runtime: one capability resolver that supplies compact metadata and lazy loaders; existing MCP dispatcher and approval guards remain the execution authority.

The frontend must not maintain a second provider or extension registry. Provider definitions and capability availability should be served by the backend.

## 9. Delivery sequence

### Phase 0 — Contract and compatibility

- Define and test the manifest schema and package ID/version rules.
- Define a common capability descriptor and lifecycle state model.
- Define API contracts for catalog, install, inspect, enable/disable, update, uninstall, project assignment and permission grants.
- Add compatibility tests for existing built-in skills, project skills and current MCP connections.
- Design the backend catalogue endpoint and remove the frontend's duplicated MCP provider metadata.
- No database migration or UI redesign until the contract is reviewed.

### Phase 1 — Full Skills library

- Standalone skill import (file/folder/GitHub path).
- User-level and project-level skill library.
- Installed/enabled/disabled management and provenance.
- Support SKILL.md, references and assets with lazy loading.
- Skill detail/preview, version pinning and update review.
- Runtime integration that loads only relevant enabled skill metadata/body.
- Keep scripts inert.

### Phase 2 — Plugin packages and marketplace

- Plugin manifest and immutable package snapshot storage.
- Curated catalog plus GitHub/private catalog source adapters.
- Install/inspect/enable/disable/update/uninstall lifecycle.
- Capability registry that lists skills, agents, commands and MCP declarations.
- Permission review and audit trail.
- Import compatibility for supported Claude Code-style plugin layouts.

### Phase 3 — Agents and commands

- Specialist agent package support with strict tool profiles and bounded orchestration.
- Typed commands and user-invoked workflows.
- Existing internal agent roles exposed as built-in capabilities where product UX warrants it.
- Evaluation suite measuring success rate, context overhead, latency, tool correctness and unwanted side effects.

### Phase 4 — MCP as a first-class plugin capability

- Backend provider catalogue as the source of truth.
- Existing connections rendered inside Extensions → Integrations.
- Plugin-declared MCP server templates with separate user connection/auth.
- Per-project selection and diagnostics.
- Unified capability budget and explicit reporting of omitted tools.

### Phase 5 — Sandboxed hooks/scripts

- Separate isolated runner, not backend execution.
- Capability grants, deterministic limits, audit logs, kill switch and adversarial testing.
- Only then consider lifecycle hooks and executable plugin assets.

## 10. Acceptance criteria

The ecosystem is not complete until all of the following are true:

1. A user can discover, inspect, install, enable, disable, update and uninstall a standalone skill and a multi-capability plugin.
2. An installed skill can be enabled globally or for a selected project, with clear precedence and reproducible version/hash.
3. Skill bodies and references are loaded on demand; unrelated extension content does not inflate every model request.
4. A plugin can bundle at least skills, agent definitions, commands and MCP server templates without requiring all of them to be enabled.
5. A plugin-declared MCP server still requires the user to connect credentials; writes still require approval.
6. Frontend catalogue data comes from one backend registry; no duplicated provider definitions.
7. Untrusted plugins cannot execute scripts, bypass security prompts, access secrets, escape package roots or fetch private network addresses.
8. Disabling/uninstalling a plugin removes its capabilities from future builds without corrupting existing projects or historical build evidence.
9. Updates are explicit, immutable and reversible to a prior installed version.
10. Every load, install, update, permission grant/revocation and external write has enough audit information to explain what happened.
11. Existing built-in skills, .agents/skills, .claude/skills, current MCP connections and current builds remain backward compatible.
12. Automated tests cover security boundaries, API lifecycle, project scope, runtime selection, token/tool budgets and failure isolation.

## 11. Explicit non-goals for the first release

- Do not replace the existing MCP SDK, OAuth implementation or approval guard.
- Do not load all extension content into every system prompt.
- Do not execute arbitrary plugin JavaScript, shell scripts or lifecycle hooks in the backend.
- Do not auto-connect users' accounts or copy credentials from a plugin.
- Do not grant tools/network/filesystem permissions based only on package instructions.
- Do not require users to place every skill inside a plugin package.
- Do not promise complete compatibility with Claude Code hooks or runtime-specific behaviour when only its package files are being imported.
- Do not create a second agent orchestration engine alongside LampCode's existing dispatcher.

## 12. Source references

- Agent Skills open format and folder-based skill convention: https://github.com/agentskills/agentskills
- Anthropic Claude Code plugin packaging and marketplace concepts: https://docs.anthropic.com/en/docs/claude-code/plugins
- Anthropic example plugin repository and manifest layout: https://github.com/anthropics/claude-plugins-official
- OpenAI Agent Plugins architecture and skill format: https://developers.openai.com/api/docs/guides/agent-plugins

---

**Implementation note:** this file is an architecture contract only. It does not claim that the described marketplace, plugin lifecycle, user skill library, agent/command installer or sandboxed extension runner already exists.