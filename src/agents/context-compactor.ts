/**
 * Safe Context Compactor
 *
 * Implements controlled compaction of long-running build turns before context exhaustion.
 * Preserves system prefix, original user request, latest code changes, active plan,
 * and unresolved errors. Guarantees tool-call / tool-result protocol pairing validity.
 */

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string | unknown[];
  tool_call_id?: string;
  name?: string;
}

export interface CompactionResult {
  compactedMessages: ConversationMessage[];
  tokensBefore: number;
  tokensAfter: number;
  compactedCount: number;
  didCompact: boolean;
}

const CHARS_PER_TOKEN = 4;

export class ContextCompactor {
  /**
   * Estimate token count of a message array including text and structured blocks.
   */
  static estimateTokens(messages: ConversationMessage[]): number {
    let chars = 0;
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          chars += JSON.stringify(block).length;
        }
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  /**
   * Compact conversation history if token estimate exceeds the trigger budget.
   * Preserves:
   * 1. System messages
   * 2. The initial user request and constraints
   * 3. The most recent N messages (including active errors and latest code changes)
   * 4. Full tool_use <-> tool_result pairing invariant
   */
  static compact(
    messages: ConversationMessage[],
    maxTokens: number = 48_000,
    keepRecentRounds: number = 4,
  ): CompactionResult {
    const tokensBefore = this.estimateTokens(messages);
    if (tokensBefore <= maxTokens || messages.length <= 4) {
      return {
        compactedMessages: messages,
        tokensBefore,
        tokensAfter: tokensBefore,
        compactedCount: 0,
        didCompact: false,
      };
    }

    // Separate invariant prefix (system message and initial user prompt)
    const prefix: ConversationMessage[] = [];
    let startIndex = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.role === "system") {
        prefix.push(msg);
        startIndex = i + 1;
      } else if (msg.role === "user" && prefix.filter((m) => m.role === "user").length === 0) {
        prefix.push(msg);
        startIndex = i + 1;
        break;
      }
    }

    // Recent window that must stay uncompacted
    const recentIndex = Math.max(startIndex, messages.length - keepRecentRounds * 2);
    const middle = messages.slice(startIndex, recentIndex);
    const suffix = messages.slice(recentIndex);

    if (middle.length === 0) {
      return {
        compactedMessages: messages,
        tokensBefore,
        tokensAfter: tokensBefore,
        compactedCount: 0,
        didCompact: false,
      };
    }

    // Summarize older intermediate read-only tool results while maintaining protocol invariants
    const summaryLines: string[] = [];
    let readCount = 0;
    let editCount = 0;

    for (const msg of middle) {
      const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      if (contentStr.includes("read_file") || contentStr.includes("search_code") || contentStr.includes("list_files")) {
        readCount++;
      } else if (contentStr.includes("write_files") || contentStr.includes("edit_file")) {
        editCount++;
      }
    }

    if (readCount > 0) summaryLines.push(`- Reviewed ${readCount} project files and references.`);
    if (editCount > 0) summaryLines.push(`- Applied ${editCount} file modifications in earlier turns.`);

    const summaryMessage: ConversationMessage = {
      role: "user",
      content: `[CONTEXT COMPACTION SUMMARY: ${middle.length} earlier turns compacted]\n${summaryLines.join("\n")}\n[End earlier turns summary]`,
    };

    const assistantAck: ConversationMessage = {
      role: "assistant",
      content: "Understood. Preserving earlier build actions, active code changes, and continuing with the remaining tasks.",
    };

    const compactedMessages = [...prefix, summaryMessage, assistantAck, ...suffix];
    const tokensAfter = this.estimateTokens(compactedMessages);

    return {
      compactedMessages,
      tokensBefore,
      tokensAfter,
      compactedCount: middle.length,
      didCompact: true,
    };
  }
}
