import { currentProjectFiles, recordProjectFileWrite } from "../file-deletion.js";
import { autoCheckReason } from "../../verify/auto-check.js";
import { writeFilesToSandbox, isTemplateOwnedFile } from "../../preview/e2b-service.js";
import { persistFilesAsWritten } from "../../storage/project-files.js";
import type { ToolHandler } from "./registry.js";
import type { ToolExecutionContext } from "../tools.js";
import { noteChurn, noteWrite, runPageSweep } from "./shared.js";
export const writeFilesHandler: ToolHandler = async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
  const projectId = ctx.projectId!;

      noteWrite(ctx);
      const raw = Array.isArray(args["files"]) ? (args["files"] as unknown[]) : [];
      const files: Record<string, string> = {};
      for (const entry of raw) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e["path"] === "string" && typeof e["content"] === "string") {
          files[e["path"]] = e["content"];
        }
      }
      if (Object.keys(files).length === 0) {
        return "Error: no valid files provided. Each entry needs a string `path` and string `content`.";
      }

      // Merge into the running set first, then write the WHOLE set. The
      // sandbox's own writer skips template-owned files (package.json,
      // vite.config, etc.) on its own, so the model can't break the scaffold.
      // Recorded BEFORE the write deliberately: if the sandbox write fails,
      // the model still authored this content, and the caller writes the set
      // to disk and pushes it through the normal preview path afterwards.
      // Dropping it on a sandbox hiccup would throw away real work; the model
      // is told about the failure either way and can retry.
      // Refuse template-owned paths here, out loud, instead of accepting them
      // and letting them be dropped further down. A model asked for scroll
      // animations wrote them into src/styles.css, was told "Wrote 2 files",
      // and reported the animations as done — while the file was discarded on
      // the way in and the page never changed. Silent rejection is how an agent
      // ends up honestly describing work that does not exist.
      // Refuse fragments carrying unresolved edit markers. Those belong to the
      // pipeline, where file-parser.ts splices them into the existing file;
      // here the content IS the file, so writing it destroys the real one. The
      // prompt no longer offers markers on this path, but a model can still
      // reach for them, and the cost of being wrong is a working app replaced
      // by a syntax error. build.ts's validateAppTsx refuses the same thing on
      // the pipeline side.
      const marked = Object.keys(files).filter((p) =>
        /\/\/\s*(BEGIN_EDIT|END_EDIT)\b/.test(files[p] ?? ""),
      );
      if (marked.length > 0) {
        return (
          `Nothing was written. ${marked.join(", ")} contained // BEGIN_EDIT or // END_EDIT ` +
          `markers.\n` +
          `write_files replaces a file entirely — nothing splices those markers, so writing a ` +
          `fragment would destroy the rest of the file. Send the COMPLETE content of each file ` +
          `you are changing, every line, including the parts you are not changing.`
        );
      }

      const refused = Object.keys(files).filter((p) => isTemplateOwnedFile(p));
      for (const p of refused) delete files[p];
      if (Object.keys(files).length === 0) {
        return (
          `Nothing was written. ${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} ` +
          `owned by the project template and cannot be changed.\n` +
          `For custom CSS, create your own stylesheet — e.g. src/app.css — and import it from ` +
          `src/App.tsx. It will be picked up normally. Do not put it in src/styles.css.`
        );
      }

      // Measured before the merge, while the previous content is still
      // reachable. A path this build has not seen before counts as created
      // rather than replaced, so a new project does not read as churn.
      for (const [path, content] of Object.entries(files)) {
        const before = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles, ctx.deletedFiles)[path];
        noteChurn(ctx, before ?? "", content, before === undefined ? "created" : "replaced");
      }

      for (const [path, content] of Object.entries(files)) {
        recordProjectFileWrite(path, content, ctx.generatedFiles, ctx.deletedFiles);
      }
      // The sandbox gets the WHOLE project, not just this turn's files. On an
      // edit the model writes only what it changed (correctly — that is what
      // preserves everything else), but the sandbox may be a fresh template,
      // and checking a template with three edited files dropped into it tells
      // the model nothing about the real app. Existing files first so this
      // turn's writes win on any path they both have.
      const toWrite = currentProjectFiles(ctx.projectFiles, ctx.generatedFiles ?? files, ctx.deletedFiles);

      let url: string | undefined;
      let writeError: string | undefined;
      try {
        url = await writeFilesToSandbox(projectId, toWrite, ctx.onLog);
      } catch (err) {
        writeError = err instanceof Error ? err.message : String(err);
      }

      // Store them NOW, not at the end of the build. A build that dies partway
      // — the cost ceiling mid-dispatch, a provider error, a restart — used to
      // leave a sandbox full of working files and nothing recoverable. Done
      // even when the sandbox write failed: the model authored this content,
      // and the same reasoning that records it in generatedFiles above applies
      // to keeping it.
      await persistFilesAsWritten(projectId, files);

      if (writeError !== undefined) return `Error writing files: ${writeError}`;

      const note = refused.length > 0
        ? `\nNOT written: ${refused.join(", ")} — owned by the project template. ` +
          `Put custom CSS in your own file (e.g. src/app.css) and import it from src/App.tsx.`
        : "";
      const head =
        `Wrote ${Object.keys(files).length} file(s): ${Object.keys(files).join(", ")}.${note}`;

      // The page check rides along rather than waiting to be asked.
      //
      // Telling the model to "call check_page" was the whole mechanism before
      // this, and a real build showed what that is worth: three writes and one
      // edit, a single check_page call, and a finishing verdict of "pass" about
      // code three writes older than what shipped. A weaker model is worse
      // still — one spent five rounds without calling the write tool at all.
      // Guidance in a sentence does not survive a long build; the environment
      // doing it does.
      //
      // Fires only when the verdict is missing or stale (see autoCheckReason),
      // so a model that checks after its own writes never pays for this twice.
      const reason = autoCheckReason(ctx.gateResults);
      if (reason !== null) {
        const swept = await runPageSweep(ctx, projectId, reason);
        if (swept !== null) {
          return `${head}\n\nThe app is running at ${url}. I opened it for you:\n\n${swept}`;
        }
        // The sweep could not run. Say so rather than staying silent, because
        // silence here reads as "and everything was fine".
        return (
          `${head}\nThe app is running at ${url}. ` +
          `I could not open it to check — call check_page yourself; do not assume it renders.`
        );
      }

      return `${head}\nThe app is running at ${url}. Call check_page to see what it renders.`;
    
};

