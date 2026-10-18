export type Capability =
  | "repo.read"
  | "repo.write"
  | "issue.read"
  | "issue.write"
  | "deploy.create"
  | "deploy.read"
  | "deploy.rollback"
  | "db.query"
  | "db.write"
  | "message.send"
  | "file.read"
  | "file.write";

/**
 * Only tool semantics with a clear capability meaning belong here. Empty
 * server entries are intentional: knowing a server does not imply that its
 * tools have a safe or unambiguous capability classification.
 */
export const TOOL_CAPABILITIES: Readonly<Record<string, Readonly<Record<string, Capability>>>> = {
  github: {
    create_issue: "issue.write",
    get_file_contents: "repo.read",
  },
  vercel: {
    create_deployment: "deploy.create",
  },
  railway: {},
  supabase: {},
  n8n: {},
  wordpress: {},
  shopify: {},
  zapier: {},
  make: {},
  figma: {},
  linear: {},
  sentry: {},
  cloudflare: {},
  netlify: {},
};

export function mapTool(serverSlug: string, toolName: string): Capability | null {
  if (typeof serverSlug !== "string" || typeof toolName !== "string") return null;
  const server = TOOL_CAPABILITIES[serverSlug];
  if (!server) return null;
  return server[toolName.toLowerCase()] ?? null;
}

export function mapTools(
  serverSlug: string,
  toolNames: string[],
): Array<{ toolName: string; capability: Capability | null }> {
  return toolNames.map((toolName) => ({ toolName, capability: mapTool(serverSlug, toolName) }));
}
