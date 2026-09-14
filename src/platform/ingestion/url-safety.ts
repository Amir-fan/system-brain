/**
 * @kip
 * @module platform
 * @layer platform
 * @owner platform-infra
 * @feature K0-012
 * @purpose SSRF guard for server-side URL acquisition.
 *
 * Rejects non-http(s) schemes, loopback/private/link-local/metadata targets and
 * resolvable private addresses. DNS resolution is injectable so the rules are
 * unit-testable without network access. Every redirect hop is re-validated.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { IngestionFailure } from '../../core/ingestion/ingestion.types.ts';

export interface UrlSafetyDeps {
  /** Resolves a hostname to its addresses (defaults to dns.promises.lookup). */
  resolve?: (hostname: string) => Promise<string[]>;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'instance-data',
  '169.254.169.254',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/** True when the address sits inside the CIDR block (modular, no bit ops). */
function inRange(value: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const bits = Number(bitsRaw);
  const size = bits <= 0 ? 4294967296 : Math.pow(2, 32 - bits);
  return Math.floor(value / size) === Math.floor(baseInt / size);
}

/** IPv4 ranges that must never be fetched from the server. */
const BLOCKED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

export function isBlockedIp(ip: string): boolean {
  const host = ip.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

  // IPv4-mapped IPv6 (::ffff:127.0.0.1)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) return isBlockedIp(mapped[1]);

  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link local

  const v4 = ipv4ToInt(host);
  if (v4 !== null) return BLOCKED_V4.some((cidr) => inRange(v4, cidr));

  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (ipv4ToInt(host) !== null) return isBlockedIp(host);
  return false;
}

const defaultResolve = async (hostname: string): Promise<string[]> => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

/**
 * Validates a URL for server-side fetching. Throws IngestionFailure with a typed
 * code: URL_INVALID for malformed urls, URL_BLOCKED for private/metadata targets.
 */
export async function assertUrlAllowed(rawUrl: string, deps: UrlSafetyDeps = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new IngestionFailure('URL_INVALID');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new IngestionFailure('URL_BLOCKED');
  if (!url.hostname) throw new IngestionFailure('URL_INVALID');
  if (url.username || url.password) throw new IngestionFailure('URL_BLOCKED');
  if (isBlockedHostname(url.hostname)) throw new IngestionFailure('URL_BLOCKED');

  const resolve = deps.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(url.hostname);
  } catch {
    throw new IngestionFailure('URL_FETCH_FAILED');
  }
  if (addresses.length === 0) throw new IngestionFailure('URL_FETCH_FAILED');
  for (const address of addresses) {
    if (isBlockedIp(address)) throw new IngestionFailure('URL_BLOCKED');
  }
  return url;
}
