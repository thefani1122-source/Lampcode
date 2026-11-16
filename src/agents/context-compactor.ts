/**
 * Safe Context Compactor
 *
 * Compacts old tool output without deleting conversational turns. Every
 * assistant tool_use block and its matching user tool_result remain present,
 * so provider message protocols are preserved. The original system prompt and
 * first user request are never modified.
 */
import type { ChatMessage, MessageContentBlock } from "./model-gateway.js";

export type ConversationMessage = ChatMessage;

export interface CompactionResult {
  compactedMessages: ConversationMessage[];
  tokensBefore: number;
  tokensAfter: number;
  compactedCount: number;
  didCompact: boolean;
  protocolValid: boolean;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_OLD_RESULT_CHARS = 1_800;
const EMERGENCY_RESULT_CHARS = 900;

function isBlockArray(content: ChatMessage["content"]): content is MessageContentBlock[] {
  return Array.isArray(content);
}

function compactText(value: string, maxChars: number, toolName: string): string {
  if (value.length <= maxChars) return value;
  const marker = `\n[… ${value.length - maxChars} characters compacted; use the original tool again for full detail …]\n`;
  const headChars = Math.floor(maxChars * 0.34);
  const tailChars = Math.floor(maxChars * 0.24);
  const middleBudget = Math.max(0, maxChars - headChars - tailChars - marker.length);
  const head = value.slice(0, headChars);
  const tail = value.slice(-tailChars);
  const importantPattern = /(error|exception|failed|failure|warning|success|created|updated|deleted|changed|verified|unverified|src\/|\.tsx?\b|\.sql\b|export\s+(?:default\s+)?(?:class|function|const|type|interface)|function\s+|class\s+|interface\s+|type\s+)/i;
  const candidates = value.split(/\r?\n/).filter((line) => importantPattern.test(line));
  const selected: string[] = [];
  let used = 0;
  for (const line of candidates) {
    const next = (selected.length ? 1 : 0) + line.length;
    if (used + next > middleBudget) continue;
    selected.push(line);
    used += next;
    if (selected.length >= 36) break;
  }
  const middle = selected.length ? selected.join("\n") : "";
  const note = `\n[… earlier ${toolName || "tool"} output compacted …]\n`;
  const result = [head, note, middle, marker, tail].filter(Boolean).join("\n");
  return result.length <= maxChars + note.length + marker.length
    ? result
    : result.slice(0, maxChars + note.length + marker.length);
}

export class ContextCompactor {
  static estimateTokens(messages: ConversationMessage[]): number {
    let chars = 0;
    for (const msg of messages) {
      chars += typeof msg.content === "string"
        ? msg.content.length
        : JSON.stringify(msg.content).length;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  /** Every tool_use id must have exactly one tool_result, and vice versa. */
  static hasValidToolPairs(messages: ConversationMessage[]): boolean {
    const calls = new Map<string, { count: number; messageIndex: number }>();
    const results = new Map<string, { count: number; messageIndex: number }>();
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const message = messages[messageIndex];
      if (!message || !isBlockArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === "tool_use") {
          if (message.role !== "assistant") return false;
          const current = calls.get(block.id) ?? { count: 0, messageIndex };
          calls.set(block.id, { count: current.count + 1, messageIndex });
        }
        if (block.type === "tool_result") {
          if (message.role !== "user") return false;
          const current = results.get(block.tool_use_id) ?? { count: 0, messageIndex };
          results.set(block.tool_use_id, { count: current.count + 1, messageIndex });
        }
      }
    }
    if (calls.size !== results.size) return false;
    for (const [id, call] of calls) {
      const result = results.get(id);
      // Anthropic requires the user tool_result turn immediately after the
      // assistant turn that contains the matching tool_use block(s).
      if (call.count !== 1 || !result || result.count !== 1 || result.messageIndex !== call.messageIndex + 1) return false;
    }
    for (const [id, result] of results) {
      const call = calls.get(id);
      if (result.count !== 1 || !call || call.count !== 1 || result.messageIndex !== call.messageIndex + 1) return false;
    }
    return true;
  }

  static compact(
    messages: ConversationMessage[],
    maxTokens: number = 48_000,
    keepRecentRounds: number = 4,
  ): CompactionResult {
    const tokensBefore = this.estimateTokens(messages);
    const protocolValid = this.hasValidToolPairs(messages);
    const unchanged = (): CompactionResult => ({
      compactedMessages: messages,
      tokensBefore,
      tokensAfter: tokensBefore,
      compactedCount: 0,
      didCompact: false,
      protocolValid,
    });

    if (tokensBefore <= maxTokens || messages.length <= 4 || !protocolValid) return unchanged();

    const toolNames = new Map<string, string>();
    const resultMessageIndexes: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      if (!message || !isBlockArray(message.content)) continue;
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "tool_use") toolNames.set(block.id, block.name);
        }
      } else if (message.role === "user" && message.content.some((b) => b.type === "tool_result")) {
        resultMessageIndexes.push(i);
      }
    }

    const keepCount = Math.max(1, Math.min(keepRecentRounds, resultMessageIndexes.length));
    const recentIndexes = new Set(resultMessageIndexes.slice(-keepCount));
    const compactMessage = (message: ConversationMessage, index: number, limit: number): ConversationMessage => {
      if (!isBlockArray(message.content) || message.role !== "user" || recentIndexes.has(index)) return message;
      let changed = false;
      const content = message.content.map((block) => {
        if (block.type === "tool_result") {
          const compacted = compactText(block.content, limit, toolNames.get(block.tool_use_id) ?? "tool");
          if (compacted !== block.content) changed = true;
          return { ...block, content: compacted };
        }
        // Old screenshots are costly binary payloads; preserve their textual
        // label and tool result, but replace the image itself with a reminder.
        if (block.type === "image") {
          changed = true;
          return { type: "text" as const, text: "[Earlier screenshot omitted during context compaction; call look_at_page again if visual evidence is needed.]" };
        }
        return block;
      });
      return changed ? { ...message, content } : message;
    };

    let compactedMessages = messages.map((message, index) => compactMessage(message, index, DEFAULT_OLD_RESULT_CHARS));
    let tokensAfter = this.estimateTokens(compactedMessages);

    // If the older rounds are not enough to get under budget, compact recent
    // tool results except the latest one. The latest complete tool round is
    // deliberately left intact so the agent retains its immediate working state.
    if (tokensAfter > maxTokens && resultMessageIndexes.length > 1) {
      const latestIndex = resultMessageIndexes[resultMessageIndexes.length - 1];
      const priorRecent = new Set(resultMessageIndexes.slice(0, -1));
      compactedMessages = compactedMessages.map((message, index) => {
        if (!priorRecent.has(index) || index === latestIndex || !isBlockArray(message.content) || message.role !== "user") return message;
        let changed = false;
        const content = message.content.map((block) => {
          if (block.type !== "tool_result") return block;
          const compacted = compactText(block.content, EMERGENCY_RESULT_CHARS, toolNames.get(block.tool_use_id) ?? "tool");
          if (compacted !== block.content) changed = true;
          return { ...block, content: compacted };
        });
        return changed ? { ...message, content } : message;
      });
      tokensAfter = this.estimateTokens(compactedMessages);
    }

    const didCompact = tokensAfter < tokensBefore;
    const outputProtocolValid = this.hasValidToolPairs(compactedMessages);
    if (!outputProtocolValid) return unchanged();

    return {
      compactedMessages,
      tokensBefore,
      tokensAfter,
      compactedCount: didCompact ? resultMessageIndexes.filter((i) => !recentIndexes.has(i)).length : 0,
      didCompact,
      protocolValid: outputProtocolValid,
    };
  }
}
