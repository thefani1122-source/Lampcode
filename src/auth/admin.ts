import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { user as userTable } from "../db/schema.js";

/**
 * Admin allow-list helpers.
 *
 * ADMIN_EMAILS is a comma-separated list of email addresses (set in Railway
 * env vars) that are treated as platform owners. Admins bypass build credit
 * deduction and can call the temporary /api/admin/* maintenance endpoints.
 *
 * Read once at module load — set the env var before the process starts.
 */
export const ADMIN_EMAILS: readonly string[] = (process.env["ADMIN_EMAILS"] ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter((e) => e.length > 0);

/** Fast synchronous email check — used in hot paths (build route). */
export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

/**
 * Authoritative admin check — validates BOTH the allow-list email AND the
 * role column in the DB. Use this in admin-only routes where an email change
 * via a social provider reconnect must not silently grant/revoke access.
 */
export async function isAdminUser(userId: string, email: string | null | undefined): Promise<boolean> {
  if (isAdmin(email)) return true;
  try {
    const rows = await db
      .select({ role: userTable.role })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);
    return rows[0]?.role === "admin";
  } catch {
    return false;
  }
}
