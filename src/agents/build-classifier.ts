import Anthropic from "@anthropic-ai/sdk";
import { config } from "../server/config.js";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

export interface BuildClassification {
  buildType: "frontend" | "fullstack";
  framework: "react" | "nextjs" | "tanstack";
  database: "supabase" | "mongodb" | "none";
  needsAuth: boolean;
  reason: string;
}

const CLASSIFIER_PROMPT = `You are a build system that decides how to build a web app from a user prompt.

Return ONLY valid JSON, no explanation, no markdown.

Rules:
- Default to "frontend" unless backend is CLEARLY needed
- "frontend" = React + Vite + Sandpack (fast, in-browser)
- "fullstack" = React + Hono + Supabase + E2B (slower)

Choose "frontend" when:
- Landing pages, portfolios, static sites
- UI demos, mockups, prototypes
- Apps with sample/mock data
- Calculator, timer, game, todo (local state)
- "no backend", "just UI", "static", "mock data"
- Simple CRUD where localStorage is enough
- User wants to "see how it looks"

Choose "fullstack" ONLY when user EXPLICITLY mentions:
- Login, signup, user accounts, authentication
- "Save to database", "real database", "persist across devices"
- Multiple users seeing each other's data
- Admin panel with real user management
- Payment processing (Stripe)
- File uploads that persist
- Real-time features (chat, live updates)
- REST API, backend server, Hono, Express

When unsure → ALWAYS choose "frontend"

framework rules:
- "nextjs" or "next.js" in prompt → nextjs
- "tanstack" in prompt → tanstack
- default → react

database rules:
- "mongo" or "mongodb" in prompt → mongodb
- "none" if frontend
- default fullstack → supabase

needsAuth:
- true ONLY if login/signup/auth explicitly mentioned
- false otherwise

Return this exact JSON shape:
{
  "buildType": "frontend" | "fullstack",
  "framework": "react" | "nextjs" | "tanstack",
  "database": "supabase" | "mongodb" | "none",
  "needsAuth": boolean,
  "reason": "one sentence why"
}`;

export async function classifyBuild(
  prompt: string,
): Promise<BuildClassification> {
  const fallback: BuildClassification = {
    buildType: "frontend",
    framework: "react",
    database: "none",
    needsAuth: false,
    reason: "defaulting to frontend",
  };

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: CLASSIFIER_PROMPT,
      messages: [{ role: "user", content: `Classify this build request:\n\n"${prompt}"` }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const clean = text
      .replace(/^```json?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();

    // Extract just the JSON object (skip any preamble)
    const jsonStart = clean.indexOf("{");
    const jsonEnd = clean.lastIndexOf("}") + 1;
    if (jsonStart === -1 || jsonEnd === 0) {
      throw new Error("No JSON object found in response");
    }

    const jsonStr = clean.slice(jsonStart, jsonEnd);
    const parsed = JSON.parse(jsonStr) as BuildClassification;

    console.log(
      `[classifier] "${prompt.slice(0, 50)}..." →`,
      parsed.buildType,
      `(${parsed.reason})`,
    );

    return parsed;
  } catch (err) {
    console.error("[classifier] failed, using fallback:", err);
    return fallback;
  }
}
