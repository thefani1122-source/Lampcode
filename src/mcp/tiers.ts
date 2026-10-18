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
