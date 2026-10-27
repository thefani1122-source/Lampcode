import { mcpTransportOrder } from "../src/mcp/client.js";

let checks = 0;
function check(label: string, got: unknown, expected: unknown): void {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`FAIL ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
  console.log(`ok ${label}`);
}

check("explicit SSE endpoint prefers SSE", mcpTransportOrder("https://mcp.example.com/sse"), ["sse", "streamable-http"]);
check("SSE endpoint with trailing slash is recognized", mcpTransportOrder("https://mcp.example.com/sse/"), ["sse", "streamable-http"]);
check("SSE endpoint with query parameters is recognized", mcpTransportOrder("https://mcp.example.com/sse?session=abc"), ["sse", "streamable-http"]);
check("Streamable HTTP endpoint falls back to SSE", mcpTransportOrder("https://mcp.example.com/mcp"), ["streamable-http", "sse"]);
check("similar but non-SSE paths use Streamable HTTP first", mcpTransportOrder("https://mcp.example.com/sse-events"), ["streamable-http", "sse"]);

console.log(`${checks} MCP transport selection checks passed`);
