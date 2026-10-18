import { currentProjectFile, currentProjectFiles, deletedFileEditMessage } from "../file-deletion.js";
import { writeFilesToSandbox, readProjectFile, isTemplateOwnedFile } from "../../preview/e2b-service.js";
import { persistFilesAsWritten } from "../../storage/project-files.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
import { noteChurn, noteWrite, NOT_READY, isNoSandbox } from "./shared.js";
export const editFileHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
  const projectId = ctx.projectId!;

      noteWrite(ctx);
      const path = typeof args["path"] === "string" ? args["path"].trim() : "";
      const oldString = typeof args["old_string"] === "string" ? args["old_string"] : "";
      const newString = typeof args["new_string"] === "string" ? args["new_string"] : "";

      if (!path) return "Error: `path` is required.";
      if (ctx.deletedFiles?.has(path)) return deletedFileEditMessage(path);
      if (oldString === "") {
        return (
          "Error: `old_string` is required and cannot be empty. To create a new file, use " +
          "write_files instead."
        );
      }
      if (oldString === newString) {
        return "Nothing was changed: `old_string` and `new_string` are identical.";
      }
      if (isTemplateOwnedFile(path)) {
        return (
          `${path} is owned by the project template and cannot be changed.\n` +
          `For custom CSS, create your own stylesheet — e.g. src/app.css — and import it from ` +
          `src/App.tsx.`
        );
      }

      // Same precedence as read_file: what this turn wrote, then the project as
      // it stood at build start, then the sandbox. Editing anything staler than
      // that would silently undo the model's own previous edit.
      const current =
        currentProjectFile(path, ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles) ??
        (await readProjectFile(projectId, path).catch((err: unknown) => {
          if (isNoSandbox(err)) return null;
          return undefined;
        }));

      if (current === null) return NOT_READY;
      if (current === undefined) {
        return (
          `Could not read ${path}. Call list_files to see what the project actually contains, ` +
          `or use write_files if this file does not exist yet.`
        );
      }

      // Exact match, and it has to be unambiguous. Replacing the first of
      // several matches is how an edit tool quietly changes the wrong line.
      const occurrences = current.split(oldString).length - 1;
      if (occurrences === 0) {
        return (
          `No change made: that exact text does not appear in ${path}. It must match the ` +
          `file character for character, including indentation and line breaks. Call ` +
          `read_file on ${path} and copy the text from what it returns.`
        );
      }
      if (occurrences > 1) {
        return (
          `No change made: that text appears ${occurrences} times in ${path}, so it is ` +
          `ambiguous. Include more of the surrounding lines until it identifies exactly one ` +
          `place.`
        );
      }

      // A FUNCTION replacement, not a string one: in String.replace a literal
      // replacement treats $&, $1, $` and $' as substitution patterns, so new
      // text containing them would be silently mangled — and generated code
      // contains them often, in exactly the regex replacements this tool would
      // be used to edit. Verified: replacing with "[$&]" writes "[1]" the
      // naive way and "[$&]" this way.
      const updated = current.replace(oldString, () => newString);
      // Exact here, unlike write_files: only the replaced span changed, so this
      // is the one measurement that cleanly answers whether an edit removed
      // anything or only added.
      noteChurn(ctx, oldString, newString, "edited");
      if (ctx.generatedFiles) ctx.generatedFiles[path] = updated;

      // Write the WHOLE project, as write_files does: the sandbox may be a fresh
      // template, and checking one edited file dropped into it would tell the
      // model nothing about the real app.
      const toWrite = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles ?? { [path]: updated }, ctx.deletedFiles);
      let url: string | undefined;
      let writeError: string | undefined;
      try {
        url = await writeFilesToSandbox(projectId, toWrite, ctx.onLog);
      } catch (err) {
        writeError = err instanceof Error ? err.message : String(err);
      }

      // Same reason as write_files: store the edited file now, so a build that
      // dies later is still recoverable. Only this one file — uploads are
      // upserts keyed on path, so the stored project stays whole.
      await persistFilesAsWritten(projectId, { [path]: updated });

      if (writeError !== undefined) return `Error writing ${path}: ${writeError}`;
      const removed = newString === "";
      return (
        `Edited ${path} — ${removed ? "removed" : "replaced"} 1 occurrence.\n` +
        `The app is running at ${url}. Call check_page to see what it actually renders.`
      );
    
};

