import { loadSkillHandler } from "./load-skill.js";
import { readProjectFileHandler } from "./read-project-file.js";
import { requestWriteActionHandler } from "./request-write-action.js";
import { checkpointHandler } from "./checkpoint.js";
import { revertHandler } from "./revert.js";
import { diffSinceHandler } from "./diff-since.js";
import { askUserHandler } from "./ask-user.js";
import { writeFilesHandler } from "./write-files.js";
import { deleteFileHandler } from "./delete-file.js";
import { editFileHandler } from "./edit-file.js";
import { findDeadCodeHandler } from "./find-dead-code.js";
import { findWiringGapsHandler } from "./find-wiring-gaps.js";
import { deployAppHandler } from "./deploy-app.js";
import { reviewCodeHandler } from "./review-code.js";
import { checkPageHandler } from "./check-page.js";
import { checkTypesHandler } from "./check-types.js";
import { runTestsHandler } from "./run-tests.js";
import { listFilesHandler } from "./list-files.js";
import { searchCodeHandler } from "./search-code.js";
import { codeIntelHandler } from "./code-intel.js";
import { impactAnalysisHandler } from "./impact-analysis.js";
import { readFileHandler } from "./read-file.js";
import { fetchReferenceHandler } from "./fetch-reference.js";
import { readLogsHandler } from "./read-logs.js";
import { webSearchHandler } from "./web-search.js";
import { lookAtPageHandler } from "./look-at-page.js";
import { shellHandler } from "./shell.js";

import type { ToolExecutionContext } from "../tools.js";

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
) => Promise<string> | string;

/**
 * Runtime MCP tools are intentionally dispatched outside this static map:
 * executeTool owns the approved write-proxy and read-only MCP paths.
 */
export const DEFERRED_STATIC_HANDLERS = new Set(["ask_user"]);

export const REGISTRY: Map<string, ToolHandler> = new Map([
  ["load_skill", loadSkillHandler],
  ["read_project_file", readProjectFileHandler],
  ["request_write_action", requestWriteActionHandler],
  ["checkpoint", checkpointHandler],
  ["revert", revertHandler],
  ["diff_since", diffSinceHandler],
  ["ask_user", askUserHandler],
  ["write_files", writeFilesHandler],
  ["delete_file", deleteFileHandler],
  ["edit_file", editFileHandler],
  ["find_dead_code", findDeadCodeHandler],
  ["find_wiring_gaps", findWiringGapsHandler],
  ["deploy_app", deployAppHandler],
  ["review_code", reviewCodeHandler],
  ["check_page", checkPageHandler],
  ["check_types", checkTypesHandler],
  ["run_tests", runTestsHandler],
  ["list_files", listFilesHandler],
  ["search_code", searchCodeHandler],
  ["code_intel", codeIntelHandler],
  ["impact_analysis", impactAnalysisHandler],
  ["read_file", readFileHandler],
  ["fetch_reference", fetchReferenceHandler],
  ["read_logs", readLogsHandler],
  ["web_search", webSearchHandler],
  ["look_at_page", lookAtPageHandler],
  ["shell", shellHandler],
]);

