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

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}
