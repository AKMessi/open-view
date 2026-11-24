import dns from 'node:dns/promises';
import net from 'node:net';

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let val = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    val = (val * 256) + n;
  }
  return val >>> 0;
}

function inCidrV4(ipNum: number, baseIp: string, prefixLen: number): boolean {
  const baseNum = ipv4ToUint32(baseIp);
  if (baseNum === null) return false;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

/**
 * Returns true if the given IPv4 or IPv6 address belongs to loopback, RFC1918 private,
 * link-local / cloud metadata, CGNAT, multicast, unspecified, or IPv4-mapped private space.
 */
export function isBlockedIp(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const version = net.isIP(ip);
  if (version === 0) return true; // Reject malformed IPs conservatively

  if (version === 4) {
    const n = ipv4ToUint32(ip);
    if (n === null) return true;
    return (
      inCidrV4(n, '0.0.0.0', 8) ||        // Current network / unspecified
      inCidrV4(n, '10.0.0.0', 8) ||       // RFC1918 private
      inCidrV4(n, '100.64.0.0', 10) ||    // CGNAT (RFC6598)
      inCidrV4(n, '127.0.0.0', 8) ||      // Loopback
      inCidrV4(n, '169.254.0.0', 16) ||   // Link-local & AWS/GCP/Azure metadata
      inCidrV4(n, '172.16.0.0', 12) ||    // RFC1918 private
      inCidrV4(n, '192.0.0.0', 24) ||     // IETF protocol assignments
      inCidrV4(n, '192.0.2.0', 24) ||     // TEST-NET-1
      inCidrV4(n, '192.168.0.0', 16) ||   // RFC1918 private
      inCidrV4(n, '198.18.0.0', 15) ||    // Benchmark
      inCidrV4(n, '224.0.0.0', 4) ||      // Multicast
      inCidrV4(n, '240.0.0.0', 4)         // Reserved / broadcast
    );
  }

  // IPv6 checks
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) {
      return isBlockedIp(mapped);
    }
    // Hex-encoded IPv4-mapped e.g. ::ffff:7f00:0001
    const hexParts = mapped.split(':');
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0] ?? '', 16);
      const lo = parseInt(hexParts[1] ?? '', 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const dotted = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
        return isBlockedIp(dotted);
      }
    }
    return true;
  }

  // Expand first hextet
  const firstHextetStr = ip.split(':')[0] ?? '';
  const firstHextet = firstHextetStr === '' ? 0 : parseInt(firstHextetStr, 16);
  if (!Number.isFinite(firstHextet)) return true;

  // Unique local fc00::/7 (0xfc00..0xfdff)
  if ((firstHextet & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10 (0xfe80..0xfebf)
  if ((firstHextet & 0xffc0) === 0xfe80) return true;
  // Multicast ff00::/8
  if ((firstHextet & 0xff00) === 0xff00) return true;

  return false;
}

export interface SafeResolvedTarget {
  url: URL;
  resolvedIp: string;
  family: 4 | 6;
}

/**
 * Validates URL scheme (http/https only) and resolves DNS once, rejecting any private/loopback/metadata IP.
 */
export async function resolveAndValidateWebhookUrl(
  rawUrl: string,
  lookupFn: (hostname: string) => Promise<Array<{ address: string; family: number }>> = (h) =>
    dns.lookup(h, { all: true }),
): Promise<SafeResolvedTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid webhook URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Disallowed webhook scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) {
    throw new Error('Webhook URL missing hostname');
  }

  // Literal IP hostname
  const literalVersion = net.isIP(hostname);
  if (literalVersion === 4 || literalVersion === 6) {
    if (isBlockedIp(hostname)) {
      throw new Error(`SSRF blocked literal IP: ${hostname}`);
    }
    return { url: parsed, resolvedIp: hostname, family: literalVersion };
  }

  const records = await lookupFn(hostname);
  if (records.length === 0) {
    throw new Error(`DNS resolution returned no records for ${hostname}`);
  }

  // Reject if ANY resolved record points into blocked space (prevents multi-A-record bypass)
  for (const rec of records) {
    if (isBlockedIp(rec.address)) {
      throw new Error(`SSRF blocked resolved IP ${rec.address} for host ${hostname}`);
    }
  }

  const first = records[0]!;
  return {
    url: parsed,
    resolvedIp: first.address,
    family: first.family === 6 ? 6 : 4,
  };
}
