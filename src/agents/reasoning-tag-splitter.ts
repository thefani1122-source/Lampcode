/**
 * Splits inline reasoning tags out of a model's `content` stream.
 *
 * MiniMax M2/M2.5 (and other thinking models served through OpenAI-compatible
 * endpoints) wrap their reasoning in <think>…</think> tags INSIDE the normal
 * content field when the serving stack does not split it for us. Bedrock's
 * OpenAI-compatible route serves the raw output, so `delta.content` carries
 * reasoning text and `reasoning_content` stays empty — which is why the chat's
 * thinking row stayed blank while every token silently passed as content.
 *
 * The splitter is a small state machine over the stream: everything between an
 * opening and closing tag becomes `reasoning`, everything outside stays
 * `content`. Tags split across stream chunks are handled by holding back a
 * trailing partial tag (e.g. a buffer ending in "<thi") until the next chunk
 * decides what it was. Opening tags may carry attributes (<think/>, <think
 * id="…">), which M2.5 is known to emit.
 *
 * Feeding it plain content without any tags is a pass-through: one held-back
 * flush at most, and no reasoning is ever invented.
 */

export type ReasoningPiece = { kind: "content" | "reasoning"; text: string }

const OPENING = ["<think", "<infer"]
const CLOSING = ["</think", "</infer"]

const OPEN_RE = /<(?:think|infer)(?:\s[^>]*)?\/?>/i
const CLOSE_RE = /<\/(?:think|infer)>/i

/** Longest suffix of `text` that is a proper prefix of one of `literals`. */
function trailingPartialTagLength(text: string, literals: string[]): number {
  const maxLen = Math.max(...literals.map((l) => l.length)) - 1
  const window = text.slice(-maxLen)
  let best = 0
  for (const literal of literals) {
    for (let len = Math.min(literal.length - 1, window.length); len > best; len--) {
      if (window.endsWith(literal.slice(0, len))) best = len
    }
  }
  return best
}

export class ReasoningTagSplitter {
  private buffer = ""
  private inside = false

  feed(text: string): ReasoningPiece[] {
    this.buffer += text
    const pieces: ReasoningPiece[] = []
    for (;;) {
      if (!this.inside) {
        const open = OPEN_RE.exec(this.buffer)
        if (open) {
          this.push(pieces, "content", this.buffer.slice(0, open.index))
          this.buffer = this.buffer.slice(open.index + open[0].length)
          this.inside = true
          continue
        }
        const hold = trailingPartialTagLength(this.buffer, OPENING)
        if (hold > 0) {
          this.push(pieces, "content", this.buffer.slice(0, this.buffer.length - hold))
          this.buffer = this.buffer.slice(this.buffer.length - hold)
        } else {
          this.push(pieces, "content", this.buffer)
          this.buffer = ""
        }
        break
      }
      const close = CLOSE_RE.exec(this.buffer)
      if (close) {
        this.push(pieces, "reasoning", this.buffer.slice(0, close.index))
        this.buffer = this.buffer.slice(close.index + close[0].length)
        this.inside = false
        continue
      }
      const hold = trailingPartialTagLength(this.buffer, CLOSING)
      if (hold > 0) {
        this.push(pieces, "reasoning", this.buffer.slice(0, this.buffer.length - hold))
        this.buffer = this.buffer.slice(this.buffer.length - hold)
      } else {
        this.push(pieces, "reasoning", this.buffer)
        this.buffer = ""
      }
      break
    }
    return pieces
  }

  /** Yields whatever is still held back; call once at end of stream. */
  flush(): ReasoningPiece[] {
    const pieces: ReasoningPiece[] = []
    if (this.inside) {
      // A partial closing tag can never complete once the stream is over —
      // drop it instead of leaking tag text into the thinking transcript.
      const hold = trailingPartialTagLength(this.buffer, CLOSING)
      if (hold) this.buffer = this.buffer.slice(0, this.buffer.length - hold)
    }
    if (this.buffer) this.push(pieces, this.inside ? "reasoning" : "content", this.buffer)
    this.buffer = ""
    return pieces
  }

  private push(pieces: ReasoningPiece[], kind: ReasoningPiece["kind"], text: string): void {
    if (text) pieces.push({ kind, text })
  }
}
