import {
  makeVisualReviewTemplate,
  pngDimensions,
  type EvalVisualEvidence,
} from "./browser-evidence.js";

let failures = 0;
function check(name: string, got: unknown, expected: unknown): void {
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    failures++;
    console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(expected)}`);
  } else {
    console.log(`✔ ${name}`);
  }
}

function fakePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([73, 72, 68, 82], 12);
  const write = (offset: number, value: number): void => {
    bytes[offset] = (value >>> 24) & 255;
    bytes[offset + 1] = (value >>> 16) & 255;
    bytes[offset + 2] = (value >>> 8) & 255;
    bytes[offset + 3] = value & 255;
  };
  write(16, width);
  write(20, height);
  return bytes;
}

check("PNG IHDR dimensions are read without decoding the image", pngDimensions(fakePng(1280, 800)), {
  width: 1280,
  height: 800,
});
check("mobile PNG dimensions are retained exactly", pngDimensions(fakePng(390, 844)), {
  width: 390,
  height: 844,
});
check("invalid PNG signature is rejected", pngDimensions(new Uint8Array(24)), null);
const malformed = fakePng(390, 844);
malformed[12] = 0;
check("non-IHDR first chunks are rejected", pngDimensions(malformed), null);
check("zero-sized images are rejected", pngDimensions(fakePng(0, 844)), null);

const desktopMobile: EvalVisualEvidence = {
  verdict: "captured",
  screenshots: {
    desktop: { path: "eval-results/visuals/session-desktop.png", width: 1280, height: 800, bytes: 12345 },
    mobile: { path: "eval-results/visuals/session-mobile.png", width: 390, height: 844, bytes: 9876 },
  },
};
const template = makeVisualReviewTemplate([
  { taskId: "counter", title: "Counter", visual: desktopMobile },
  { taskId: "unavailable", title: "No preview", visual: { verdict: "unavailable", screenshots: {} } },
  { taskId: "not-requested", title: "Skipped" },
]);
check("the review template includes only tasks with screenshot evidence", template.tasks.map((t) => t.taskId), ["counter"]);
check("desktop and mobile evidence paths are preserved", template.tasks[0]?.screenshots, {
  desktop: { path: "eval-results/visuals/session-desktop.png", width: 1280, height: 800 },
  mobile: { path: "eval-results/visuals/session-mobile.png", width: 390, height: 844 },
});
check("visual scores start as unreviewed rather than fabricated", template.tasks[0]?.scores, {
  productFit: null,
  visualHierarchy: null,
  contentDensity: null,
  designConsistency: null,
  responsiveLayout: null,
});
check("visual rubric explicitly separates product fit and responsiveness", Object.keys(template.rubric), [
  "productFit", "visualHierarchy", "contentDensity", "designConsistency", "responsiveLayout",
]);

console.log(failures === 0 ? "\nall cases passed" : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
