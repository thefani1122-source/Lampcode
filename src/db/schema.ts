import {
  pgTable,
  pgEnum,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  doublePrecision,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── Better-Auth required tables ─────────────────────────────────────────────

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { mode: "date" }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { mode: "date" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date" }),
  updatedAt: timestamp("updated_at", { mode: "date" }),
});

// ── Domain types for JSONB columns ───────────────────────────────────────────

export type PlanQuestion = {
  id: string;
  text: string;
  type: "text" | "choice" | "multiChoice";
  options?: string[] | undefined;
  required?: boolean | undefined;
};

export type PlanAnswer = {
  questionId: string;
  answer: string;
};

export type InterviewData = {
  questions: PlanQuestion[];
  answers: PlanAnswer[];
};

export type PlanTask = {
  agent: string;
  task: string;
  estimatedTokens: number;
  phase: string;
};

export type VerifyCheck = {
  name: string;
  passed: boolean;
  severity?: string | undefined;
  detail: string;
};

export type VerifyReport = {
  passed: boolean;
  round: number;
  checks: VerifyCheck[];
};

export type ProjectSettings = {
  buildCommand?: string | undefined;
  outputDir?: string | undefined;
  nodeVersion?: string | undefined;
  envVars?: Record<string, string> | undefined;
};

export type ProjectBranding = {
  primaryColor?: string | undefined;
  logoUrl?: string | undefined;
  faviconUrl?: string | undefined;
};

// ── Enums ────────────────────────────────────────────────────────────────────

export const projectModeEnum = pgEnum("project_mode", ["fast", "plan"]);

export const projectStatusEnum = pgEnum("project_status", [
  "active",
  "inactive",
  "building",
  "error",
]);

export const buildStatusEnum = pgEnum("build_status", [
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
]);

export const memberRoleEnum = pgEnum("member_role", ["owner", "member", "viewer"]);

// ── BuildForge tables (dependency order) ─────────────────────────────────────

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  mode: projectModeEnum("mode").notNull(),
  status: projectStatusEnum("status").notNull().default("active"),
  techStack: text("tech_stack").array(),
  settings: jsonb("settings").$type<ProjectSettings>(),
  branding: jsonb("branding").$type<ProjectBranding>(),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const projectMembers = pgTable("project_members", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: memberRoleEnum("role").notNull().default("member"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const buildJobs = pgTable("build_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  status: buildStatusEnum("status").notNull().default("queued"),
  projectName: text("project_name").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { mode: "date" }),
  completedAt: timestamp("completed_at", { mode: "date" }),
  durationMs: integer("duration_ms"),
});

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export const buildSessionStatusEnum = pgEnum("build_session_status", [
  "running",
  "success",
  "failed",
  "cancelled",
]);

export const buildSessions = pgTable("build_sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  mode: projectModeEnum("mode").notNull().default("fast"),
  status: buildSessionStatusEnum("status").notNull().default("running"),
  phase: integer("phase").notNull().default(0),
  outputDir: text("output_dir"),
  previewUrl: text("preview_url"),
  creditsUsed: doublePrecision("credits_used").notNull().default(0),
  attachments: jsonb("attachments").$type<string[]>(),
  error: text("error"),
  // Plan-mode extra columns (null for fast mode sessions)
  planStatus: text("plan_status"),
  currentPlanPhase: text("current_plan_phase"),
  interviewData: jsonb("interview_data").$type<InterviewData>(),
  contractContent: text("contract_content"),
  planTasks: jsonb("plan_tasks").$type<PlanTask[]>(),
  verifyRound: integer("verify_round").notNull().default(0),
  verifyReport: jsonb("verify_report").$type<VerifyReport>(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { mode: "date" }),
  completedAt: timestamp("completed_at", { mode: "date" }),
});

export const agentTaskStatusEnum = pgEnum("agent_task_status", [
  "running",
  "complete",
  "failed",
]);

export const agentTasks = pgTable("agent_tasks", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  agentType: text("agent_type").notNull(),
  modelUsed: text("model_used").notNull(),
  tierUsed: integer("tier_used").notNull().default(1),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: doublePrecision("cost_usd"),
  status: agentTaskStatusEnum("status").notNull().default("running"),
  startedAt: timestamp("started_at", { mode: "date" }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { mode: "date" }),
  error: text("error"),
});

// ── MCP Integrations ─────────────────────────────────────────────────────────

export const mcpProviderEnum = pgEnum("mcp_provider", [
  "vercel",
  "supabase",
  "github",
  "railway",
]);

export const integrationStatusEnum = pgEnum("integration_status", [
  "connected",
  "disconnected",
  "error",
]);

export type IntegrationCredentials = {
  token?: string | undefined;
  apiKey?: string | undefined;
  teamId?: string | undefined;
  orgId?: string | undefined;
  projectRef?: string | undefined;
  serviceId?: string | undefined;
  repoOwner?: string | undefined;
};

export const integrations = pgTable("integrations", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  provider: mcpProviderEnum("provider").notNull(),
  status: integrationStatusEnum("status").notNull().default("connected"),
  tier: integer("tier").notNull().default(1),
  credentials: jsonb("credentials").$type<IntegrationCredentials>(),
  lastTestedAt: timestamp("last_tested_at", { mode: "date" }),
  lastDeployedAt: timestamp("last_deployed_at", { mode: "date" }),
  error: text("error"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

// ── Shared Brain ─────────────────────────────────────────────────────────────

export const brainFileTypeEnum = pgEnum("brain_file_type", [
  "CONTRACT",
  "DB_SCHEMA",
  "API_CONTRACTS",
  "CURRENT_STATE",
]);

export const sharedBrainFiles = pgTable("shared_brain_files", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  sessionId: text("session_id"),
  fileType: brainFileTypeEnum("file_type").notNull(),
  version: integer("version").notNull(),
  content: text("content").notNull(),
  agentType: text("agent_type"),
  modelUsed: text("model_used"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

// ── Relations ────────────────────────────────────────────────────────────────

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  projects: many(projects),
  projectMembers: many(projectMembers),
  buildJobs: many(buildJobs),
  auditLogs: many(auditLog),
  agentTasks: many(agentTasks),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  owner: one(user, { fields: [projects.userId], references: [user.id] }),
  members: many(projectMembers),
  buildJobs: many(buildJobs),
  auditLogs: many(auditLog),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  user: one(user, { fields: [projectMembers.userId], references: [user.id] }),
}));

export const buildJobsRelations = relations(buildJobs, ({ one }) => ({
  user: one(user, { fields: [buildJobs.userId], references: [user.id] }),
  project: one(projects, { fields: [buildJobs.projectId], references: [projects.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  user: one(user, { fields: [auditLog.userId], references: [user.id] }),
  project: one(projects, { fields: [auditLog.projectId], references: [projects.id] }),
}));

export const buildSessionsRelations = relations(buildSessions, ({ one }) => ({
  project: one(projects, { fields: [buildSessions.projectId], references: [projects.id] }),
  user: one(user, { fields: [buildSessions.userId], references: [user.id] }),
}));

export const agentTasksRelations = relations(agentTasks, ({ one }) => ({
  user: one(user, { fields: [agentTasks.userId], references: [user.id] }),
  project: one(projects, { fields: [agentTasks.projectId], references: [projects.id] }),
}));

export const sharedBrainFilesRelations = relations(sharedBrainFiles, ({ one }) => ({
  project: one(projects, { fields: [sharedBrainFiles.projectId], references: [projects.id] }),
}));

export const integrationsRelations = relations(integrations, ({ one }) => ({
  project: one(projects, { fields: [integrations.projectId], references: [projects.id] }),
  user: one(user, { fields: [integrations.userId], references: [user.id] }),
}));

// ── User preferences ──────────────────────────────────────────────────────────

export type UserPreferenceData = {
  theme?: "light" | "dark" | "system" | undefined;
  emailNotifications?: boolean | undefined;
  buildNotifications?: boolean | undefined;
  weeklyDigest?: boolean | undefined;
  defaultModel?: string | undefined;
  timezone?: string | undefined;
};

export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  theme: text("theme").notNull().default("system"),
  emailNotifications: boolean("email_notifications").notNull().default(true),
  buildNotifications: boolean("build_notifications").notNull().default(true),
  weeklyDigest: boolean("weekly_digest").notNull().default(false),
  defaultModel: text("default_model"),
  timezone: text("timezone"),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

// ── Encrypted project env vars ────────────────────────────────────────────────

export const envEnvironmentEnum = pgEnum("env_environment", [
  "development",
  "preview",
  "production",
]);

// Composite unique: (projectId, environment, key) enforced at the application layer.
export const projectEnvVars = pgTable(
  "project_env_vars",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environment: envEnvironmentEnum("environment").notNull().default("production"),
    key: text("key").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("env_vars_unique_key").on(t.projectId, t.environment, t.key)],
);

// ── User billing ──────────────────────────────────────────────────────────────

export const billingPlanEnum = pgEnum("billing_plan", ["free", "pro", "enterprise"]);

export const PLAN_CREDITS: Record<"free" | "pro" | "enterprise", number> = {
  free:       100,
  pro:        2_000,
  enterprise: 50_000,
};

export const userBilling = pgTable("user_billing", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  plan: billingPlanEnum("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  creditsLimit: integer("credits_limit").notNull().default(100),
  creditsUsed: integer("credits_used").notNull().default(0),
  currentPeriodStart: timestamp("current_period_start", { mode: "date" }),
  currentPeriodEnd: timestamp("current_period_end", { mode: "date" }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

// ── New relations ─────────────────────────────────────────────────────────────

export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
  user: one(user, { fields: [userPreferences.userId], references: [user.id] }),
}));

export const projectEnvVarsRelations = relations(projectEnvVars, ({ one }) => ({
  project: one(projects, { fields: [projectEnvVars.projectId], references: [projects.id] }),
}));

export const userBillingRelations = relations(userBilling, ({ one }) => ({
  user: one(user, { fields: [userBilling.userId], references: [user.id] }),
}));

// ── Inferred types ───────────────────────────────────────────────────────────

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Session = typeof session.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type BuildJob = typeof buildJobs.$inferSelect;
export type AuditLog = typeof auditLog.$inferSelect;
export type BuildStatus = (typeof buildStatusEnum.enumValues)[number];
export type ProjectMode = (typeof projectModeEnum.enumValues)[number];
export type ProjectStatus = (typeof projectStatusEnum.enumValues)[number];
export type MemberRole = (typeof memberRoleEnum.enumValues)[number];
export type AgentTask = typeof agentTasks.$inferSelect;
export type AgentTaskStatus = (typeof agentTaskStatusEnum.enumValues)[number];
export type BuildSession = typeof buildSessions.$inferSelect;
export type NewBuildSession = typeof buildSessions.$inferInsert;
export type BuildSessionStatus = (typeof buildSessionStatusEnum.enumValues)[number];
export type Integration = typeof integrations.$inferSelect;
export type NewIntegration = typeof integrations.$inferInsert;
export type McpProvider = (typeof mcpProviderEnum.enumValues)[number];
export type IntegrationStatus = (typeof integrationStatusEnum.enumValues)[number];
export type SharedBrainFile = typeof sharedBrainFiles.$inferSelect;
export type NewSharedBrainFile = typeof sharedBrainFiles.$inferInsert;
export type BrainFileType = (typeof brainFileTypeEnum.enumValues)[number];
export type UserPreferences = typeof userPreferences.$inferSelect;
export type ProjectEnvVar = typeof projectEnvVars.$inferSelect;
export type NewProjectEnvVar = typeof projectEnvVars.$inferInsert;
export type UserBilling = typeof userBilling.$inferSelect;
export type BillingPlan = (typeof billingPlanEnum.enumValues)[number];
export type EnvEnvironment = (typeof envEnvironmentEnum.enumValues)[number];
