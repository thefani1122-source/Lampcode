export interface BuildClassification {
  buildType: "frontend" | "fullstack";
  framework: "react" | "nextjs" | "tanstack";
  database: "supabase" | "mongodb" | "none";
  needsAuth: boolean;
  reason: string;
}

// Keyword-based classifier — no LLM call, instant synchronous result.
export function classifyBuild(prompt: string): Promise<BuildClassification> {
  // Framework is pinned to "react" on purpose. The Next.js and TanStack Start
  // E2B templates were never built — selectTemplate() still carries the TODOs
  // for them (e2b-service.ts:46,49) and silently falls back to the Vite
  // template, so returning either value here produced a sandbox that could not
  // boot: `npm run dev` with no Next.js installed, a readiness poll against
  // :3000 when Vite serves :5173, and an expected entry point (app/page.tsx)
  // the generator was told to write but the template can't serve.
  // NEXTJS_TEMPLATE_ID/TANSTACK_TEMPLATE_ID being set is NOT a safe signal to
  // re-enable on — they are populated in production but point at no real
  // template. Restore the detection only once a template actually builds.
  const framework: BuildClassification["framework"] = "react";
  // The keywords still count toward the fullstack decision below — asking for
  // "a Next.js dashboard" is a backend-shaped request even though we serve it
  // from the React template.
  const mentionsServerFramework = /next\.?js|tanstack/i.test(prompt);

  // Fullstack detection: explicit backend/auth/data keywords OR non-React framework
  // 3D/animation/WebGL keywords also route to E2B (where Three.js, Spline, tsParticles are pre-installed)
  const isFullstack =
    mentionsServerFramework ||
    /\b(login|signin|sign[- ]in|sign[- ]up|signup|auth(?:entication|orization)?|user[- ]account|user[- ]profile|register(?:ation)?|logout|sign[- ]out|oauth|jwt|session|password|credential|admin[- ]panel|dashboard.with.real.data|save.to.database|persist(?:ence|ent)?|real.database|supabase|mongodb|postgresql|postgres|sqlite|mysql|graphql|backend|hono|fastapi|api.routes?|rest.api|multiple.users?|multi[- ]user|real[- ]time|payments?|stripe|file.uploads?|crud|cloud.sync|three\.?js|threejs|webgl|react[- ]three|r3f|@react-three|spline|splinecode|tsparticles|gsap.scroll|scrolltrigger|parallax|canvas.animation|3d.scene|3d.model|3d.website|immersive|webgl.shader)\b/i.test(prompt);

  // Database detection
  const database: BuildClassification["database"] = isFullstack
    ? /\bmongo(?:db)?\b/i.test(prompt) ? "mongodb" : "supabase"
    : "none";

  // Auth detection
  const needsAuth = /\b(auth(?:entication)?|login|signin|sign[- ]in|sign[- ]up|signup|register|logout|user[- ]account|admin[- ]panel)\b/i.test(prompt);

  const buildType = isFullstack ? "fullstack" : "frontend";
  const reason = isFullstack
    ? "keyword match: backend/auth/data features detected"
    : "no backend keywords — defaulting to frontend";

  return Promise.resolve({ buildType, framework, database, needsAuth, reason });
}
