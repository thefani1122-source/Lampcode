import { describeTier, tierFor } from "../src/mcp/tiers.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL ${name}`);
  console.log(`ok ${name}`);
}

check("repo.read is read tier", tierFor("repo.read", "get_file_contents") === "read");
check("db.query is read tier", tierFor("db.query", "execute_read_query") === "read");
check("ordinary external write needs approval", tierFor("issue.write", "create_issue") === "approval");
check("null metadata always needs approval", tierFor(null, "get_status") === "approval");
check("delete_branch escalates", tierFor("repo.write", "delete_branch") === "strong-approval");
check("get_deleted_items does not substring-escalate", tierFor("repo.read", "get_deleted_items") === "read");
check("deploy.rollback escalates", tierFor("deploy.rollback", "rollback_deployment") === "strong-approval");
check("sandbox description remains available", describeTier("sandbox").toLowerCase().includes("isolated sandbox"));
check("strong approval explains hard-to-undo effects", /difficult or impossible to undo/i.test(describeTier("strong-approval")));

console.log(`\n${checks} tier checks passed`);
