export interface ParsedFile {
  path: string;
  code: string;
}

/**
 * Extract file path + code pairs from an LLM markdown response.
 *
 * Handles the most common LLM output patterns:
 *   ## File: src/App.tsx      <- heading with "File:" prefix
 *   ### `src/App.tsx`         <- heading with backtick path
 *   **`src/App.tsx`**         <- bold backtick path
 *   src/App.tsx               <- bare path on its own line
 *   // src/App.tsx            <- path as first comment in code block
 */
export function parseFilesFromContent(content: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  const lines = content.split("\n");
  let i = 0;

  // Regex for a line that looks like a file path indicator (before a fence)
  const pathLineRe =
    /^(?:#{1,4}\s+(?:File:\s+)?|>\s*)?[`*_]{0,3}([^\s`*_<>|]+\.[a-zA-Z0-9]{1,10})[`*_]{0,3}:?\s*$/;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Check for opening fence (``` or ~~~)
    if (/^(?:```|~~~)/.test(line)) {
      // Look backwards (up to 3 lines) for a file path heading
      let filePath: string | null = null;
      for (let back = 1; back <= 3; back++) {
        const prevLine = lines[i - back] ?? "";
        if (prevLine.trim() === "") continue;
        const m = pathLineRe.exec(prevLine.trim());
        if (m?.[1]) { filePath = m[1]; break; }
        // If this prev line is itself a fence or content, stop looking back
        if (/^(?:```|~~~)/.test(prevLine) || back === 1) break;
      }

      // Collect code until closing fence
      i++;
      const codeLines: string[] = [];
      while (i < lines.length) {
        const codeLine = lines[i] ?? "";
        if (/^(?:```|~~~)/.test(codeLine)) { i++; break; }
        codeLines.push(codeLine);
        i++;
      }
      const code = codeLines.join("\n").trim();
      if (code.length === 0) continue;

      // Fallback: look for path comment as first line in the code block
      if (filePath === null) {
        const firstCodeLine = codeLines[0] ?? "";
        const commentPathMatch =
          firstCodeLine.match(/^\/\/\s*([^\s]+\.[a-zA-Z0-9]{1,10})\s*$/) ??
          firstCodeLine.match(/^#\s*([^\s]+\.[a-zA-Z0-9]{1,10})\s*$/);
        if (commentPathMatch?.[1]) {
          filePath = commentPathMatch[1];
          const trimmedCode = codeLines.slice(1).join("\n").trim();
          if (trimmedCode.length > 0) {
            files.push({ path: filePath, code: trimmedCode });
          }
          continue;
        }
      }

      if (filePath !== null) {
        files.push({ path: filePath, code });
      }
      continue;
    }

    i++;
  }

  console.log("[DEBUG] Files parsed count:", files.length)
  console.log("[DEBUG] File paths:", files.map((f) => f.path))
  return files;
}

