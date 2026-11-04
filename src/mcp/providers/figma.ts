import { z } from "zod";
import { fetchJson, type ProviderDef } from "./_shared.js";

// ── Figma (REST API + personal access token) ─────────────────────────────────
// mcp.figma.com only authorizes clients in Figma's MCP catalog, so the hosted
// MCP server is unreachable for Lampcode. The REST API with a personal access
// token is the documented, working path: the connect route verifies the token
// against /v1/me before anything is stored.

export const figmaSchema = z.object({
  figma_pat: z.string().min(1, "Figma personal access token is required"),
});
export type FigmaParams = z.infer<typeof figmaSchema>;

const FIGMA_API = "https://api.figma.com/v1";

export async function figmaMe(p: FigmaParams): Promise<unknown> {
  return fetchJson(`${FIGMA_API}/me`, { headers: { "X-Figma-Token": p.figma_pat } });
}

export async function figmaFile(p: FigmaParams, fileKey: string): Promise<unknown> {
  return fetchJson(`${FIGMA_API}/files/${encodeURIComponent(fileKey)}?depth=2`, {
    headers: { "X-Figma-Token": p.figma_pat },
  });
}

export async function figmaTeamProjects(p: FigmaParams, teamId: string): Promise<unknown> {
  return fetchJson(`${FIGMA_API}/teams/${encodeURIComponent(teamId)}/projects`, {
    headers: { "X-Figma-Token": p.figma_pat },
  });
}

export async function figmaFileComponents(p: FigmaParams, fileKey: string): Promise<unknown> {
  return fetchJson(`${FIGMA_API}/files/${encodeURIComponent(fileKey)}/components`, {
    headers: { "X-Figma-Token": p.figma_pat },
  });
}

export async function figmaImageUrls(p: FigmaParams, fileKey: string, nodeIds: string): Promise<unknown> {
  return fetchJson(`${FIGMA_API}/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeIds)}`, {
    headers: { "X-Figma-Token": p.figma_pat },
  });
}

export const figma: ProviderDef = {
  id: "figma",
  name: "Figma",
  category: "Design",
  emoji: "🎨",
  description: "Read Figma files, components, and design tokens via the Figma REST API.",
  schema: figmaSchema,
  fields: [
    {
      key: "figma_pat",
      label: "Figma Personal Access Token",
      type: "password",
      placeholder: "figd_...",
      help: "Figma → Settings → Account → Personal access tokens (needs File content read)",
    },
  ],
  testConnection: async (params) => {
    try {
      await figmaMe(params as FigmaParams);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  keywords: /\bfigma\b/i,
  promptRule:
    "The user has connected Figma with a personal access token. To pull design details, call the figma_query tool (actions: get_me, list_team_projects with team_id, get_file with file_key, list_file_components with file_key, get_image_urls with file_key and node_ids) — do NOT invent file keys; ask the user or a teammate for the Figma URL (the file key is the part after /design/ or /file/ in the URL). Never embed the token in code.",
};

export default figma;
