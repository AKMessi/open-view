import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export interface SecurityPolicy {
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  allowEmptyOriginForDirectHttp: boolean;
}

export function createDefaultSecurityPolicy(port = 4001, webPort = 5173): SecurityPolicy {
  const extraOrigins = (process.env.OPENVIEW_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const extraHosts = (process.env.OPENVIEW_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return {
    allowedHosts: new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      '127.0.0.1',
      'localhost',
      ...extraHosts,
    ]),
    allowedOrigins: new Set([
      `http://127.0.0.1:${webPort}`,
      `http://localhost:${webPort}`,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...extraOrigins,
    ]),
    allowEmptyOriginForDirectHttp: true,
  };
}

export function validateHostHeader(
  hostHeader: string | undefined,
  policy: SecurityPolicy,
): { ok: boolean; reason?: string } {
  if (!hostHeader) {
    return { ok: false, reason: 'Missing Host header' };
  }
  const normalized = hostHeader.trim().toLowerCase();
  if (!policy.allowedHosts.has(normalized)) {
    return { ok: false, reason: `Disallowed Host header: ${normalized}` };
  }
  return { ok: true };
}

export function validateOriginHeader(
  originHeader: string | undefined,
  policy: SecurityPolicy,
  requireOrigin: boolean,
): { ok: boolean; reason?: string } {
  if (!originHeader) {
    if (requireOrigin || !policy.allowEmptyOriginForDirectHttp) {
      return { ok: false, reason: 'Missing Origin header' };
    }
    return { ok: true };
  }
  const normalized = originHeader.trim();
  if (!policy.allowedOrigins.has(normalized)) {
    return { ok: false, reason: `Disallowed Origin header: ${normalized}` };
  }
  return { ok: true };
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

interface WsTicketRecord {
  expiresAt: number;
}

export const SESSION_COOKIE_NAME = 'openview_sid';
export const CSRF_HEADER_NAME = 'x-openview-token';

export class SessionGuard {
  private readonly sessionToken: string;
  private readonly wsTickets = new Map<string, WsTicketRecord>();
  private readonly wsTicketTtlMs: number;

  constructor(wsTicketTtlMs = 30_000) {
    this.sessionToken = crypto.randomBytes(32).toString('base64url');
    this.wsTicketTtlMs = wsTicketTtlMs;
  }

  getToken(): string {
    return this.sessionToken;
  }

  buildSetCookieHeader(): string {
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(this.sessionToken)}; Path=/; HttpOnly; SameSite=Strict`;
  }

  verifyHttpAuth(headers: IncomingHttpHeaders): boolean {
    const headerToken = headers[CSRF_HEADER_NAME];
    if (typeof headerToken === 'string' && timingSafeEqualStr(headerToken, this.sessionToken)) {
      return true;
    }
    const cookies = parseCookieHeader(headers.cookie);
    const cookieToken = cookies[SESSION_COOKIE_NAME];
    if (cookieToken && timingSafeEqualStr(cookieToken, this.sessionToken)) {
      return true;
    }
    return false;
  }

  issueWsTicket(): { ticket: string; expiresAt: number } {
    this.pruneExpiredTickets();
    const ticket = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + this.wsTicketTtlMs;
    this.wsTickets.set(ticket, { expiresAt });
    return { ticket, expiresAt };
  }

  consumeWsTicket(ticket: string | null | undefined): boolean {
    this.pruneExpiredTickets();
    if (!ticket) return false;
    const rec = this.wsTickets.get(ticket);
    if (!rec) return false;
    // One-time use
    this.wsTickets.delete(ticket);
    return rec.expiresAt >= Date.now();
  }

  private pruneExpiredTickets(): void {
    const now = Date.now();
    for (const [k, v] of this.wsTickets.entries()) {
      if (v.expiresAt < now) {
        this.wsTickets.delete(k);
      }
    }
  }
}
