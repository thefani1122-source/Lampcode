import type { Capability } from "./capabilities.js";

export type Tier = "read" | "sandbox" | "approval" | "strong-approval";

const DESTRUCTIVE_ACTION = /(?:^|[^a-z0-9])(?:delete|drop|destroy|rollback|force)(?:$|[^a-z0-9])/i;

export function tierFor(capability: Capability | null, toolName: string): Tier {
  // Missing metadata never proves a tool safe or sandbox-scoped.
  if (capability === null) return "approval";
  if (capability === "deploy.rollback" || DESTRUCTIVE_ACTION.test(toolName)) return "strong-approval";
  if (capability.endsWith(".read") || capability.endsWith(".query")) return "read";
  return "approval";
}

export function describeTier(tier: Tier): string {
  switch (tier) {
    case "read":
      return "Reads data without changing external state.";
    case "sandbox":
      return "Changes are limited to LampCode's isolated sandbox.";
    case "approval":
      return "May change external state and requires user approval.";
    case "strong-approval":
      return "May cause destructive effects that can be difficult or impossible to undo; require explicit user approval.";
  }
}

/**
 * Weakest to strongest. Integration code compares tiers rather than assuming
 * the one a single source produced is final.
 */
const TIER_RANK: Readonly<Record<Tier, number>> = {
  read: 0,
  sandbox: 1,
  approval: 2,
  "strong-approval": 3,
};

/**
 * The stricter of two tiers.
 *
 * This is the whole shape of the H2/H3 integration: capability metadata may
 * ESCALATE what the MCP classifier already decided and may never relax it. The
 * classifier reaches its verdict from evidence about the tool itself — the
 * server's own `readOnlyHint`, or a name that matches a read verb — while
 * `tierFor` reasons from a capability map that covers a handful of tools. A
 * capability of `null` means "this map has never heard of it", which is a fact
 * about the map, not about the tool.
 *
 * So `tierFor(null)` stays fail-closed in its own contract (it answers
 * "approval", because nothing proved otherwise), and the integration takes the
 * strongest of the two verdicts. The result: a destructive-looking tool that
 * slipped past the classifier gets gated, and nothing that the classifier
 * independently established as read-only is quietly dropped from a build
 * because this map has not been filled in yet.
 */
/**
 * True when the tool's NAME alone says the call may be irreversible.
 *
 * Exported because `tierFor` cannot answer this on its own: it returns
 * "approval" the moment the capability is null, before it ever looks at the
 * name, so an unmapped `rollback_deployment` reads the same as an unmapped
 * `list_projects`. That short-circuit is right for its own contract — nothing
 * proved the tool safe — and wrong as the last word, because "needs approval"
 * and "may not be undoable" are different things to put in front of a person.
 *
 * Kept separate rather than folded into `tierFor` so that function's contract,
 * and the cases pinning it, stay exactly as they were.
 */
export function destructiveByName(toolName: string): boolean {
  return typeof toolName === "string" && DESTRUCTIVE_ACTION.test(toolName);
}

export function strongestTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/** True when the tier requires the user to answer before the tool may run. */
export function needsApproval(tier: Tier): boolean {
  return tier === "approval" || tier === "strong-approval";
}
