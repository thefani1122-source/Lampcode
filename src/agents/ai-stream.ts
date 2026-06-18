import { streamText, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname, resolve, relative, sep } from "node:path";
import { eq } from "drizzle-orm";
import { config } from "../server/config.js";
import { db } from "../db/client.js";
import { projects, buildSessions } from "../db/schema.js";
import { getWebSocketServer } from "../websocket/server.js";
import { getFrontendSystemPrompt, getReactFrameworkRules, loadRelevantSkillsForPrompt, expandUserPrompt } from "./prompt-builder.js";
import { generateProjectMemory } from "./memory-generator.js";
import { ALLOWED_ORIGINS } from "../server/config.js";

const WORKSPACE_BASE = join(process.cwd(), "workspace");

export interface StreamBuildRequest {
  prompt: string;
  sessionId: string;
  projectId: string;
  userId: string;
  projectMemory?: string | null;
  existingFiles?: Record<string, string>;
  origin?: string;
}

async function buildStreamSystemPrompt(prompt: string, projectMemory?: string | null): Promise<string> {
  const [base, frameworkRules, skills] = await Promise.all([
    Promise.resolve(getFrontendSystemPrompt()),
    Promise.resolve(getReactFrameworkRules()),
    loadRelevantSkillsForPrompt(prompt),
  ]);

  const toolInstructions = `

## OUTPUT MODE — TOOL CALLS ONLY
You MUST write every file using the \`writeFile\` tool — do NOT write markdown code fences.
Call writeFile once per file with the complete file contents.
After all files are written, write a 1-2 sentence summary of what you built.
Never output \`\`\`filename: fences — the tool handles file delivery.`;

  const memoryBlock =
    projectMemory && projectMemory.trim()
      ? `\n\n🚨 CRITICAL: This is an EDIT to an existing app.\n${projectMemory}`
      : "";

  return base + frameworkRules + skills + toolInstructions + memoryBlock;
}

function buildUserMessage(
  prompt: string,
  existingFiles: Record<string, string>,
): string {
  const isEdit = Object.keys(existingFiles).length > 0;

  if (isEdit) {
    const fileBlocks = Object.entries(existingFiles)
      .slice(0, 20) // cap at 20 files to stay within context
      .map(([p, c]) => `\`\`\`filename:${p}\n${c}\n\`\`\``)
      .join("\n\n");
    return (
      `EXISTING PROJECT FILES:\n${fileBlocks}\n\n` +
      `USER REQUEST: ${prompt}\n\n` +
      `INSTRUCTION: Edit the existing files to fulfill the request. Use the writeFile tool for each file you create or update.`
    );
  }

  return expandUserPrompt(prompt);
}

export async function handleBuildStream(
  req: StreamBuildRequest,
): Promise<Response> {
  const {
    prompt,
    sessionId,
    projectId,
    userId,
    projectMemory,
    existingFiles = {},
    origin = "",
  } = req;

  const outputDir = join(WORKSPACE_BASE, projectId, sessionId, "frontend");

  const server = getWebSocketServer();

  // Per-build file buffer — populated by writeFile tool calls
  const filesBuffer: Record<string, string> = {};

  const anthropicProvider = createAnthropic({
    apiKey: config.ANTHROPIC_API_KEY,
  });

  const [systemPrompt, userMessage] = await Promise.all([
    buildStreamSystemPrompt(prompt, projectMemory),
    Promise.resolve(buildUserMessage(prompt, existingFiles)),
  ]);

  const result = streamText({
    model: anthropicProvider("claude-sonnet-4-6"),
    providerOptions: {
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 8000 },
      },
    },
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    maxOutputTokens: 16000,
    stopWhen: stepCountIs(60),

    tools: {
      writeFile: {
        description:
          "Write a complete file to the project. Call once per file with the full file content.",
        inputSchema: z.object({
          path: z
            .string()
            .describe(
              "File path relative to project root, e.g. src/App.tsx",
            ),
          content: z
            .string()
            .describe("Complete file content — never truncated"),
        }),
        execute: async ({ path, content }) => {
          try {
            filesBuffer[path] = content;

            // Emit socket events for UI progress
            server.emitToRoom(sessionId, "build:file_writing", {
              filename: path,
              sessionId,
            });
            server.emitToRoom(sessionId, "build:file_write", {
              path,
              content,
              sessionId,
            });
            server.emitToRoom(sessionId, "build:file_done", {
              filename: path,
              sessionId,
            });

            return { success: true, path };
          } catch (err) {
            console.error(`[ai-stream] writeFile tool error for ${path}:`, err);
            return { success: false, path, error: String(err) };
          }
        },
      },
    },

    onFinish: async ({ text }) => {
      try {
        // Write files to disk
        await mkdir(outputDir, { recursive: true });

        for (const [filePath, code] of Object.entries(filesBuffer)) {
          const fullPath = resolve(outputDir, filePath);
          if (!fullPath.startsWith(outputDir + sep)) {
            console.warn(`[ai-stream] path traversal blocked: ${filePath}`);
            continue;
          }
          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, code, "utf8");
        }

        const totalFiles = Object.keys(filesBuffer).length;
        const summary =
          text?.trim() ||
          `Built your app with ${totalFiles > 0 ? totalFiles : "your"} files.`;

        console.log(
          `[ai-stream] build done session=${sessionId} files=${totalFiles}`,
        );

        // Update DB: mark session success and project live
        await Promise.all([
          db.update(buildSessions)
            .set({ status: "success", outputDir, completedAt: new Date() })
            .where(eq(buildSessions.id, sessionId)),
          db.update(projects)
            .set({ status: "live" })
            .where(eq(projects.id, projectId)),
        ]);

        // Emit build:complete so the frontend can show the preview
        server.emitToRoom(sessionId, "build:complete", {
          sessionId,
          files: filesBuffer,
          backendFiles: filesBuffer,
          backendFileCount: 0,
          previewUrl: `/api/build/${sessionId}/preview`,
          totalFiles,
          summary,
        });

        // Async memory update — never blocks the build response
        setImmediate(() => {
          void (async () => {
            try {
              const allCode = Object.values(filesBuffer).join("\n");
              const existingProject = await db.query.projects.findFirst({
                where: eq(projects.id, projectId),
                columns: { projectMemory: true },
              });
              const newMemory = await generateProjectMemory(
                allCode,
                existingProject?.projectMemory ?? null,
                prompt,
              );
              await db.update(projects)
                .set({ projectMemory: newMemory })
                .where(eq(projects.id, projectId));
              console.log(`[memory] saved for project ${projectId}`);
            } catch (err) {
              console.error("[memory] failed:", err);
            }
          })();
        });
      } catch (err) {
        console.error("[ai-stream] onFinish error:", err);
        void db.update(buildSessions)
          .set({ status: "failed", error: String(err), completedAt: new Date() })
          .where(eq(buildSessions.id, sessionId));
        void db.update(projects)
          .set({ status: "failed" })
          .where(eq(projects.id, projectId));
        server.emitToRoom(sessionId, "build:error", {
          message: "Build completed but failed to save files.",
          sessionId,
        });
      }
    },

    onError: async ({ error }) => {
      console.error("[ai-stream] streamText error:", error);
      void db.update(buildSessions)
        .set({ status: "failed", error: String(error), completedAt: new Date() })
        .where(eq(buildSessions.id, sessionId));
      void db.update(projects)
        .set({ status: "failed" })
        .where(eq(projects.id, projectId));
      server.emitToRoom(sessionId, "build:error", {
        message: "Build failed. Please try again.",
        sessionId,
      });
    },
  });

  const response = result.toUIMessageStreamResponse({ sendReasoning: true });

  // Apply CORS headers so the browser can read the SSE stream
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  const headers = new Headers(response.headers);
  if (isAllowed) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}
