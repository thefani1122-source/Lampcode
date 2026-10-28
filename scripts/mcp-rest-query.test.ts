import { buildRestQueryTools, selectRestConnections } from "../src/mcp/rest-query-tools.js";
import { testRestConnection, type RestConnection } from "../src/mcp/rest-integrations.js";

let checks = 0;
function check(name: string, got: unknown, expected: unknown): void {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`FAIL ${name}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
  console.log(`ok ${name}`);
}
function ok(name: string, value: boolean): void { check(name, value, true); }

let observedUrl = "";
let observedMethod = "";
let observedAuthorization = "";
const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  observedUrl = String(input);
  observedMethod = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  observedAuthorization = headers.get("authorization") ?? headers.get("x-shopify-access-token") ?? "";
  return new Response(JSON.stringify({ id: "verified", user: { id: "verified" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const netlifyTest = await testRestConnection(
  "netlify",
  { netlify_token: "a-valid-test-token" },
  fakeFetch,
);
check("Netlify validates through its documented user endpoint", netlifyTest.ok, true);
check("Netlify test uses the fixed public API endpoint", observedUrl, "https://api.netlify.com/api/v1/user");
check("Netlify test sends Bearer authentication", observedAuthorization, "Bearer a-valid-test-token");
check("credential test is read-only", observedMethod, "GET");

const deniedFetch: typeof fetch = (async () => new Response(JSON.stringify({ message: "unauthorized" }), {
  status: 401,
  headers: { "content-type": "application/json" },
})) as typeof fetch;
const denied = await testRestConnection("netlify", { netlify_token: "bad-token-value" }, deniedFetch);
check("invalid credentials are not reported as connected", denied.ok, false);
ok("authentication error is safe and actionable", Boolean(denied.error?.includes("Authentication failed")));

const connections: RestConnection[] = [
  { slug: "netlify", credentials: { netlify_token: "netlify-token" }, meta: {} },
  { slug: "railway", credentials: { api_token: "railway-token" }, meta: {} },
  { slug: "wordpress", credentials: {
    wordpress_site_url: "https://example.wordpress.com",
    wordpress_username: "editor",
    wordpress_app_password: "wordpress-app-password",
  }, meta: {} },
];
check(
  "an explicit Vercel prompt does not attach competing REST deploy providers",
  selectRestConnections("check Vercel recent deployments", connections, ["vercel"]).map((c) => c.slug),
  [],
);
check(
  "an explicit Netlify prompt narrows to Netlify",
  selectRestConnections("check Netlify recent deployments", connections).map((c) => c.slug),
  ["netlify"],
);

const netlify = connections[0]!;
const query = buildRestQueryTools([netlify], fakeFetch);
check(
  "Netlify exposes only the supported read tools",
  query.tools.map((tool) => tool.name).sort(),
  ["netlify__list_deployments", "netlify__list_sites"],
);
const listSites = query.executors.get("netlify__list_sites");
ok("the advertised list-sites tool has an executor", Boolean(listSites));
if (listSites) {
  await listSites({ limit: 1000 });
  check("list-sites bounds a caller limit", observedUrl, "https://api.netlify.com/api/v1/sites?per_page=20");
  check("list-sites never mutates provider state", observedMethod, "GET");
}
const listDeployments = query.executors.get("netlify__list_deployments");
ok("the advertised deployment tool has an executor", Boolean(listDeployments));
if (listDeployments) {
  await listDeployments({ site_id: "site/with spaces", limit: 2 });
  check(
    "deployment site IDs are encoded and result limits are bounded",
    observedUrl,
    "https://api.netlify.com/api/v1/sites/site%2Fwith%20spaces/deploys?per_page=2",
  );
  check("deployment lookup is read-only", observedMethod, "GET");
}

console.log(`All ${checks} REST integration/query checks passed.`);
