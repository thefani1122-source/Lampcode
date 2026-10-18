import { mapTool, mapTools } from "../src/mcp/capabilities.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL ${name}`);
  console.log(`ok ${name}`);
}

check("github create_issue maps to issue.write", mapTool("github", "create_issue") === "issue.write");
check("github get_file_contents maps to repo.read", mapTool("github", "get_file_contents") === "repo.read");
check("vercel create_deployment maps to deploy.create", mapTool("vercel", "create_deployment") === "deploy.create");
check("known server unknown tool is null", mapTool("github", "invented_tool") === null);
check("unknown server is null", mapTool("not-a-server", "create_issue") === null);
check("tool names match case-insensitively", mapTool("github", "CREATE_ISSUE") === "issue.write");
const mapped = mapTools("github", ["create_issue", "missing", "get_file_contents"]);
check("mapTools preserves order and null entries", mapped.map((x) => x.toolName).join(",") === "create_issue,missing,get_file_contents" && mapped.map((x) => x.capability).join(",") === "issue.write,,repo.read");
check("Supabase metadata remains unmapped", mapTool("supabase", "list_tables") === null && mapTool("supabase", "get_project_url") === null);

console.log(`\n${checks} capability checks passed`);
