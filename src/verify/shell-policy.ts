/**
 * What the agent may run in the sandbox, and what may come back out.
 *
 * `shell` is the only tool that can do something nobody designed. Every other
 * tool has a shape — write this file, check this page, read these logs — and
 * this one is "run whatever you like". So the policy is the tool: the executor
 * is twenty lines, and this file is the part that matters.
 *
 * TWO THINGS ARE BEING PROTECTED, and they are not the same thing.
 *
 * 1. THE SANDBOX. It is ephemeral and it is the user's own, so ordinary
 *    mischief inside the project directory is cheap — a broken file is fixed by
 *    writing it again. What is NOT cheap: reaching outside the project, taking
 *    away the tooling the rest of the harness depends on (`/home/user/.lampcode-tools`
 *    holds Playwright and the probes), or killing the thing serving the preview.
 *
 * 2. THE CREDENTIALS, which is the real one. The preview `.env` holds a live
 *    Supabase URL and anon key — and for a user who connected their own
 *    project, THEIR keys. `cat .env` would put those into the model's context,
 *    the websocket, the chat transcript and `build_messages`, all at once and
 *    irreversibly. That is why reading the environment is refused outright
 *    rather than approved, and why everything that does come back is redacted
 *    on the way out even when the command looked harmless.
 *
 * The tiers reuse `src/mcp/tiers.ts`: `read` and `sandbox` run without asking,
 * `approval` goes through the gate the MCP write proxies already use, and
 * `refused` never runs at all. An unrecognised command is `approval`, never
 * `read` — the same fail-closed rule as `tierFor(null)`.
 */

export type ShellTier = "read" | "sandbox" | "approval" | "refused";

export type ShellVerdict = {
  tier: ShellTier;
  /** Said to the model, and to the user on the approval card. */
  reason: string;
};

const STRICTNESS: Readonly<Record<ShellTier, number>> = {
  read: 0,
  sandbox: 1,
  approval: 2,
  refused: 3,
};

/**
 * Anything that reads the environment or a secret file.
 *
 * Refused rather than approved: an approval card asking "may I print your
 * database keys into the chat?" is not a question with a safe answer, and the
 * model has no legitimate need — `read_logs` shows it the backend's output and
 * the preview injects the env itself.
 */
const SECRET_READ = [
  /\b(?:printenv|env)\b(?!\s+[A-Z_]+=)/,
  /\bset\s*$/,
  /\$\{?(?:SUPABASE|DATABASE|REDIS|E2B|LLM|ANTHROPIC|OPENAI|PADDLE|STRIPE|AWS|GITHUB)[A-Z_]*\}?/i,
  /(?:cat|less|more|head|tail|bat|strings|xxd|od|base64|cp|mv|tar|zip)\b[^|;&]*\.env\b/,
  /\bgrep\b[^|;&]*\.env\b/,
  /\b(?:find|ls)\b[^|;&]*-name\s+['"]?\.env/,
  /\.env[^\s]*\s*(?:\||>)/,
  /\bcat\b[^|;&]*(?:id_rsa|\.pem|\.key|credentials|\.npmrc|\.git-credentials)/,
];

/** Sending anything anywhere. The sandbox needs no outbound network to build. */
const EGRESS = [
  /\b(?:curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|rsync|ftp)\b/,
  /\bnode\b[^;|&]*-e\b[^;|&]*(?:fetch|https?\.request|net\.connect)/,
  /\bpython3?\b[^;|&]*-c\b[^;|&]*(?:urllib|requests|socket)/,
];

/** Things that are not this sandbox's business. */
const OUT_OF_BOUNDS = [
  /\brm\b[^;|&]*\s\/(?:\s|$)/,
  /\brm\b[^;|&]*-[a-z]*r[a-z]*f[^;|&]*\s\/(?:\s|$)/,
  /\b(?:rm|mv|cp|chmod|chown|truncate|dd)\b[^;|&]*\s\/(?:etc|usr|bin|sbin|lib|boot|dev|proc|sys|var|root)\b/,
  /\.lampcode-tools\b/,
  /\b(?:mkfs|fdisk|parted)\b/,
  /\bdd\b[^;|&]*of=\/dev\//,
  /~\/\.ssh\b|\/root\b/,
];

/** Privilege, persistence, and getting out. */
const ESCALATION = [
  /\b(?:sudo|su|doas)\b/,
  /\b(?:crontab|systemctl|service|at|nohup|disown)\b/,
  /\bkill\b[^;|&]*\s-9\s+1\b/,
  /:\(\)\s*\{.*\}\s*;?\s*:/,
  /\bchmod\b[^;|&]*\s777\s+\//,
];

/** Using someone's identity, or publishing in their name. */
const IDENTITY = [
  /\bnpm\s+(?:publish|login|adduser|token)\b/,
  /\b(?:gh|git)\s+(?:auth|credential)\b/,
  /\bgit\s+push\b/,
  /\bgit\s+remote\s+(?:add|set-url)\b/,
];

/** Destructive, but only to this project — worth asking rather than refusing. */
const NEEDS_APPROVAL = [
  /\brm\b[^;|&]*-[a-z]*r/,
  /\bgit\s+(?:reset|clean|checkout|restore|revert|stash)\b/,
  /\bnpm\s+(?:install|i|uninstall|remove|add|ci|update)\b/,
  /\b(?:yarn|pnpm|bun)\s+(?:add|install|remove)\b/,
  /\b(?:pkill|killall)\b|\bkill\b/,
  /\bchmod\b|\bchown\b/,
  /\b(?:truncate|shred)\b/,
  />\s*\/dev\/(?!null)/,
];

/** Reading and looking. No prompt, and nothing changes. */
const READ_ONLY = [
  /^(?:ls|pwd|whoami|date|uptime|tree|stat|file|wc|du|df|ps|top|uname|which|type|realpath|basename|dirname|echo)\b/,
  /^(?:cat|head|tail|less|more|bat)\b/,
  /^(?:grep|rg|egrep|fgrep|find|fd|sed\s+-n|awk)\b/,
  /^(?:node|npm|npx|python3?|tsc)\s+(?:-v|--version)\b/,
  /^npm\s+(?:ls|list|view|outdated|config\s+get)\b/,
  /^git\s+(?:status|log|diff|show|branch|remote\s+-v|rev-parse)\b/,
];

/** Changes only the project, and the project is ours to change. No prompt. */
const SANDBOX_SAFE = [
  /^npm\s+(?:run|test|exec)\b/,
  /^(?:npx\s+)?(?:tsc|vitest|eslint|prettier)\b/,
  /^(?:mkdir|touch|cp|mv|ln)\b/,
  /^sed\s+-i\b/,
  /^(?:printf|echo)\b[^|;&]*>\s*[^/]/,
];

/**
 * Split a command line into the parts that each run on their own.
 *
 * `ls && cat .env` is two commands and the verdict has to be the stricter of
 * them — a policy that reads only the first word of a line is a policy that can
 * be walked straight past.
 */
export function shellSegments(command: string): string[] {
  return command
    .split(/\n|;|&&|\|\||\||&/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** `$(…)` and backticks can hide anything, including from this file. */
function hasSubstitution(command: string): boolean {
  return /\$\(|`/.test(command);
}

function classifyOne(segment: string): ShellVerdict {
  const s = segment.trim();
  if (s === "") return { tier: "read", reason: "empty" };

  if (SECRET_READ.some((re) => re.test(s))) {
    return {
      tier: "refused",
      reason:
        "that reads the environment or a secret file. The preview's .env holds live database " +
        "keys, and anything printed here goes into the chat and the build record. Use read_logs " +
        "for the backend's own output.",
    };
  }
  if (EGRESS.some((re) => re.test(s))) {
    return { tier: "refused", reason: "that sends data out of the sandbox. Use fetch_reference or web_search instead." };
  }
  if (OUT_OF_BOUNDS.some((re) => re.test(s))) {
    return { tier: "refused", reason: "that reaches outside the project directory, or removes the harness's own tooling." };
  }
  if (ESCALATION.some((re) => re.test(s))) {
    return { tier: "refused", reason: "that changes privileges or the machine itself, which no build needs." };
  }
  if (IDENTITY.some((re) => re.test(s))) {
    return { tier: "refused", reason: "that acts as the user somewhere outside this sandbox. deploy_app and the connected-service tools exist for that, behind their own approval." };
  }
  if (NEEDS_APPROVAL.some((re) => re.test(s))) {
    return { tier: "approval", reason: "it deletes, installs or changes something in the project" };
  }
  if (READ_ONLY.some((re) => re.test(s))) return { tier: "read", reason: "reads only" };
  if (SANDBOX_SAFE.some((re) => re.test(s))) return { tier: "sandbox", reason: "changes only this project" };

  // Unrecognised. Fail closed, exactly as tierFor(null) does: nothing proved it
  // safe, and "I have not seen this before" is not a reason to run it quietly.
  return { tier: "approval", reason: "this command is not one the policy recognises" };
}

/** The verdict for a whole command line: the strictest of its parts. */
export function classifyShellCommand(command: string): ShellVerdict {
  if (typeof command !== "string" || command.trim() === "") {
    return { tier: "refused", reason: "no command was given" };
  }
  if (command.length > 2000) {
    return { tier: "refused", reason: "that command is too long to read, and nothing a build needs is that long" };
  }
  if (hasSubstitution(command)) {
    return {
      tier: "refused",
      reason:
        "command substitution ($(…) or backticks) can hide anything from this check, including " +
        "a read of the environment. Write the command out in full.",
    };
  }

  let worst: ShellVerdict = { tier: "read", reason: "reads only" };
  for (const segment of shellSegments(command)) {
    const verdict = classifyOne(segment);
    if (STRICTNESS[verdict.tier] > STRICTNESS[worst.tier]) worst = verdict;
  }
  return worst;
}

// ── What may come back out ───────────────────────────────────────────────────

/**
 * Shapes that are a credential wherever they appear.
 *
 * Kept alongside the exact-value replacement rather than instead of it: the
 * exact values catch this sandbox's own keys, and these catch the ones nobody
 * told us about — a key the generated app wrote, a token in a log line, a
 * connection string in an error message.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{10,}/g,
  /\bABSK[A-Za-z0-9+/=]{12,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/g,
  /mongodb(?:\+srv)?:\/\/[^\s:@]+:[^\s@]+@/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export type RedactionResult = { text: string; redacted: number; truncated: boolean };

/** How much of a command's output is worth a round. */
const MAX_OUTPUT_CHARS = 6000;

/**
 * Take the secrets out before the output becomes a tool result.
 *
 * `known` is this sandbox's own values — the preview Supabase URL and key, and
 * whatever else was injected — matched exactly, because a key is a key whatever
 * shape it has. Short values are skipped: replacing every occurrence of a
 * three-character env value would turn the output into confetti.
 */
export function redactShellOutput(raw: string, known: readonly string[] = []): RedactionResult {
  if (typeof raw !== "string" || raw === "") return { text: "", redacted: 0, truncated: false };

  let redacted = 0;
  let text = raw;

  for (const value of known) {
    if (typeof value !== "string" || value.length < 8) continue;
    const parts = text.split(value);
    if (parts.length > 1) {
      redacted += parts.length - 1;
      text = parts.join("[redacted]");
    }
  }

  for (const shape of SECRET_SHAPES) {
    shape.lastIndex = 0;
    text = text.replace(shape, () => {
      redacted += 1;
      return "[redacted]";
    });
  }

  let truncated = false;
  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n… output cut here (${text.length - MAX_OUTPUT_CHARS} more characters)`;
    truncated = true;
  }

  return { text, redacted, truncated };
}
