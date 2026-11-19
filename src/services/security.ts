import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function resolveJwtSecret(): string {
  const envSecret = process.env.JWT_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    return envSecret;
  }

  // Generate and persist a random 256-bit CSPRNG secret in .data/jwt.secret (0600)
  // rather than deriving a predictable secret or crashing when JWT_SECRET isn't set.
  const dataDir = path.resolve(process.cwd(), '.data');
  const secretPath = path.join(dataDir, 'jwt.secret');
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }
    if (fs.existsSync(secretPath)) {
      const stored = fs.readFileSync(secretPath, 'utf8').trim();
      if (stored.length >= 32) {
        return stored;
      }
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, generated, { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}

const JWT_SECRET = resolveJwtSecret();

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_DAYS = 30; // 30 days
export const OTP_TTL_MINUTES = 10; // 10 minutes

export function timingSafeStringEqual(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB) && a.length === b.length;
}

export function hashSecret(raw: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(raw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `${salt}:${derived}`;
}

export function verifySecret(raw: string, stored: string): boolean {
  if (typeof raw !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, hashHex] = parts;
  if (!salt || !hashHex || !/^[0-9a-f]{128}$/i.test(hashHex)) return false;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(raw, salt, 64, { N: 16384, r: 8, p: 1 });
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function generateSixDigitOtp(): string {
  const num = crypto.randomInt(0, 1_000_000);
  return num.toString().padStart(6, '0');
}

export function generateOpaqueRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

type CouplovaTokenType = 'access' | 'google-pending' | 'email-confirm' | 'admin';

export interface AccessTokenPayload {
  tokenType: 'access';
  sub: string;
  sessionId: string;
  email: string;
  iat: number;
  exp: number;
}

export interface GooglePendingPayload {
  tokenType: 'google-pending';
  googleSub: string;
  email: string;
  fullName: string;
  exp: number;
}

export interface EmailConfirmPayload {
  tokenType: 'email-confirm';
  jti: string;
  sub: string;
  email: string;
  exp: number;
}

export interface AdminTokenPayload {
  tokenType: 'admin';
  role: 'owner';
  email: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function signJwtPayload(payloadObj: object): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify(payloadObj));
  const signature = base64UrlEncode(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

function verifySignedJwt<T extends { tokenType?: CouplovaTokenType; exp?: number }>(
  token: string,
  expectedType: CouplovaTokenType,
): T | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  if (!header || !payload || !sig) return null;

  const expectedSig = base64UrlEncode(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest(),
  );
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsedHeader = JSON.parse(base64UrlDecode(header)) as { alg?: string; typ?: string };
    if (!parsedHeader || typeof parsedHeader !== 'object') {
      return null;
    }
    if (parsedHeader.alg !== 'HS256' || parsedHeader.typ !== 'JWT') {
      return null;
    }

    const decoded = JSON.parse(base64UrlDecode(payload)) as T;
    if (!decoded || typeof decoded !== 'object') {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      decoded.tokenType !== expectedType ||
      typeof decoded.exp !== 'number' ||
      !Number.isFinite(decoded.exp) ||
      decoded.exp <= now
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function signAccessToken(
  userId: string,
  sessionId: string,
  email: string,
  ttlSeconds: number = ACCESS_TOKEN_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwtPayload({
    tokenType: 'access',
    sub: userId,
    sessionId,
    email,
    iat: now,
    exp: now + ttlSeconds,
  } satisfies AccessTokenPayload);
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  const decoded = verifySignedJwt<AccessTokenPayload>(token, 'access');
  if (!decoded || !decoded.sub || !decoded.sessionId || !decoded.email) {
    return null;
  }
  return decoded;
}

export function signGooglePendingToken(
  googleSub: string,
  email: string,
  fullName: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwtPayload({
    tokenType: 'google-pending',
    googleSub,
    email,
    fullName,
    exp: now + 15 * 60,
  } satisfies GooglePendingPayload);
}

export function verifyGooglePendingToken(token: string): GooglePendingPayload | null {
  const decoded = verifySignedJwt<GooglePendingPayload>(token, 'google-pending');
  if (!decoded || !decoded.googleSub || !decoded.email) {
    return null;
  }
  return decoded;
}

export function signEmailConfirmToken(
  userId: string,
  email: string,
  ttlSeconds: number = OTP_TTL_MINUTES * 60,
): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwtPayload({
    tokenType: 'email-confirm',
    jti: crypto.randomUUID(),
    sub: userId,
    email: email.trim().toLowerCase(),
    exp: now + ttlSeconds,
  } satisfies EmailConfirmPayload);
}

export function verifyEmailConfirmToken(token: string): EmailConfirmPayload | null {
  const decoded = verifySignedJwt<EmailConfirmPayload>(token, 'email-confirm');
  if (!decoded || !decoded.jti || !decoded.sub || !decoded.email) {
    return null;
  }
  return decoded;
}

export function signAdminToken(
  adminEmail: string,
  ttlSeconds: number = 60 * 60,
): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwtPayload({
    tokenType: 'admin',
    role: 'owner',
    email: adminEmail.trim().toLowerCase(),
    iat: now,
    exp: now + ttlSeconds,
  } satisfies AdminTokenPayload);
}

export function verifyAdminToken(token: string): AdminTokenPayload | null {
  const decoded = verifySignedJwt<AdminTokenPayload>(token, 'admin');
  if (!decoded || decoded.role !== 'owner' || !decoded.email) {
    return null;
  }
  return decoded;
}
