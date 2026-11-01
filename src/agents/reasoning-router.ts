/**
 * ReasoningRouter — the single place that decides what is REASONING and what
 * is CONTENT in a model's stream.
 *
 * Before this file the decision lived in two layers that could drift apart:
 * modal-gateway split think tags out of `content`, and stream-handler streamed
 * whatever the gateway called `reasoning`. That worked only while every model
 * happened to match those two shapes. Any other delivery (a gateway that
 * forgets to split, a model that tags differently, a field-only model) fell
 * through silently and the chat's thinking row stayed blank with no way to
 * tell why — exactly what production showed.
 *
 * The router sees EVERY chunk stream-handler receives and classifies it:
 *
 *   reasoning field chunks  → reasoning, attributed to "field"
 *   content chunks          → through ReasoningTagSplitter; tagged regions
 *                             become reasoning attributed to "tags"
 *
 * It also keeps an ordered record of every piece, so the router can rebuild
 * the model's raw turn (`historyText()`) — reasoning included — for the
 * conversation history. That matters because MiniMax's M-series requires the
 * interleaved thinking to be preserved across multi-turn tool loops; stripping
 * tags out of the history quietly degraded every round after the first.
 *
 * And it counts what it saw. stream-handler logs the stats at the end of every
 * round, so a blank thinking row is never a mystery again: the log states
 * whether the model produced reasoning, in which form, and how much.
 */
import type { StreamChunk } from "./model-gateway.js"
import { ReasoningTagSplitter, type ReasoningPiece } from "./reasoning-tag-splitter.js"

export type ReasoningSource = "field" | "tags"

export interface ReasoningStats {
  /** Reasoning pieces that reached the chat. */
  reasoningChunks: number
  reasoningChars: number
  /** Content (code + prose OUTSIDE reasoning) characters. */
  contentChars: number
  /** How reasoning arrived: as the provider's reasoning field, split out of
   *  content tags, both, or none at all. */
  via: "field" | "tags" | "field+tags" | "none"
  /** First ~160 chars of reasoning, for one-glance log diagnosis. */
  firstSample: string
}

interface TrackedPiece {
  kind: ReasoningPiece["kind"]
  source: ReasoningSource | "content"
  text: string
}

const SAMPLE_LIMIT = 160

export class ReasoningRouter {
  private splitter = new ReasoningTagSplitter()
  private ordered: TrackedPiece[] = []
  private reasoningChunks = 0
  private reasoningChars = 0
  private contentChars = 0
  private sawField = false
  private sawTags = false
  private firstSample = ""

  /**
   * Feeds one gateway chunk and returns the pieces to process. `content`
   * chunks are split defensively here even when the gateway already split
   * them — a double-split is harmless (no tags left to find), a missed split
   * is caught.
   */
  feed(chunk: StreamChunk): ReasoningPiece[] {
    if (chunk.type === "reasoning" && chunk.reasoning) {
      return this.record("reasoning", "field", chunk.reasoning)
    }
    if (chunk.type === "content" && chunk.content) {
      const pieces: ReasoningPiece[] = []
      for (const piece of this.splitter.feed(chunk.content)) {
        if (piece.kind === "reasoning") pieces.push(...this.record("reasoning", "tags", piece.text))
        else {
          this.contentChars += piece.text.length
          this.ordered.push({ kind: "content", source: "content", text: piece.text })
          pieces.push(piece)
        }
      }
      return pieces
    }
    return []
  }

  /** End-of-stream flush: emits anything the splitter was still holding. */
  flush(): ReasoningPiece[] {
    const pieces: ReasoningPiece[] = []
    for (const piece of this.splitter.flush()) {
      if (piece.kind === "reasoning") pieces.push(...this.record("reasoning", "tags", piece.text))
      else {
        this.contentChars += piece.text.length
        this.ordered.push({ kind: "content", source: "content", text: piece.text })
        pieces.push(piece)
      }
    }
    return pieces
  }

  /**
   * The model's turn as it originally wrote it — thinking included. Content
   * pieces go back verbatim; reasoning that was split out of content tags is
   * re-wrapped as <think>...</think> (the original tag text itself was consumed by the
   * splitter). Reasoning that arrived via the provider's separate field is
   * NOT folded back in: replaying it as content would change how models like
   * Claude read their own prior turn.
   */
  historyText(): string {
    let out = ""
    for (const piece of this.ordered) {
      if (piece.kind === "content") out += piece.text
      else if (piece.source === "tags") out += '<think>' + piece.text + '</think>'
    }
    return out
  }

  stats(): Readonly<ReasoningStats> {
    const via: ReasoningStats["via"] =
      this.sawField && this.sawTags ? "field+tags" : this.sawField ? "field" : this.sawTags ? "tags" : "none"
    return Object.freeze({
      reasoningChunks: this.reasoningChunks,
      reasoningChars: this.reasoningChars,
      contentChars: this.contentChars,
      via,
      firstSample: this.firstSample,
    })
  }

  private record(kind: "reasoning", source: ReasoningSource, text: string): ReasoningPiece[] {
    if (!text) return []
    if (kind === "reasoning") {
      this.reasoningChunks++
      this.reasoningChars += text.length
      if (source === "field") this.sawField = true
      else this.sawTags = true
      if (!this.firstSample) this.firstSample = text.slice(0, SAMPLE_LIMIT)
    }
    this.ordered.push({ kind, source, text })
    return [{ kind, text }]
  }
}
