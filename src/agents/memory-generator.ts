import Anthropic from "@anthropic-ai/sdk"
import { config } from "../server/config.js"

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

const MEMORY_SYSTEM = `You are a project analyst.
Analyze the given code and generate a concise PROJECT_MEMORY.md.

Return ONLY the markdown content, no explanation.

Structure EXACTLY like this:
## What Was Built
[1-2 sentence description of the app]

## Tech Stack
[bullet list: framework, styling, backend, DB]

## Design System
[colors, fonts, border-radius, special effects]

## Components Built
[bullet list of main components with one-line description each]

## Database Schema
[tables and key columns, or "No database" if none]

## API Routes
[list of routes, or "No backend" if frontend-only]

## Key Decisions
[any important architectural choices made]

Keep total length under 400 words. Be specific, not generic.`

export async function generateProjectMemory(
  generatedCode: string,
  existingMemory: string | null,
  recentChange: string,
): Promise<string> {
  try {
    const prompt = existingMemory
      ? `Existing memory:\n${existingMemory}\n\nRecent change made: "${recentChange}"\n\nUpdated code:\n${generatedCode.slice(0, 8000)}\n\nUpdate the memory to reflect changes. Keep unchanged sections as-is.`
      : `New project code:\n${generatedCode.slice(0, 8000)}\n\nCreate the initial project memory.`

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: MEMORY_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    })

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")

    return `# Project Memory\nLast updated: ${new Date().toISOString()}\n\n${text}`
  } catch (err) {
    console.error("[memory-generator] failed:", err)
    return existingMemory ?? ""
  }
}
