import { createHash } from "node:crypto";
import { parseUserSkillPackage } from "./user-skills.js";

export const USER_PLUGIN_MAX_MANIFEST_BYTES = 32 * 1024;
export const USER_PLUGIN_MAX_FILES = 100;
export const USER_PLUGIN_MAX_FILE_BYTES = 64 * 1024;
export const USER_PLUGIN_MAX_TOTAL_BYTES = 1024 * 1024;
export const USER_PLUGIN_MAX_HISTORY = 3;
export type PluginCapabilityKind = "skill" | "agent" | "command" | "mcp";
export interface PluginCapabilityDescriptor {
  kind: PluginCapabilityKind;
  id: string;
  name: string;
  description: string;
  path: string;
  /** Relative references/ paths for skills; contents are loaded only on demand. */
  resourcePaths?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Accept either the displayed plugin:<uuid> identifier or its raw database id. */
export function normalizeUserPluginRecordId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.startsWith("plugin:") ? value.slice("plugin:".length) : value;
  return UUID_RE.test(id) ? id : null;
}

/** Resolve a safe references file path to its package-relative storage path. */
export function resolvePluginSkillResourcePath(skillEntryPath: string, resourcePath: string): string | null {
  if (
    typeof skillEntryPath !== "string" ||
    !/^skills\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*SKILL\.md$/.test(skillEntryPath) ||
    typeof resourcePath !== "string" ||
    resourcePath.length > 240 ||
    !/^references\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(resourcePath)
  ) return null;
  const directory = skillEntryPath.slice(0, -"/SKILL.md".length);
  return directory + "/" + resourcePath;
}
export interface ParsedUserPlugin {
  pluginId: string; name: string; description: string; version: string; publisher: string; license: string;
  manifest: Record<string, unknown>; files: Record<string, string>;
  capabilities: PluginCapabilityDescriptor[]; contentHash: string;
}

function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !path.startsWith("/") && !path.includes("\\") &&
    path.split("/").every((part) => part && part !== "." && part !== ".." && /^[A-Za-z0-9._-]{1,100}$/.test(part));
}
function supportedPath(path: string): boolean {
  return path === "plugin.json" || path === ".claude-plugin/plugin.json" ||
    path === "README.md" || path === "LICENSE" || path === "LICENSE.md" ||
    path === ".mcp.json" || path === "mcp/servers.json" ||
    /^skills\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*SKILL\.md$/.test(path) ||
    /^skills\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*references\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(path) ||
    /^agents\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(path) ||
    /^commands\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(path);
}
function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function validVersion(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(value);
}
function firstDescription(content: string, fallback: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\s*/, "").trim();
  return (body.split(/\n\s*\n/)[0]?.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim() || fallback).slice(0, 280);
}
function buildSkillCapability(path: string, files: Record<string, string>): PluginCapabilityDescriptor {
  const content = files[path];
  if (typeof content !== "string") throw new Error("Missing skill entry point: " + path);
  const dir = path === "skills/SKILL.md" ? "skills" : path.slice(0, -"/SKILL.md".length);
  const prefix = dir + "/references/";
  const refs: Record<string, string> = {};
  for (const [filePath, body] of Object.entries(files)) {
    if (filePath.startsWith(prefix)) refs["references/" + filePath.slice(prefix.length)] = body;
  }
  const parsed = parseUserSkillPackage(content, refs);
  return { kind: "skill", id: path, name: parsed.name, description: parsed.description, path, resourcePaths: Object.keys(parsed.resources) };
}

export function parseUserPluginPackage(rawManifest: string, inputFiles: Record<string, string>, owner: string, repo: string): ParsedUserPlugin {
  if (typeof rawManifest !== "string" || Buffer.byteLength(rawManifest, "utf8") > USER_PLUGIN_MAX_MANIFEST_BYTES) {
    throw new Error("Plugin manifest must be 32 KiB or smaller.");
  }
  let value: unknown;
  try { value = JSON.parse(rawManifest); } catch { throw new Error("Plugin manifest must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin manifest must be a JSON object.");
  const raw = value as Record<string, unknown>;
  const name = clean(raw["name"], 64);
  const description = clean(raw["description"], 1024);
  const version = clean(raw["version"], 64) || "1.0.0";
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) throw new Error("Plugin manifest requires a valid name.");
  if (!validVersion(version)) throw new Error("Plugin version must use semantic version format, for example 1.0.0.");
  const author = raw["publisher"] ?? raw["author"];
  const publisher = typeof author === "string" ? clean(author, 128)
    : author && typeof author === "object" && !Array.isArray(author) ? clean((author as Record<string, unknown>)["name"], 128) : owner;
  const license = clean(raw["license"], 64) || "Not specified";
  const explicitId = clean(raw["id"], 128);
  const pluginId = explicitId || owner.toLowerCase() + "." + name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(pluginId)) throw new Error("Plugin id must use lowercase letters, numbers, dots, underscores or hyphens.");

  const entries = Object.entries(inputFiles);
  if (entries.length > USER_PLUGIN_MAX_FILES) throw new Error("A plugin can include at most " + USER_PLUGIN_MAX_FILES + " supported files.");
  const files: Record<string, string> = {};
  let total = 0;
  for (const [path, content] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!safePath(path) || !supportedPath(path)) throw new Error("Unsupported plugin file path: " + path + ". Scripts, hooks, binaries and arbitrary assets are not supported.");
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > USER_PLUGIN_MAX_FILE_BYTES) throw new Error("Plugin file exceeds the 64 KiB limit: " + path);
    if (content.includes("\0") || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) throw new Error("Plugin file contains unsupported control characters: " + path);
    total += Buffer.byteLength(content, "utf8");
    if (total > USER_PLUGIN_MAX_TOTAL_BYTES) throw new Error("Plugin package exceeds the 1 MiB combined file limit.");
    files[path] = content;
  }
  const manifestPath = files[".claude-plugin/plugin.json"] !== undefined ? ".claude-plugin/plugin.json" : "plugin.json";
  if (files[manifestPath] !== rawManifest) throw new Error("The package must include its original plugin manifest file.");

  const skills = Object.keys(files).filter((p) => p === "skills/SKILL.md" || (p.startsWith("skills/") && p.endsWith("/SKILL.md"))).sort();
  const agents = Object.keys(files).filter((p) => p.startsWith("agents/") && p.endsWith(".md")).sort();
  const commands = Object.keys(files).filter((p) => p.startsWith("commands/") && p.endsWith(".md")).sort();
  const mcpFiles = [".mcp.json", "mcp/servers.json"].filter((p) => files[p] !== undefined);
  const capabilities: PluginCapabilityDescriptor[] = [];
  for (const path of skills) capabilities.push(buildSkillCapability(path, files));
  for (const path of agents) {
    const capName = path.slice(0, -3).split("/").at(-1) ?? "agent";
    capabilities.push({ kind: "agent", id: path, name: capName, description: firstDescription(files[path] ?? "", "Agent profile from " + path), path });
  }
  for (const path of commands) {
    const capName = path.slice("commands/".length, -3).replace(/\//g, " ");
    capabilities.push({ kind: "command", id: path, name: capName, description: firstDescription(files[path] ?? "", "Command workflow from " + path), path });
  }
  for (const path of mcpFiles) {
    let json: unknown;
    try { json = JSON.parse(files[path] ?? ""); } catch { throw new Error("MCP server template must be valid JSON: " + path); }
    const servers = json && typeof json === "object" ? (json as Record<string, unknown>)["mcpServers"] : undefined;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("MCP template must contain an mcpServers object: " + path);
    const serverEntries = Object.entries(servers as Record<string, unknown>);
    if (serverEntries.length > 20) {
      throw new Error("An MCP template can declare at most 20 server entries: " + path);
    }
    for (const [serverName, serverConfig] of serverEntries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(serverName)) {
        throw new Error("MCP server template contains an unsupported server name: " + serverName);
      }
      if (!serverConfig || typeof serverConfig !== "object" || Array.isArray(serverConfig)) {
        throw new Error("MCP server configuration must be a JSON object: " + serverName);
      }
      capabilities.push({
        kind: "mcp", id: path + "#" + serverName, name: serverName,
        description: "Inert MCP connection template; no credentials or connection are installed.", path,
      });
    }
  }
  if (!capabilities.length) throw new Error("No supported skills, agent profiles, command workflows or MCP templates were found.");
  const manifest = {
    schemaVersion: clean(raw["schemaVersion"], 16) || "claude-plugin-json",
    id: pluginId, name, description: description || ("Imported GitHub plugin " + name),
    version, publisher: publisher || owner, license,
    repository: "https://github.com/" + owner + "/" + repo,
    capabilities: {
      skills: capabilities.filter((c) => c.kind === "skill"),
      agents: capabilities.filter((c) => c.kind === "agent"),
      commands: capabilities.filter((c) => c.kind === "command"),
      mcpServers: capabilities.filter((c) => c.kind === "mcp"),
    },
  };
  const hash = createHash("sha256");
  hash.update(JSON.stringify(manifest));
  for (const [path, body] of Object.entries(files)) {
    hash.update("\0" + path + "\0" + Buffer.byteLength(body, "utf8") + "\0");
    hash.update(body);
  }
  return { pluginId, name, description: manifest.description, version, publisher: publisher || owner, license, manifest, files, capabilities, contentHash: hash.digest("hex") };
}
export function pluginCapabilityKind(value: unknown): PluginCapabilityKind | null {
  return value === "skill" || value === "agent" || value === "command" || value === "mcp" ? value : null;
}
