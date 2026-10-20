/** User MCP servers must use the approval-gated dispatcher path. */
export function legacyMcpActionBlocked(serverCount: number): boolean {
  return serverCount > 0;
}

