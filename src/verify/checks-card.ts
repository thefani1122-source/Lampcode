/**
 * The build's own verdict on itself, in the user's words.
 *
 * Everything here was already being measured — `build_outcome`, `wiring.ts`
 * and the completion audit have produced it for weeks. CLAUDE.md records the
 * gap this closes: "None of this is visible to a user today." The audit card
 * was pulled from the UI because it was written for a maintainer, so this
 * module is only a translation layer, and it adds no new measurement.
 *
 * Two rules it must not break:
 *
 *  1. A gate that did not run is `skip`, never `pass`. "unverified is NOT a
 *     soft pass" is the whole reason the audit exists, and a card that rounded
 *     a missing check up to a tick would be the exact lie the audit was built
 *     to catch.
 *  2. A row is omitted when the question does not apply. A frontend-only app
 *     has no database, and showing it a greyed-out database line invites the
 *     user to think something broke.
 */

import type { AcceptanceCriterion, CriterionVerdict } from "../db/schema.js";

type Gate = "pass" | "fail" | "unavailable" | "never" | "none";

export interface CheckRow {
  id: string;
  /** The claim, in the user's terms — never a gate or tool name. */
  label: string;
  status: "pass" | "fail" | "warn" | "skip";
  /** Evidence in a few words. Absent when there is nothing honest to add. */
  detail?: string;
}

export interface ChecksCard {
  rows: CheckRow[];
  /** What the user asked for that the build could not show it had done. */
  missing: Array<{ text: string; note: string }>;
  /** What the build found wrong with its own work and fixed before showing it. */
  repairs: string[];
}

export interface ChecksInput {
  checkPage: Gate;
  checkTypes: Gate;
  checkTests: Gate;
  wiring?: {
    deadHandlers: number;
    bareButtons: number;
    formsNoSubmit: number;
    deadLinks: number;
    missingEndpoints: number;
  };
  wiringRepaired?: number;
  schemaApply?: { ran: boolean; ok: boolean; error?: string } | null;
  audit?: { criteria: AcceptanceCriterion[]; verdicts: CriterionVerdict[] } | null;
  auditRepaired?: number;
}

function gateRow(id: string, label: string, gate: Gate, passDetail: string, failDetail: string): CheckRow {
  if (gate === "pass") return { id, label, status: "pass", detail: passDetail };
  if (gate === "fail") return { id, label, status: "fail", detail: failDetail };
  // "unavailable" means the check could not run; "never"/"none" mean it was
  // not run at all. The user does not need that distinction — only the fact
  // that nobody has confirmed this.
  return { id, label, status: "skip", detail: "not checked" };
}

export function buildChecksCard(input: ChecksInput): ChecksCard {
  const rows: CheckRow[] = [
    gateRow("opens", "The app opens", input.checkPage, "no errors when it loads", "it errors when it loads"),
    gateRow("compiles", "The code compiles", input.checkTypes, "no type errors", "there are type errors"),
  ];

  // Tests only earn a line when there are some. "No tests" is not a finding
  // worth a row on a build nobody asked to test.
  if (input.checkTests !== "none" && input.checkTests !== "never") {
    rows.push(
      gateRow("tests", "The tests pass", input.checkTests, "all green", "some tests fail"),
    );
  }

  // The five kinds that mean a control renders but does nothing. The other two
  // wiring findings — orphan endpoints and placeholder text — are deliberately
  // left out: their fix is a product decision, not a defect, and counting them
  // here would mark a sound build as broken.
  const w = input.wiring;
  if (w) {
    const hollow =
      w.deadHandlers + w.bareButtons + w.formsNoSubmit + w.deadLinks + w.missingEndpoints;
    rows.push(
      hollow === 0
        ? { id: "controls", label: "Every button and form does something", status: "pass", detail: "all wired up" }
        : {
            id: "controls",
            label: "Every button and form does something",
            status: "warn",
            detail: `${hollow} ${hollow === 1 ? "control does" : "controls do"} nothing yet`,
          },
    );
  }

  const schema = input.schemaApply;
  if (schema) {
    if (schema.ok) {
      rows.push({ id: "data", label: "Your data really saves", status: "pass", detail: "tables created in your Supabase" });
    } else if (!schema.ran && schema.error === "no Supabase connected") {
      rows.push({ id: "data", label: "Your data really saves", status: "skip", detail: "no database connected yet" });
    } else {
      rows.push({
        id: "data",
        label: "Your data really saves",
        status: "fail",
        detail: "the tables could not be created",
      });
    }
  }

  const missing = (input.audit?.verdicts ?? [])
    .filter((v) => v.status !== "proven")
    .map((v) => {
      const criterion = input.audit?.criteria.find((c) => c.id === v.id);
      return { text: criterion?.text ?? v.id, note: v.note };
    })
    .filter((m) => m.text.trim().length > 0)
    .slice(0, 8);

  const repairs: string[] = [];
  const repaired = input.wiringRepaired ?? 0;
  if (repaired > 0) {
    repairs.push(
      `Found ${repaired} ${repaired === 1 ? "control that did" : "controls that did"} nothing, and fixed ${repaired === 1 ? "it" : "them"}`,
    );
  }
  const auditRepaired = input.auditRepaired ?? 0;
  if (auditRepaired > 0) {
    repairs.push(
      `Noticed ${auditRepaired} ${auditRepaired === 1 ? "thing" : "things"} you asked for that ${auditRepaired === 1 ? "was" : "were"} missing, and built ${auditRepaired === 1 ? "it" : "them"}`,
    );
  }

  return { rows, missing, repairs };
}
