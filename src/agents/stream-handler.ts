import { writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"

export interface StreamChunk {
  type: "content" | "done" | "error"
  content?: string
  error?: string
  usage?: { prompt_tokens: number; completion_tokens: number }
}

export async function handleAgentStream(
  generator: AsyncGenerator<StreamChunk>,
  opts: {
    sessionId: string
    agentType: string
    taskId: string
    outputPath: string
  }
): Promise<string> {
  const { sessionId, agentType, taskId, outputPath } = opts
  let fullContent = ""

  for await (const chunk of generator) {
    if (chunk.type === "error") {
      throw new Error(chunk.error)
    }

    if (chunk.type === "content" && chunk.content) {
      fullContent += chunk.content
    }

    if (chunk.type === "done") {
      break
    }
  }

  try {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, fullContent, "utf-8")
  } catch (err) {
    console.error("[StreamHandler] File write failed:", err)
  }

  return fullContent
}
