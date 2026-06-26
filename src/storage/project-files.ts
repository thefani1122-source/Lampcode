import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdmin } from "../auth/supabase-server.js";

const BUCKET = "project-files";

// Lazy bucket-ready guard — one create attempt per process, no repeated calls.
let _bucketReady = false;

async function ensureBucket(): Promise<void> {
  if (_bucketReady) return;
  const sb = getSupabaseAdmin();
  const { error } = await sb.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 10 * 1024 * 1024, // 10 MB per file
  });
  // "already exists" is the expected steady-state — not an error
  if (error && !error.message.toLowerCase().includes("already exist")) {
    throw new Error(`[project-files] bucket create failed: ${error.message}`);
  }
  _bucketReady = true;
}

// ── Upload ────────────────────────────────────────────────────────────────────

/**
 * Upsert all files for a project to Supabase Storage.
 * Object paths: `{projectId}/{relativeFilePath}` (e.g. abc123/src/App.tsx).
 * Uses projectId as the key — NOT sessionId — so any session finds them.
 */
export async function uploadProjectFiles(
  projectId: string,
  files: Record<string, string>,
): Promise<void> {
  if (Object.keys(files).length === 0) return;
  await ensureBucket();
  const sb = getSupabaseAdmin();

  const uploads = Object.entries(files).map(([relPath, content]) => {
    const storagePath = `${projectId}/${relPath}`;
    const body = Buffer.from(content, "utf8");
    return sb.storage
      .from(BUCKET)
      .upload(storagePath, body, {
        contentType: "text/plain; charset=utf-8",
        upsert: true,
      })
      .then(({ error }) => {
        if (error) {
          console.warn(`[project-files] upload warning ${storagePath}: ${error.message}`);
        }
      });
  });

  await Promise.all(uploads);
}

// ── Download ──────────────────────────────────────────────────────────────────

/**
 * Download all files for a project from Supabase Storage.
 * Returns a map of relPath → content (e.g. { "src/App.tsx": "..." }).
 * Returns {} if the project has no stored files.
 */
export async function downloadProjectFiles(
  projectId: string,
): Promise<Record<string, string>> {
  await ensureBucket();
  const sb = getSupabaseAdmin();

  const paths = await listAllStorageFiles(sb, projectId);
  if (paths.length === 0) return {};

  const results = await Promise.all(
    paths.map(async (storagePath) => {
      const { data, error } = await sb.storage.from(BUCKET).download(storagePath);
      if (error || !data) {
        console.warn(`[project-files] download warning ${storagePath}: ${error?.message}`);
        return null;
      }
      const content = await data.text();
      // Strip the leading "{projectId}/" to recover the relative path
      const relPath = storagePath.slice(projectId.length + 1);
      return [relPath, content] as [string, string];
    }),
  );

  return Object.fromEntries(results.filter((r): r is [string, string] => r !== null));
}

// ── Recursive listing helper ──────────────────────────────────────────────────

/**
 * Recursively list all file paths under `prefix` in the project-files bucket.
 * Supabase Storage list() returns one level at a time; items with id===null
 * are pseudo-folders — we recurse into them.
 */
async function listAllStorageFiles(
  sb: SupabaseClient,
  prefix: string,
): Promise<string[]> {
  const { data, error } = await sb.storage
    .from(BUCKET)
    .list(prefix, { limit: 1000, sortBy: { column: "name", order: "asc" } });

  if (error || !data) return [];

  const paths: string[] = [];
  for (const item of data) {
    const fullPath = `${prefix}/${item.name}`;
    if (item.id === null) {
      // pseudo-folder — recurse
      paths.push(...await listAllStorageFiles(sb, fullPath));
    } else {
      // real file
      paths.push(fullPath);
    }
  }
  return paths;
}
