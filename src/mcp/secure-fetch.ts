import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInfo as UndiciRequestInfo, type RequestInit as UndiciRequestInit } from "undici";

function privateIpv4(address: string): boolean {
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || a! >= 224 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

function privateIpv6(address: string): boolean {
  const ip = address.toLowerCase().split("%", 1)[0]!;
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice(7);
    if (isIP(mapped) === 4) return privateIpv4(mapped);
    return true;
  }
  // Permit only global unicast (2000::/3); reject ULA, link-local, loopback,
  // unspecified, multicast, documentation, 6to4 and benchmarking prefixes.
  if (!(ip.startsWith("2") || ip.startsWith("3"))) return true;
  const secondHextet = Number.parseInt(ip.split(":")[1] || "0", 16);
  return ip.startsWith("2001:db8:") || ip.startsWith("2001:2:") ||
    (ip.startsWith("2001:") && secondHextet <= 0x1ff) ||
    ip.startsWith("2002:") || ip.startsWith("3fff:");
}

export function isPublicMcpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !privateIpv4(address);
  if (family === 6) return !privateIpv6(address);
  return false;
}

const BLOCKED_METADATA_HOSTS = new Set([
  "metadata", "metadata.google.internal", "metadata.azure.internal",
  "instance-data", "instance-data.ec2.internal",
]);

function parseUrl(input: string | URL): URL {
  const raw = input instanceof URL ? input.href : input;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("MCP endpoint must be a public HTTPS URL");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_METADATA_HOSTS.has(host) || host.endsWith(".metadata.google.internal")) {
    throw new Error("MCP endpoint host is not allowed");
  }
  if (url.pathname.startsWith("/latest/meta-data") || url.pathname.startsWith("/computeMetadata/v1")) {
    throw new Error("MCP endpoint path is not allowed");
  }
  return url;
}

export async function resolvePublicMcpHostname(
  hostname: string,
  resolver: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>> = async (host) =>
    lookup(host, { all: true, verbatim: true }) as Promise<Array<{ address: string; family: 4 | 6 }>>,
) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicMcpAddress(host)) throw new Error("MCP endpoint resolves to a non-public address");
    return [{ address: host, family: isIP(host) as 4 | 6 }];
  }
  const addresses = await resolver(host);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicMcpAddress(address))) {
    throw new Error("MCP endpoint resolves to a non-public address");
  }
  return addresses;
}

const resolvePublic = resolvePublicMcpHostname;

// The socket lookup is the final check and pins the connection to the checked
// answer. This closes the DNS-rebinding gap between validation and connect.
const dispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      void resolvePublic(hostname).then((addresses) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      }, (error: Error) => callback(error, "", 0));
    },
  },
});

export async function secureMcpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = parseUrl(input);
  await resolvePublic(url.hostname);
  const headers = new Headers(init?.headers);
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  }
  // Manual redirects let the MCP SDK enforce its same-origin policy. Every
  // follow-up request re-enters this wrapper and the pinned socket lookup.
  return await undiciFetch(input as UndiciRequestInfo, {
    ...(init as unknown as UndiciRequestInit),
    headers,
    redirect: "manual",
    dispatcher,
  } as UndiciRequestInit & { dispatcher: Agent }) as unknown as Response;
}

