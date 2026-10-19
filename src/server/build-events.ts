import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { buildEvents } from "../db/schema.js";
import { logger } from "./logger.js";
import type { BuildEvent } from "../verify/outcome-projection.js";

/**
 * Records what a build did, in order, and keeps it (C1/C2).
 *
 * `projectOutcome()` can fold an ordered event stream into the persisted
 * outcome shape — it has been able to since 2026-10-18 — but nothing produced
 * the stream, so the outcome was still a mutable object patched as the build
 * went. That is how a gate verdict survives the write that invalidated it: the
 * object has one slot per gate and no memory of order.
 *
 * Two rules shape this class.
 *
 * DURABILITY IS INCREMENTAL. Buffering everything and writing once at the end
 * means a build that dies — a Railway redeploy mid-build, an OOM, a thrown
 * error past the catch — leaves no evidence at all, which is the case the
 * record exists for. So rows go out at phase boundaries and whenever the
 * buffer passes a small threshold, not only in `finally`.
 *
 * A FAILED WRITE NEVER FAILS A BUILD. This is evidence about a build, not part
 * of it. Every write is guarded; a failure is logged with the count that was
 * lost, because "the stream is short" and "the stream is complete" must not
 * look the same to whoever reads it later.
 */
export class BuildEventRecorder {
  private readonly all: BuildEvent[] = [];
  private pending: Array<{ seq: number; event: BuildEvent }> = [];
  private seq = 0;
  private lost = 0;
  /** Serialises flushes so two concurrent ones cannot interleave their rows. */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly sessionId: string) {}

  /** Append one event. Cheap and synchronous — the DB write happens on flush. */
  record(event: BuildEvent): void {
    this.seq += 1;
    this.all.push(event);
    this.pending.push({ seq: this.seq, event });
    // Small threshold rather than a timer: a build's event rate is bursty
    // (a round can emit a dozen in a second) and a timer would either write
    // constantly or not at all.
    if (this.pending.length >= 25) void this.flush();
  }

  /** Every event recorded so far, in order — what the projection folds. */
  events(): BuildEvent[] {
    return [...this.all];
  }

  /** How many events could not be persisted. Non-zero means the stored stream
   *  is incomplete, which the caller should say rather than hide. */
  lostCount(): number {
    return this.lost;
  }

  /**
   * Write everything buffered. Safe to call at any boundary, and safe to call
   * concurrently — calls are serialised so rows keep their seq order.
   */
  async flush(): Promise<void> {
    const run = this.inFlight.then(async () => {
      const batch = this.pending;
      if (batch.length === 0) return;
      this.pending = [];
      try {
        await db.insert(buildEvents).values(
          batch.map(({ seq, event }) => {
            const { type, ...payload } = event;
            return {
              id: randomUUID(),
              sessionId: this.sessionId,
              seq,
              type,
              // Everything but `type`, which is its own column. The event
              // shapes in outcome-projection.ts carry names, counts, paths and
              // verdicts only — no tool output, no model text, no credentials.
              payload: payload as Record<string, unknown>,
            };
          }),
        );
      } catch (err) {
        this.lost += batch.length;
        logger.warn(
          { sessionId: this.sessionId, events: batch.length, lost: this.lost, err },
          "[events] could not persist build events — the stored stream is now incomplete",
        );
      }
    });
    this.inFlight = run.catch(() => undefined);
    return run;
  }
}

/**
 * Read a session's stream back in order.
 *
 * Returns the events the database actually holds, which on a build that died
 * mid-flush is fewer than were recorded. The caller must treat a short stream
 * as a short stream — `projectOutcome` on an unterminated stream returns an
 * outcome with no terminal evidence, which is the honest answer.
 */
export async function loadBuildEvents(sessionId: string): Promise<BuildEvent[]> {
  try {
    const rows = await db
      .select({ type: buildEvents.type, payload: buildEvents.payload, seq: buildEvents.seq })
      .from(buildEvents)
      .where(eq(buildEvents.sessionId, sessionId))
      .orderBy(asc(buildEvents.seq));
    return rows.map((row: { type: string; payload: Record<string, unknown> | null; seq: number }) => ({ type: row.type, ...(row.payload ?? {}) }) as BuildEvent);
  } catch (err) {
    logger.warn({ sessionId, err }, "[events] could not read build events");
    return [];
  }
}
