/**
 * Deterministic helpers for evidence produced by the real E2B browser.
 * Capture success is not a design-quality score; subjective review stays human.
 */
export type EvalViewport = "desktop" | "mobile";
export type ScreenshotEvidence = { path: string; width: number; height: number; bytes: number };
export type EvalVisualEvidence = {
  verdict: "not-requested" | "captured" | "partial" | "unavailable";
  screenshots: Partial<Record<EvalViewport, ScreenshotEvidence>>;
  reason?: string;
};
export type VisualReviewTask = {
  taskId: string;
  title: string;
  screenshots: Partial<Record<EvalViewport, Pick<ScreenshotEvidence, "path" | "width" | "height">>>;
  scores: {
    productFit: number | null;
    visualHierarchy: number | null;
    contentDensity: number | null;
    designConsistency: number | null;
    responsiveLayout: number | null;
  };
  notes: string;
};
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Read PNG dimensions from the IHDR without decoding or re-encoding the image. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  if (bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13) return null;
  if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return null;
  const readU32 = (offset: number): number =>
    (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
  const width = readU32(16);
  const height = readU32(20);
  if (width < 1 || height < 1 || width > 20_000 || height > 20_000) return null;
  return { width, height };
}

/** Build a 1–5 human-review template. Null means the screenshot is not reviewed yet. */
export function makeVisualReviewTemplate(
  results: Array<{ taskId: string; title: string; visual?: EvalVisualEvidence }>,
): {
  rubricVersion: 1;
  scale: string;
  rubric: Record<string, string>;
  tasks: VisualReviewTask[];
} {
  const tasks = results
    .filter((r) => r.visual && Object.keys(r.visual.screenshots).length > 0)
    .map((r): VisualReviewTask => {
      const screenshots: VisualReviewTask["screenshots"] = {};
      for (const viewport of ["desktop", "mobile"] as const) {
        const shot = r.visual?.screenshots[viewport];
        if (shot) screenshots[viewport] = { path: shot.path, width: shot.width, height: shot.height };
      }
      return {
        taskId: r.taskId,
        title: r.title,
        screenshots,
        scores: {
          productFit: null,
          visualHierarchy: null,
          contentDensity: null,
          designConsistency: null,
          responsiveLayout: null,
        },
        notes: "",
      };
    });
  return {
    rubricVersion: 1,
    scale: "Score each dimension from 1 (poor) to 5 (excellent); leave null until reviewed.",
    rubric: {
      productFit: "Does the layout and main working surface fit this product and its primary task?",
      visualHierarchy: "Are the primary action, page structure and important information immediately clear?",
      contentDensity: "Is the screen usefully populated without clutter or accidental empty regions?",
      designConsistency: "Are typography, spacing, colors, controls and surfaces coherent?",
      responsiveLayout: "At 390px, does the layout reflow cleanly with readable content and usable controls?",
    },
    tasks,
  };
}
