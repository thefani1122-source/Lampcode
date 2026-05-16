// ── Provider identity ─────────────────────────────────────────────────────────

export type McpProvider = "vercel" | "supabase" | "github" | "railway";
export type ConnectionTier = 1 | 2 | 3;

// ── Credentials ───────────────────────────────────────────────────────────────

export interface IntegrationCredentials {
  token?: string | undefined;
  apiKey?: string | undefined;
  teamId?: string | undefined;      // Vercel team ID
  orgId?: string | undefined;       // GitHub org / Railway workspace
  projectRef?: string | undefined;  // Supabase project reference ID
  serviceId?: string | undefined;   // Railway service ID
  repoOwner?: string | undefined;   // GitHub repo owner (user or org name)
}

// ── Connection result ─────────────────────────────────────────────────────────

export interface ConnectionResult {
  ok: boolean;
  tier: ConnectionTier;
  provider: McpProvider;
  latencyMs: number;
  detail?: string | undefined;
}

// ── Tool call result ──────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  tier: ConnectionTier;
  data: Record<string, unknown>;
  cliCommands?: string[] | undefined;  // populated when tier === 3
  error?: string | undefined;
}

// ── Smoke tests ───────────────────────────────────────────────────────────────

export interface SmokeCheck {
  name: string;
  passed: boolean;
  statusCode?: number | undefined;
  latencyMs: number;
  detail?: string | undefined;
}

export interface SmokeResult {
  url: string;
  ok: boolean;
  checks: SmokeCheck[];
  totalLatencyMs: number;
}

// ── Deploy result ─────────────────────────────────────────────────────────────

export type DeployStatus = "deployed" | "failed" | "manual_required" | "rolled_back";

export interface DeployStep {
  name: string;
  tier: ConnectionTier;
  success: boolean;
  data?: Record<string, unknown> | undefined;
  cliCommands?: string[] | undefined;
  error?: string | undefined;
}

export interface DeployResult {
  sessionId: string;
  projectId: string;
  status: DeployStatus;
  previewUrl?: string | undefined;
  steps: DeployStep[];
  smokeTests?: SmokeResult | undefined;
  manualSteps?: string[] | undefined;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface IProvider {
  readonly name: McpProvider;
  testConnection(
    creds: IntegrationCredentials,
  ): Promise<{ ok: boolean; latencyMs: number; detail?: string | undefined }>;
  executeTool(
    toolName: string,
    args: Record<string, unknown>,
    creds: IntegrationCredentials,
  ): Promise<Record<string, unknown>>;
  cliCommands(toolName: string, args: Record<string, unknown>): string[];
}

// ── Errors ────────────────────────────────────────────────────────────────────

export type McpErrorType =
  | "AUTH_FAILED"
  | "NETWORK_ERROR"
  | "RATE_LIMIT"
  | "NOT_FOUND"
  | "PROVIDER_ERROR"
  | "TOOL_NOT_FOUND";

/** Errors that warrant trying the next tier. */
export const TIER_FALLBACK_ERRORS = new Set<McpErrorType>([
  "AUTH_FAILED",
  "NETWORK_ERROR",
  "RATE_LIMIT",
]);

export class McpError extends Error {
  constructor(
    public readonly type: McpErrorType,
    message: string,
    public readonly statusCode?: number | undefined,
  ) {
    super(message);
    this.name = "McpError";
  }
}
