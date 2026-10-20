import { isPublicMcpAddress, resolvePublicMcpHostname, secureMcpFetch } from "../src/mcp/secure-fetch.js";

let checks = 0;
function check(label: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAIL ${label}`);
  console.log(`ok ${label}`);
}

check("public IPv4 is accepted", isPublicMcpAddress("8.8.8.8"));
for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "198.18.0.1", "224.0.0.1"]) {
  check(`${address} is rejected`, !isPublicMcpAddress(address));
}
check("public IPv6 is accepted", isPublicMcpAddress("2606:4700:4700::1111"));
for (const address of ["::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2001:10::1", "2002::1", "3fff::1"]) {
  check(`${address} is rejected`, !isPublicMcpAddress(address));
}

let unsafeDnsRejected = false;
try {
  await resolvePublicMcpHostname("attacker.example", async () => [
    { address: "93.184.216.34", family: 4 as const },
    { address: "127.0.0.1", family: 4 as const },
  ]);
} catch { unsafeDnsRejected = true; }
check("mixed public/private DNS answers fail closed", unsafeDnsRejected);

let metadataRejected = false;
try { await secureMcpFetch("https://metadata.google.internal/computeMetadata/v1"); }
catch { metadataRejected = true; }
check("cloud metadata host is rejected before connecting", metadataRejected);

let redirectUrlRejected = false;
try { await secureMcpFetch("https://127.0.0.1/latest/meta-data"); }
catch { redirectUrlRejected = true; }
check("private IP and metadata path are rejected", redirectUrlRejected);

console.log(`${checks} MCP SSRF checks passed`);

