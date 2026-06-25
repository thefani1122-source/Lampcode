export interface BuildClassification {
  buildType: "frontend" | "fullstack";
  framework: "react" | "nextjs" | "tanstack";
  database: "supabase" | "mongodb" | "none";
  needsAuth: boolean;
  reason: string;
}

// Keyword-based classifier — no LLM call, instant synchronous result.
export function classifyBuild(prompt: string): Promise<BuildClassification> {
  // Framework detection (must run first — nextjs/tanstack imply fullstack)
  let framework: BuildClassification["framework"] = "react";
  if (/next\.?js/i.test(prompt)) framework = "nextjs";
  else if (/tanstack/i.test(prompt)) framework = "tanstack";

  // Fullstack detection: explicit backend/auth/data keywords OR non-React framework
  // 3D/animation/WebGL keywords also route to E2B (where Three.js, Spline, tsParticles are pre-installed)
  const isFullstack =
    framework !== "react" ||
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
