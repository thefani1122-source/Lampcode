import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { logger } from "../../server/logger.js";
import { userPlugins } from "../../db/schema.js";
import { normalizeUserPluginRecordId, USER_PLUGIN_MAX_HISTORY, type PluginCapabilityDescriptor } from "../user-plugins.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";

interface PreviousSnapshot extends Record<string, unknown> {
  name: string; description: string; publisher: string; license: string; repository: string;
  version: string; sourceCommit: string; manifest: Record<string, unknown>;
  files: Record<string, string>; capabilities: PluginCapabilityDescriptor[]; contentHash: string;
  enabled?: boolean;
}
export const managePluginHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<string> => {
  const id = normalizeUserPluginRecordId(args["plugin_id"]);
  const action = typeof args["action"] === "string" ? args["action"] : "";
  if (!ctx.userId || !id) return "Error: valid installed plugin id (plugin:<uuid> or <uuid>) and authenticated user context are required.";
  if (!["enable", "disable", "uninstall", "rollback"].includes(action)) return "Error: action must be enable, disable, uninstall or rollback.";
  const rows = await db.select({
    id: userPlugins.id, name: userPlugins.name, revision: userPlugins.revision, previousVersions: userPlugins.previousVersions,
  }).from(userPlugins).where(and(eq(userPlugins.id, id), eq(userPlugins.userId, ctx.userId))).limit(1);
  const row = rows[0];
  if (!row) return "Error: plugin is not installed in this user's library.";

  if (action === "uninstall") {
    const removed = await db.delete(userPlugins).where(and(eq(userPlugins.id, id), eq(userPlugins.userId, ctx.userId))).returning({ id: userPlugins.id });
    if (removed[0]) logger.info({ userId: ctx.userId, pluginId: id, action }, "Plugin package uninstalled");
    return removed[0] ? "Uninstalled " + row.name + ". Its capabilities will disappear from future builds." : "Error: plugin could not be uninstalled.";
  }
  if (action === "enable" || action === "disable") {
    const enabled = action === "enable";
    const updated = await db.update(userPlugins).set({ enabled, updatedAt: new Date() })
      .where(and(
        eq(userPlugins.id, id),
        eq(userPlugins.userId, ctx.userId),
        eq(userPlugins.revision, row.revision),
      ))
      .returning({ name: userPlugins.name, enabled: userPlugins.enabled });
    if (!updated[0]) return "Error: the plugin changed while its state was being updated. Refresh and retry.";
    logger.info({ userId: ctx.userId, pluginId: id, action, enabled }, "Plugin package state changed");
    return (enabled ? "Enabled " : "Disabled ") + updated[0].name + ".";
  }

  const history = (Array.isArray(row.previousVersions) ? row.previousVersions : []) as PreviousSnapshot[];
  const previous = history.at(-1);
  if (!previous) return "Error: no previous plugin snapshot is available for rollback.";
  const updated = await db.update(userPlugins).set({
    name: previous.name, description: previous.description, publisher: previous.publisher,
    license: previous.license, repository: previous.repository, version: previous.version,
    revision: sql`${userPlugins.revision} + 1`, sourceCommit: previous.sourceCommit,
    manifest: previous.manifest, files: previous.files, capabilities: previous.capabilities as PluginCapabilityDescriptor[],
    contentHash: previous.contentHash, previousVersions: history.slice(0, -1).slice(-USER_PLUGIN_MAX_HISTORY),
    enabled: previous.enabled ?? true, updatedAt: new Date(),
  }).where(and(
    eq(userPlugins.id, id),
    eq(userPlugins.userId, ctx.userId),
    eq(userPlugins.revision, row.revision),
  )).returning({ name: userPlugins.name, version: userPlugins.version, revision: userPlugins.revision });
  if (!updated[0]) return "Error: the plugin changed while rollback was being applied. Refresh and retry.";
  logger.info({ userId: ctx.userId, pluginId: id, action, restoredVersion: updated[0].version, revision: updated[0].revision }, "Plugin package rolled back");
  return "Rolled back " + updated[0].name + " to " + updated[0].version + " (revision " + updated[0].revision + ").";
};
