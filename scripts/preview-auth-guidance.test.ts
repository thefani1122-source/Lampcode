import { formatPreviewEmailConfirmationGuidance } from "../src/verify/preview-auth-guidance.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log("✔ " + name);
    return;
  }
  failures++;
  console.log("✘ " + name + "\n    got:  " + JSON.stringify(got) + "\n    want: " + JSON.stringify(want));
}
function ok(name: string, condition: boolean): void {
  check(name, condition, true);
}

check("no connected Supabase means no preview warning", formatPreviewEmailConfirmationGuidance({
  "src/auth.ts": "import { createClient } from '@supabase/supabase-js';\nsupabase.auth.signUp({ email, password });",
}, false), null);
check("OAuth-only auth does not get email-confirmation guidance", formatPreviewEmailConfirmationGuidance({
  "src/auth.ts": "import { createClient } from '@supabase/supabase-js';\nsupabase.auth.signInWithOAuth({ provider: 'google' });",
}, true), null);
check("email-only OTP sign-up does not get password guidance", formatPreviewEmailConfirmationGuidance({
  "src/auth.ts": "import { createClient } from '@supabase/supabase-js';\nsupabase.auth.signUp({ email });",
}, true), null);
check("non-Supabase email/password sign-up is not misidentified", formatPreviewEmailConfirmationGuidance({
  "src/auth.ts": "customAuth.auth.signUp({ email, password });",
}, true), null);

const guidance = formatPreviewEmailConfirmationGuidance({
  "src/client.ts": "import { createClient } from '@supabase/supabase-js';",
  "src/auth.ts": "await supabase.auth.signUp({ email, password });",
}, true);
ok("email/password Supabase sign-up receives the preview warning", guidance !== null);
ok("guidance gives the dashboard path and setting name", guidance?.includes(
  "Authentication → Sign In / Providers → Email and switch off Confirm email",
) ?? false);
ok("guidance explains the changing URL and asks to restore confirmation before launch",
  guidance?.includes("changes with each build") === true &&
  guidance.includes("turn Confirm email back on before launch"));
check("comment-only signup example is ignored", formatPreviewEmailConfirmationGuidance({
  "src/client.ts": "import { createClient } from '@supabase/supabase-js';",
  "src/auth.ts": "// supabase.auth.signUp({ email, password });",
}, true), null);
check("test files are ignored", formatPreviewEmailConfirmationGuidance({
  "src/client.ts": "import { createClient } from '@supabase/supabase-js';",
  "src/auth.test.ts": "supabase.auth.signUp({ email, password });",
}, true), null);

if (failures > 0) {
  console.error(`\n${failures} preview auth guidance test(s) failed.`);
  process.exit(1);
}
console.log("\nAll preview auth guidance cases passed.");
