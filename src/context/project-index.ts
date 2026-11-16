/**
 * Task-Aware Project File Indexer
 *
 * Selects the most relevant subset of project files for the classified task,
 * respecting token budgets while guaranteeing that the full project remains
 * safely preserved in storage and accessible to tool execution.
 */

import type { TaskCategory } from "./orchestrator.js";

const CHARS_PER_TOKEN = 4;

export interface FileRelevanceScore {
  path: string;
  score: number;
  tokens: number;
  reason: string;
}

export interface SelectionResult {
  selectedFiles: Record<string, string>;
  totalTokens: number;
  selectedPaths: string[];
  omittedPaths: string[];
}

export class ProjectIndex {
  /**
   * Score and select relevant files for the current task.
   * Selection only determines prompt context; it NEVER removes files from the project.
   */
  static selectFilesForTask(
    files: Record<string, string>,
    category: TaskCategory,
    userPrompt: string,
    tokenBudget: number = 20_000,
  ): SelectionResult {
    const scored: FileRelevanceScore[] = [];
    const lowerPrompt = userPrompt.toLowerCase();

    for (const [path, content] of Object.entries(files)) {
      const lowerPath = path.toLowerCase();
      const tokens = Math.ceil(content.length / CHARS_PER_TOKEN);
      let score = 0;
      let reason = "baseline";

      // Pinned project contracts always get high priority
      if (path === "CONTRACT.md" || path === "CURRENT_STATE.md" || path === "package.json") {
        score += 80;
        reason = "pinned_contract";
      }

      // Exact path mentioned in user prompt
      const filename = path.split("/").pop()?.toLowerCase() ?? "";
      if (lowerPrompt.includes(filename) && filename.length > 2) {
        score += 100;
        reason = "explicitly_mentioned";
      }

      // Category-based weighting
      switch (category) {
        case "ui_edit":
          if (
            lowerPath.includes("component") ||
            lowerPath.includes("ui") ||
            lowerPath.endsWith(".css") ||
            lowerPath.includes("theme") ||
            lowerPath.includes("style") ||
            lowerPath.includes("page") ||
            lowerPath.endsWith(".tsx") ||
            lowerPath.endsWith(".jsx")
          ) {
            score += 50;
            reason = "ui_component_or_style";
          }
          // De-prioritize server/database files for pure UI tasks
          if (lowerPath.includes("server") || lowerPath.includes("db") || lowerPath.includes("migration")) {
            score -= 30;
          }
          break;

        case "backend_change":
          if (
            lowerPath.includes("route") ||
            lowerPath.includes("api") ||
            lowerPath.includes("server") ||
            lowerPath.includes("db") ||
            lowerPath.includes("schema") ||
            lowerPath.includes("auth") ||
            lowerPath.includes("client") ||
            lowerPath.endsWith(".sql")
          ) {
            score += 60;
            reason = "backend_route_or_schema";
          }
          break;

        case "bug_repair":
          // Prioritize files whose names or keywords appear in the prompt/error
          const baseName = filename.split(".")[0];
          if (baseName && lowerPrompt.includes(baseName)) {
            score += 70;
            reason = "potential_error_site";
          }
          // Prioritize tests and main entry points
          if (lowerPath.includes("test") || lowerPath.includes("app.tsx") || lowerPath.includes("index.ts")) {
            score += 30;
          }
          break;

        case "code_review_query":
        case "feature_addition":
        default:
          if (lowerPath.includes("src/app.tsx") || lowerPath.includes("src/index.ts") || lowerPath.includes("src/main.tsx")) {
            score += 40;
            reason = "core_entry_point";
          }
          break;
      }

      scored.push({ path, score, tokens, reason });
    }

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    const selectedFiles: Record<string, string> = {};
    const selectedPaths: string[] = [];
    const omittedPaths: string[] = [];
    let accumulatedTokens = 0;

    for (const item of scored) {
      const fileContent = files[item.path];
      if (fileContent !== undefined && (accumulatedTokens + item.tokens <= tokenBudget || selectedPaths.length < 2)) {
        selectedFiles[item.path] = fileContent;
        selectedPaths.push(item.path);
        accumulatedTokens += item.tokens;
      } else {
        omittedPaths.push(item.path);
      }
    }

    return {
      selectedFiles,
      totalTokens: accumulatedTokens,
      selectedPaths,
      omittedPaths,
    };
  }
}
