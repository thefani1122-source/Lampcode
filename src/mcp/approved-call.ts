import { callMcpTool } from "./call-tool.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { WriteMcpMeta } from "../agents/mcp-tool-classifier.js";

/** Shared post-approval execution point for MCP writes. Denial never opens a connection. */
export async function callApprovedMcpTool(
  meta: WriteMcpMeta,
  args: Record<string, unknown>,
  approved: boolean,
  fetchImpl?: FetchLike,
): Promise<string> {
  if (!approved) return "Action denied: the write action was not approved by the user.";
  return callMcpTool(meta, args, "lampcode-write-proxy", fetchImpl);
}

