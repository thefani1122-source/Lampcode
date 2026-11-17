/**
 * Progressive Tool Disclosure
 *
 * Filters available tools dynamically based on classified task category.
 * Enforces strict read-only tool sets for query and research modes,
 * while preserving write approval gates and execution capabilities for build modes.
 */

import type { ToolDefinition } from "./model-gateway.js";
import type { TaskCategory } from "../context/orchestrator.js";

/** Explicit allowlist of tools safe for query / research turns */
export const QUERY_MODE_READONLY_TOOL_NAMES = new Set([
  "read_file",
  "read_project_file",
  "list_files",
  "search_code",
  "review_code",
  "code_intel",
  "impact_analysis",
  "fetch_reference",
  "read_logs",
  "web_search",
  "look_at_page",
  "integrations_status",
  "search_engineering_decisions",
  "get_engineering_decision",
  "get_symbol_history",
  "github_query",
  "vercel_query",
  "shopify_query",
  "wordpress_query",
  "twilio_query",
  "sendgrid_query",
  "mailchimp_query",
  "netlify_query",
  "supabase_query",
  "list_skills",
  "load_skill",
  "list_plugins",
  "load_plugin_capability",
  // This control signal activates the build workflow but performs no write.
  // Actual file/service mutations remain absent from queryMode and are only
  // exposed after the main model explicitly requests a workspace handoff.
  "request_project_build",
]);

export class ToolDisclosure {
  /**
   * Filter tool definitions progressively according to the task type.
   */
  static filterForTask(
    tools: ToolDefinition[],
    category: TaskCategory,
    trustedReadOnlyToolNames: Iterable<string> = [],
  ): ToolDefinition[] {
    if (category === "code_review_query") {
      // Dynamic MCP definitions are accepted only when the MCP classifier has
      // already put them in the dedicated read-only registry. Never infer
      // safety from a tool name or a model-provided annotation here.
      const allowed = new Set(QUERY_MODE_READONLY_TOOL_NAMES);
      for (const name of trustedReadOnlyToolNames) allowed.add(name);
      return tools.filter((tool) => allowed.has(tool.name));
    }

    // For all build tasks, retain write and audit tools
    // but ensure dangerous tools are kept gated
    return tools;
  }
}
