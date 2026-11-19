import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  OTP_TTL_MINUTES,
  REFRESH_TOKEN_TTL_DAYS,
  generateOpaqueRefreshToken,
  generateSixDigitOtp,
  hashRefreshToken,
  hashSecret,
  signAccessToken,
  signAdminToken,
  signEmailConfirmToken,
  signGooglePendingToken,
  timingSafeStringEqual,
  verifyAccessToken,
  verifyAdminToken,
  verifyEmailConfirmToken,
  verifyGooglePendingToken,
  verifySecret,
} from './src/services/security';
import {
  getDatabaseHealth,
  initDatabase,
  loadDatabase,
  mutateDatabase,
  type CouplyDatabase,
  type DbOtpCode,
  type DbSession,
  type DbUser,
} from './src/services/store';
import {
  buildAdminOtpEmailTemplate,
  buildConfirmEmailTemplate,
  buildLoginOtpEmailTemplate,
  buildWelcomeEmailTemplate,
  dispatchTransactionalEmail,
} from './src/services/emails';
import {
  MAX_OTP_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  THIRTY_DAYS_MS,
  getPasswordErrorMessage,
  isSessionInactiveExpired,
  isValidDateOfBirth,
  isValidEmail,
} from './src/utils/gameLogic';
import { GAME_DECKS } from './src/constants/decks';
import type { ActiveDeckThemeId, GenderTheme } from './src/constants/theme';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

const VALID_CARD_IDS = new Set<string>(
  GAME_DECKS.flatMap((deck) => deck.cards.map((card) => card.id)),
);
const VALID_DECK_IDS = new Set<string>(GAME_DECKS.map((deck) => deck.id));

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL?.trim() || 'daveking248@gmail.com').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD?.trim() || '';

function resolveGoogleClientId(): string | null {
  const raw = (
    process.env.GOOGLE_CLIENT_ID ||
    process.env.VITE_GOOGLE_CLIENT_ID ||
    ''
  ).trim();
  const clean =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1).trim()
      : raw;
  if (!clean || clean.includes('xxxxxxxxxxxx')) {
    return null;
  }
  return clean;
}

function sanitizePlainText(input: string, maxLen: number): string {
  return input
    .replace(/[\x00-\x1F\x7F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

interface AuthedRequest extends Request {
  auth?: {
    userId: string;
    sessionId: string;
    email: string;
  };
  adminAuth?: {
    email: string;
  };
}

function resolveAppUrl(): string {
  const configured = process.env.APP_URL?.trim();
  if (
    configured &&
    configured !== 'MY_APP_URL' &&
    (configured.startsWith('https://') || configured.startsWith('http://'))
  ) {
    return configured.replace(/\/+$/, '');
  }
  return `http://localhost:${PORT}`;
}

// Memory-bounded sliding-window rate limiter
function createRateLimiter(options: { windowMs: number; maxRequests: number; message: string }) {
  const hits = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - options.windowMs;

    const recent = (hits.get(key) || []).filter((ts) => ts > cutoff);
    if (recent.length >= options.maxRequests) {
      const oldest = recent[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + options.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: options.message,
        retryAfterSeconds,
      });
      return;
    }

    recent.push(now);
    hits.set(key, recent);

    if (hits.size > 5000) {
      for (const [k, timestamps] of hits.entries()) {
        const filtered = timestamps.filter((ts) => ts > cutoff);
        if (filtered.length === 0) {
          hits.delete(k);
        } else {
          hits.set(k, filtered);
        }
      }
    }

    next();
  };
}

// Per-account failed password attempt lockout (5 wrong passwords -> 15-min cooldown)
const FAILED_LOGIN_MAX = 5;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const failedLoginAttempts = new Map<string, { count: number; resetAt: number }>();

function getAccountLoginLockRemainingSeconds(email: string): number {
  const entry = failedLoginAttempts.get(email);
  if (!entry) return 0;
  if (Date.now() >= entry.resetAt) {
    failedLoginAttempts.delete(email);
    return 0;
  }
  if (entry.count >= FAILED_LOGIN_MAX) {
    return Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
  }
  return 0;
}

function recordFailedLoginAttempt(email: string): void {
  const now = Date.now();
  const existing = failedLoginAttempts.get(email);
  if (!existing || now >= existing.resetAt) {
    failedLoginAttempts.set(email, { count: 1, resetAt: now + FAILED_LOGIN_WINDOW_MS });
  } else {
    existing.count += 1;
    existing.resetAt = now + FAILED_LOGIN_WINDOW_MS;
  }
  if (failedLoginAttempts.size > 5000) {
    for (const [k, v] of failedLoginAttempts.entries()) {
      if (now >= v.resetAt) failedLoginAttempts.delete(k);
    }
  }
}

function clearFailedLoginAttempts(email: string): void {
  failedLoginAttempts.delete(email);
}

function sanitizeUser(user: DbUser) {
  return {
    id: user.id,
    fullName: user.full_name,
    username: user.username,
    email: user.email,
    country: user.country,
    dateOfBirth: user.date_of_birth,
    partnerName: user.partner_name,
    genderTheme: user.gender_theme,
    activeDeckTheme: user.active_deck_theme,
    isVerified: user.is_verified,
    lastSeenAt: user.last_seen_at,
    createdAt: user.created_at,
  };
}

async function sendOtpEmail(params: {
  userId: string;
  email: string;
  partnerName: string;
  code: string;
  purpose: 'signup' | 'login';
}): Promise<{
  deliveredVia: 'resend' | 'gmail' | 'preview';
  providerFailed?: boolean;
  providerError?: string;
  devOtpPreview?: string;
}> {
  const appUrl = resolveAppUrl();
  const template =
    params.purpose === 'signup'
      ? buildConfirmEmailTemplate({
          email: params.email,
          partnerName: params.partnerName,
          code: params.code,
          confirmUrl: `${appUrl}/?confirm=${encodeURIComponent(
            signEmailConfirmToken(params.userId, params.email, OTP_TTL_MINUTES * 60),
          )}`,
          expiryMinutes: OTP_TTL_MINUTES,
        })
      : buildLoginOtpEmailTemplate({
          email: params.email,
          partnerName: params.partnerName,
          code: params.code,
          expiryMinutes: OTP_TTL_MINUTES,
        });

  const dispatch = await dispatchTransactionalEmail({
    to: params.email,
    subject: template.subject,
    html: template.html,
  });

  if (dispatch.deliveredVia === 'resend' || dispatch.deliveredVia === 'gmail') {
    return { deliveredVia: dispatch.deliveredVia };
  }

  if (IS_PROD) {
    const detail = dispatch.providerMessage
      ? `Email delivery failed (${dispatch.providerMessage}).`
      : 'Email delivery is not configured (set GMAIL_SMTP_USER + GMAIL_SMTP_APP_PASSWORD, or RESEND_API_KEY + verified OTP_FROM_EMAIL).';
    return { deliveredVia: 'preview', providerFailed: true, providerError: detail };
  }

  // Only expose preview OTP in non-production dev/preview environments
  return {
    deliveredVia: 'preview',
    devOtpPreview: params.code,
    ...(dispatch.providerMessage ? { providerError: dispatch.providerMessage } : {}),
  };
}

async function sendWelcomeEmailForUser(user: DbUser): Promise<void> {
  const appUrl = resolveAppUrl();
  const template = buildWelcomeEmailTemplate({
    fullName: user.full_name,
    partnerName: user.partner_name,
    appUrl,
  });

  await dispatchTransactionalEmail({
    to: user.email,
    subject: template.subject,
    html: template.html,
  }).catch(() => {});
}

function createOtpInDb(
  db: CouplyDatabase,
  email: string,
  purpose: 'signup' | 'login' | 'admin',
): {
  code: string;
  cooldownRemaining: number;
  hasActiveOtp: boolean;
} {
  const normalizedEmail = email.trim().toLowerCase();
  const now = Date.now();

  const latestOtp = [...db.otp_codes]
    .filter((o) => o.email === normalizedEmail && o.purpose === purpose)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

  if (latestOtp) {
    const elapsedSec = Math.floor((now - Date.parse(latestOtp.created_at)) / 1000);
    if (elapsedSec < OTP_RESEND_COOLDOWN_SECONDS) {
      return {
        code: '',
        cooldownRemaining: OTP_RESEND_COOLDOWN_SECONDS - elapsedSec,
        hasActiveOtp: !latestOtp.used && Date.parse(latestOtp.expires_at) > now,
      };
    }
  }

  // Invalidate prior unused OTPs for this email
  for (const row of db.otp_codes) {
    if (row.email === normalizedEmail && !row.used) {
      row.used = true;
    }
  }

  const code = generateSixDigitOtp();
  const record: DbOtpCode = {
    id: crypto.randomUUID(),
    email: normalizedEmail,
    code_hash: hashSecret(code),
    purpose,
    attempts: 0,
    expires_at: new Date(now + OTP_TTL_MINUTES * 60 * 1000).toISOString(),
    used: false,
    created_at: new Date(now).toISOString(),
  };

  db.otp_codes.push(record);
  return { code, cooldownRemaining: 0, hasActiveOtp: true };
}

function issueSessionInDb(db: CouplyDatabase, user: DbUser) {
  const now = new Date();
  const sessionId = crypto.randomUUID();
  const refreshToken = generateOpaqueRefreshToken();
  const expiresAt = new Date(
    now.getTime() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const session: DbSession = {
    id: sessionId,
    user_id: user.id,
    refresh_token_hash: hashRefreshToken(refreshToken),
    last_active_at: now.toISOString(),
    expires_at: expiresAt,
    revoked: false,
  };

  const targetUser = db.users.find((u) => u.id === user.id);
  if (targetUser) {
    targetUser.last_seen_at = now.toISOString();
  }

  db.sessions.push(session);

  const accessToken = signAccessToken(user.id, sessionId, user.email, ACCESS_TOKEN_TTL_SECONDS);
  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    user: sanitizeUser(targetUser || user),
  };
}

async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const payload = verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired access token.' });
    return;
  }

  const db = loadDatabase();
  const session = db.sessions.find((s) => s.id === payload.sessionId);
  if (!session || session.revoked || session.user_id !== payload.sub) {
    res.status(401).json({ error: 'Session has been revoked.' });
    return;
  }

  const user = db.users.find((u) => u.id === payload.sub);
  if (!user || !user.is_verified) {
    res.status(401).json({ error: 'Account is not verified or no longer exists.' });
    return;
  }

  if (isSessionInactiveExpired(session.last_active_at) || Date.parse(session.expires_at) <= Date.now()) {
    await mutateDatabase((txDb) => {
      const target = txDb.sessions.find((s) => s.id === payload.sessionId);
      if (target) target.revoked = true;
    }).catch(() => {});
    res.status(401).json({
      error: 'Signed out after 30 days of inactivity.',
      code: 'SESSION_EXPIRED_INACTIVITY',
    });
    return;
  }

  req.auth = {
    userId: payload.sub,
    sessionId: payload.sessionId,
    email: payload.email,
  };
  next();
}

function requireAdminAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Owner admin authentication required.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const payload = verifyAdminToken(token);
  if (!payload || payload.email.toLowerCase() !== ADMIN_EMAIL) {
    res.status(401).json({ error: 'Invalid or expired owner admin session.' });
    return;
  }

  req.adminAuth = { email: payload.email };
  next();
}

async function createApp() {
  await initDatabase();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));

  // Handle malformed JSON bodies cleanly without leaking Express stack traces
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON request payload.' });
      return;
    }
    next(err);
  });

  // Security headers (iframe-compatible for AI Studio preview)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    if (IS_PROD) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  });

  const globalApiLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 120,
    message: 'Too many requests. Please slow down for a moment.',
  });

  const authRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    maxRequests: 25,
    message: 'Too many authentication attempts. Please wait a few minutes and try again.',
  });

  app.use('/api', globalApiLimiter);
  app.use('/api/auth', authRateLimiter);
  app.use('/api/admin/auth', authRateLimiter);

  app.get('/api/health', (_req, res) => {
    const dbHealth = getDatabaseHealth();
    res.json({
      status: 'ok',
      service: 'couplova-api',
      timestamp: new Date().toISOString(),
      database: dbHealth,
    });
  });

  app.get('/api/auth/public-config', (_req, res) => {
    const googleClientId = resolveGoogleClientId();
    res.json({
      googleClientId,
      googleOAuthConfigured: Boolean(googleClientId),
    });
  });

  app.get('/api/auth/check-username', async (req, res) => {
    const raw = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(raw)) {
      res.status(400).json({
        available: false,
        error: 'Username must be 3-24 letters, numbers, or underscores.',
      });
      return;
    }

    const db = await initDatabase();
    const normalized = raw.toLowerCase();
    const exists = db.users.some(
      (u) => u.username.toLowerCase() === normalized && u.is_verified,
    );
    if (exists) {
      res.json({
        available: false,
        error: 'That username already exists. Please pick another one.',
      });
      return;
    }

    res.json({ available: true });
  });

  // 1. Signup (atomic check + OTP cooldown validation before creating/updating unverified record)
  app.post('/api/auth/signup', async (req, res) => {
    const {
      fullName,
      username,
      country,
      dateOfBirth,
      email,
      password,
      confirmPassword,
      genderTheme,
      partnerName,
      acceptedTerms,
    } = req.body ?? {};

    const cleanFullName = typeof fullName === 'string' ? sanitizePlainText(fullName, 80) : '';
    if (cleanFullName.length < 2) {
      res.status(400).json({ error: 'Full Name must be between 2 and 80 characters.' });
      return;
    }
    if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(username.trim())) {
      res.status(400).json({ error: 'Username must be 3–24 letters, numbers, or underscores.' });
      return;
    }
    const cleanPartnerName = typeof partnerName === 'string' ? sanitizePlainText(partnerName, 40) : '';
    if (!cleanPartnerName) {
      res.status(400).json({ error: "Partner's Name is required (max 40 characters)." });
      return;
    }
    const cleanCountry = typeof country === 'string' ? sanitizePlainText(country, 80) : '';
    const cleanDob = typeof dateOfBirth === 'string' ? dateOfBirth.trim() : '';
    if (cleanDob && !isValidDateOfBirth(cleanDob)) {
      res.status(400).json({ error: 'Please enter a valid date of birth (13+).' });
      return;
    }
    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    const passwordError =
      typeof password === 'string' ? getPasswordErrorMessage(password) : 'Password is required.';
    if (passwordError) {
      res.status(400).json({ error: passwordError });
      return;
    }
    if (password.length > 128) {
      res.status(400).json({ error: 'Password must be 128 characters or fewer.' });
      return;
    }
    if (password !== confirmPassword) {
      res.status(400).json({ error: 'Passwords do not match.' });
      return;
    }
    if (genderTheme !== 'female' && genderTheme !== 'male') {
      res.status(400).json({ error: 'Please select Her or Him theme.' });
      return;
    }
    if (acceptedTerms !== true) {
      res.status(400).json({ error: 'You must agree to the Terms & Conditions.' });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username.trim().toLowerCase();

    const signupTx = await mutateDatabase<{
      status: number;
      error?: string;
      code?: string;
      retryAfterSeconds?: number;
      user?: DbUser;
      otpCode?: string;
    }>((db) => {
      const existingVerifiedEmail = db.users.find(
        (u) => u.email === normalizedEmail && u.is_verified,
      );
      if (existingVerifiedEmail) {
        return {
          status: 409,
          error: 'An account with this email already exists. Log in instead.',
          code: 'EMAIL_ALREADY_EXISTS',
        };
      }

      const existingVerifiedUsername = db.users.find(
        (u) => u.username.toLowerCase() === normalizedUsername && u.is_verified,
      );
      if (existingVerifiedUsername) {
        return {
          status: 409,
          error: 'That username already exists. Please pick another one.',
          code: 'USERNAME_TAKEN',
        };
      }

      // Enforce OTP resend cooldown BEFORE mutating any user record
      const otpResult = createOtpInDb(db, normalizedEmail, 'signup');
      if (otpResult.cooldownRemaining > 0) {
        return {
          status: 429,
          error: `Please wait ${otpResult.cooldownRemaining}s before requesting another code.`,
          retryAfterSeconds: otpResult.cooldownRemaining,
        };
      }

      // Overwrite any unverified abandoned signup matching email or username
      db.users = db.users.filter(
        (u) =>
          u.is_verified ||
          (u.email !== normalizedEmail && u.username.toLowerCase() !== normalizedUsername),
      );

      const now = new Date().toISOString();
      const newUser: DbUser = {
        id: crypto.randomUUID(),
        full_name: cleanFullName,
        username: username.trim(),
        email: normalizedEmail,
        country: cleanCountry,
        date_of_birth: cleanDob,
        partner_name: cleanPartnerName,
        password_hash: hashSecret(password),
        google_sub: null,
        gender_theme: genderTheme as GenderTheme,
        active_deck_theme: 'default',
        is_verified: false,
        last_seen_at: now,
        created_at: now,
      };

      db.users.push(newUser);
      return { status: 201, user: newUser, otpCode: otpResult.code };
    });

    if (signupTx.status !== 201 || !signupTx.user || !signupTx.otpCode) {
      res.status(signupTx.status).json({
        error: signupTx.error,
        ...(signupTx.code ? { code: signupTx.code } : {}),
        ...(signupTx.retryAfterSeconds ? { retryAfterSeconds: signupTx.retryAfterSeconds } : {}),
      });
      return;
    }

    const delivery = await sendOtpEmail({
      userId: signupTx.user.id,
      email: normalizedEmail,
      partnerName: signupTx.user.partner_name,
      code: signupTx.otpCode,
      purpose: 'signup',
    });

    if (delivery.providerFailed) {
      res.status(502).json({
        error:
          delivery.providerError ||
          'Unable to send confirmation email right now. Please try again.',
      });
      return;
    }

    res.status(201).json({
      message: 'Confirmation email sent. Enter the 6-digit code or click the link in your inbox.',
      email: normalizedEmail,
      purpose: 'signup',
      cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      deliveredVia: delivery.deliveredVia,
      ...(delivery.devOtpPreview ? { devOtpPreview: delivery.devOtpPreview } : {}),
    });
  });

  // 2. Login (Checks if user exists first; non-existent accounts are pushed to Sign Up)
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (!password || typeof password !== 'string' || password.length > 128) {
      res.status(400).json({ error: 'Password is required.' });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const lockRemaining = getAccountLoginLockRemainingSeconds(normalizedEmail);
    if (lockRemaining > 0) {
      res.status(429).json({
        error: `Too many incorrect password attempts. Try again in ${Math.ceil(lockRemaining / 60)} minute(s).`,
        retryAfterSeconds: lockRemaining,
      });
      return;
    }

    const db = await initDatabase();
    const user = db.users.find((u) => u.email === normalizedEmail);

    if (!user) {
      res.status(404).json({
        error: "No account found for that email. Let's get you signed up.",
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    if (!user.password_hash) {
      res.status(400).json({
        error: 'This account uses Google Sign-In. Tap Continue with Google below.',
        code: 'GOOGLE_ONLY_ACCOUNT',
      });
      return;
    }

    if (!verifySecret(password, user.password_hash)) {
      recordFailedLoginAttempt(normalizedEmail);
      res.status(401).json({
        error: 'Incorrect password for this account. Please try again.',
        code: 'INCORRECT_PASSWORD',
      });
      return;
    }

    clearFailedLoginAttempts(normalizedEmail);

    const otpTx = await mutateDatabase<{
      purpose: 'signup' | 'login';
      code: string;
      cooldownRemaining: number;
      hasActiveOtp: boolean;
      targetUser: DbUser | null;
    }>((txDb) => {
      const targetUser = txDb.users.find((u) => u.email === normalizedEmail) || null;
      const purpose: 'signup' | 'login' = targetUser?.is_verified ? 'login' : 'signup';
      if (!targetUser) {
        return { purpose, code: '', cooldownRemaining: 0, hasActiveOtp: false, targetUser: null };
      }
      const otpResult = createOtpInDb(txDb, normalizedEmail, purpose);
      return {
        purpose,
        code: otpResult.code,
        cooldownRemaining: otpResult.cooldownRemaining,
        hasActiveOtp: otpResult.hasActiveOtp,
        targetUser,
      };
    });

    if (!otpTx.targetUser) {
      res.status(404).json({
        error: "No account found for that email. Let's get you signed up.",
        code: 'USER_NOT_FOUND',
      });
      return;
    }

    if (otpTx.cooldownRemaining > 0) {
      if (otpTx.hasActiveOtp) {
        res.json({
          message: 'A 6-digit code was already sent to your email. Enter it below.',
          email: normalizedEmail,
          purpose: otpTx.purpose,
          cooldownSeconds: otpTx.cooldownRemaining,
          deliveredVia: 'preview',
        });
        return;
      }
      res.status(429).json({
        error: `Please wait ${otpTx.cooldownRemaining}s before requesting another code.`,
        retryAfterSeconds: otpTx.cooldownRemaining,
      });
      return;
    }

    const delivery = await sendOtpEmail({
      userId: otpTx.targetUser.id,
      email: normalizedEmail,
      partnerName: otpTx.targetUser.partner_name,
      code: otpTx.code,
      purpose: otpTx.purpose,
    });

    if (delivery.providerFailed) {
      res.status(502).json({
        error:
          delivery.providerError ||
          'Unable to send sign-in confirmation email right now.',
      });
      return;
    }

    res.json({
      message: 'Enter the 6-digit verification code sent to your email.',
      email: normalizedEmail,
      purpose: otpTx.purpose,
      cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      deliveredVia: delivery.deliveredVia,
      ...(delivery.devOtpPreview ? { devOtpPreview: delivery.devOtpPreview } : {}),
    });
  });

  // 3. Resend OTP (60s cooldown)
  app.post('/api/auth/resend-otp', async (req, res) => {
    const { email, purpose } = req.body ?? {};
    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const tx = await mutateDatabase<{
      found: boolean;
      resolvedPurpose: 'signup' | 'login';
      user?: DbUser;
      code: string;
      cooldownRemaining: number;
    }>((db) => {
      const user = db.users.find((u) => u.email === normalizedEmail);
      if (!user) {
        return { found: false, resolvedPurpose: 'login', code: '', cooldownRemaining: 0 };
      }
      const resolvedPurpose: 'signup' | 'login' =
        !user.is_verified || purpose === 'signup' ? 'signup' : 'login';
      const otpResult = createOtpInDb(db, normalizedEmail, resolvedPurpose);
      return {
        found: true,
        resolvedPurpose,
        user,
        code: otpResult.code,
        cooldownRemaining: otpResult.cooldownRemaining,
      };
    });

    if (!tx.found || !tx.user) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }

    if (tx.cooldownRemaining > 0) {
      res.status(429).json({
        error: `Wait ${tx.cooldownRemaining}s before resending.`,
        retryAfterSeconds: tx.cooldownRemaining,
      });
      return;
    }

    const delivery = await sendOtpEmail({
      userId: tx.user.id,
      email: normalizedEmail,
      partnerName: tx.user.partner_name,
      code: tx.code,
      purpose: tx.resolvedPurpose,
    });

    if (delivery.providerFailed) {
      res.status(502).json({
        error:
          delivery.providerError ||
          'Unable to resend verification email right now.',
      });
      return;
    }

    res.json({
      message: 'A new 6-digit code has been sent.',
      cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      deliveredVia: delivery.deliveredVia,
      ...(delivery.devOtpPreview ? { devOtpPreview: delivery.devOtpPreview } : {}),
    });
  });

  // 4. Verify OTP (max 3 attempts, 10-min expiry, strict purpose-binding, atomic transaction)
  app.post('/api/auth/verify-otp', async (req, res) => {
    const { email, code, purpose } = req.body ?? {};
    if (!email || typeof email !== 'string' || !isValidEmail(email) || !code || typeof code !== 'string') {
      res.status(400).json({ error: 'Valid email and 6-digit code are required.' });
      return;
    }

    if (purpose !== undefined && purpose !== 'signup' && purpose !== 'login') {
      res.status(400).json({ error: 'Invalid verification purpose.' });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const cleanedCode = code.trim();
    if (!/^\d{6}$/.test(cleanedCode)) {
      res.status(400).json({ error: 'Code must be exactly 6 digits.' });
      return;
    }

    const result = await mutateDatabase<{
      status: number;
      error?: string;
      sessionBundle?: ReturnType<typeof issueSessionInDb>;
      sendWelcome?: DbUser;
    }>((db) => {
      const user = db.users.find((u) => u.email === normalizedEmail);
      if (!user) {
        return { status: 404, error: 'User account not found.' };
      }

      const expectedPurpose: 'signup' | 'login' =
        purpose === 'signup' || purpose === 'login'
          ? purpose
          : user.is_verified
            ? 'login'
            : 'signup';

      const otpRecord = [...db.otp_codes]
        .filter(
          (o) =>
            o.email === normalizedEmail &&
            !o.used &&
            o.purpose === expectedPurpose,
        )
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

      if (!otpRecord) {
        return { status: 400, error: 'No active verification code found. Request a new code.' };
      }

      if (Date.parse(otpRecord.expires_at) <= Date.now()) {
        otpRecord.used = true;
        return { status: 400, error: 'Verification code expired. Please resend a new code.' };
      }

      if (otpRecord.attempts >= MAX_OTP_ATTEMPTS) {
        otpRecord.used = true;
        return { status: 429, error: 'Maximum attempts reached. Request a new code.' };
      }

      if (!verifySecret(cleanedCode, otpRecord.code_hash)) {
        otpRecord.attempts += 1;
        if (otpRecord.attempts >= MAX_OTP_ATTEMPTS) {
          otpRecord.used = true;
        }
        const remaining = Math.max(0, MAX_OTP_ATTEMPTS - otpRecord.attempts);
        return {
          status: 400,
          error:
            remaining > 0
              ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
              : 'Code invalidated after 3 failed attempts. Please request a new code.',
        };
      }

      otpRecord.used = true;
      const wasVerified = user.is_verified;
      user.is_verified = true;
      user.last_seen_at = new Date().toISOString();

      const sessionBundle = issueSessionInDb(db, user);
      return {
        status: 200,
        sessionBundle,
        sendWelcome: !wasVerified && otpRecord.purpose === 'signup' ? { ...user } : undefined,
      };
    });

    if (result.status !== 200 || !result.sessionBundle) {
      res.status(result.status).json({ error: result.error || 'Verification failed.' });
      return;
    }

    if (result.sendWelcome) {
      void sendWelcomeEmailForUser(result.sendWelcome);
    }

    res.json(result.sessionBundle);
  });

  // 4b. Confirm Email via Magic Button Link (10-min expiry, single-use jti, atomic transaction)
  app.post('/api/auth/confirm-email-link', async (req, res) => {
    const { token } = req.body ?? {};
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Confirmation token is required.' });
      return;
    }

    const payload = verifyEmailConfirmToken(token);
    if (!payload) {
      res.status(401).json({ error: 'This confirmation link has expired or is invalid.' });
      return;
    }

    const result = await mutateDatabase<{
      status: number;
      error?: string;
      sessionBundle?: ReturnType<typeof issueSessionInDb>;
      sendWelcome?: DbUser;
    }>((db) => {
      const alreadyUsed = db.used_confirm_jtis.some((entry) => entry.jti === payload.jti);
      if (alreadyUsed) {
        return { status: 401, error: 'This confirmation link has already been used.' };
      }

      const user = db.users.find((u) => u.id === payload.sub && u.email === payload.email);
      if (!user) {
        return { status: 404, error: 'User account not found.' };
      }

      db.used_confirm_jtis.push({
        jti: payload.jti,
        expires_at: new Date(payload.exp * 1000).toISOString(),
      });

      for (const otp of db.otp_codes) {
        if (otp.email === user.email && !otp.used) {
          otp.used = true;
        }
      }

      const wasVerified = user.is_verified;
      user.is_verified = true;
      user.last_seen_at = new Date().toISOString();

      const sessionBundle = issueSessionInDb(db, user);
      return {
        status: 200,
        sessionBundle,
        sendWelcome: !wasVerified ? { ...user } : undefined,
      };
    });

    if (result.status !== 200 || !result.sessionBundle) {
      res.status(result.status).json({ error: result.error || 'Confirmation failed.' });
      return;
    }

    if (result.sendWelcome) {
      void sendWelcomeEmailForUser(result.sendWelcome);
    }

    res.json(result.sessionBundle);
  });

  // 5. Google Sign-In Verification, Auto-Linking & New User Profile Completion Prompt
  app.post('/api/auth/google', async (req, res) => {
    const { idToken } = req.body ?? {};
    const expectedClientId = resolveGoogleClientId();

    if (!expectedClientId) {
      res.status(503).json({
        error: 'Google Sign-In requires GOOGLE_CLIENT_ID configured on the server.',
      });
      return;
    }

    if (!idToken || typeof idToken !== 'string') {
      res.status(400).json({ error: 'Google ID token is required.' });
      return;
    }

    try {
      const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
      const googleRes = await fetch(verifyUrl, { signal: AbortSignal.timeout(8000) });
      if (!googleRes.ok) {
        res.status(401).json({ error: 'Google token verification failed.' });
        return;
      }
      const tokenInfo = (await googleRes.json()) as {
        sub?: string;
        email?: string;
        email_verified?: string;
        name?: string;
        aud?: string;
        iss?: string;
        exp?: string;
      };

      const validIssuer =
        tokenInfo.iss === 'accounts.google.com' ||
        tokenInfo.iss === 'https://accounts.google.com';
      const tokenExp = Number(tokenInfo.exp || 0);

      if (!validIssuer || tokenInfo.aud !== expectedClientId || tokenExp <= Math.floor(Date.now() / 1000)) {
        res.status(401).json({ error: 'Google token validation failed.' });
        return;
      }

      if (!tokenInfo.email || tokenInfo.email_verified !== 'true' || !tokenInfo.sub) {
        res.status(401).json({ error: 'Verified Google email is required.' });
        return;
      }

      const normalizedEmail = tokenInfo.email.toLowerCase();
      const tx = await mutateDatabase<{
        sessionBundle?: ReturnType<typeof issueSessionInDb>;
        sendWelcome?: DbUser;
      }>((db) => {
        const existingUser = db.users.find(
          (u) => u.google_sub === tokenInfo.sub || u.email === normalizedEmail,
        );
        if (!existingUser) return {};
        const wasVerified = existingUser.is_verified;
        existingUser.google_sub = tokenInfo.sub!;
        existingUser.is_verified = true;
        existingUser.last_seen_at = new Date().toISOString();
        const sessionBundle = issueSessionInDb(db, existingUser);
        return {
          sessionBundle,
          sendWelcome: !wasVerified ? { ...existingUser } : undefined,
        };
      });

      if (tx.sessionBundle) {
        if (tx.sendWelcome) {
          void sendWelcomeEmailForUser(tx.sendWelcome);
        }
        res.json(tx.sessionBundle);
        return;
      }

      // New Google user -> prompt for chosen username, partner's name & theme
      const fullName =
        sanitizePlainText(tokenInfo.name || '', 80) ||
        normalizedEmail.split('@')[0].replace(/[^a-zA-Z0-9 ]/g, ' ');
      const pendingToken = signGooglePendingToken(tokenInfo.sub, normalizedEmail, fullName);
      res.json({
        needsProfileCompletion: true,
        pendingToken,
        prefill: {
          fullName,
          email: normalizedEmail,
        },
      });
    } catch {
      res.status(502).json({ error: 'Unable to reach Google verification service.' });
    }
  });

  // 5b. Complete Google Sign-Up (Username, Partner's Name, Optional DOB, Gender Theme, T&C)
  app.post('/api/auth/google/complete', async (req, res) => {
    const {
      pendingToken,
      username,
      partnerName,
      dateOfBirth,
      country,
      genderTheme,
      acceptedTerms,
    } = req.body ?? {};

    if (!pendingToken || typeof pendingToken !== 'string') {
      res.status(400).json({ error: 'Google verification session expired. Please sign in again.' });
      return;
    }

    const googleData = verifyGooglePendingToken(pendingToken);
    if (!googleData) {
      res.status(401).json({ error: 'Google session expired. Please try Continue with Google again.' });
      return;
    }

    if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(username.trim())) {
      res.status(400).json({ error: 'Username must be 3–24 letters, numbers, or underscores.' });
      return;
    }
    const cleanPartnerName = typeof partnerName === 'string' ? sanitizePlainText(partnerName, 40) : '';
    if (!cleanPartnerName) {
      res.status(400).json({ error: "Please enter your partner's name (max 40 characters)." });
      return;
    }
    const cleanDob = typeof dateOfBirth === 'string' ? dateOfBirth.trim() : '';
    if (cleanDob && !isValidDateOfBirth(cleanDob)) {
      res.status(400).json({ error: 'Please enter a valid date of birth (13+).' });
      return;
    }
    if (genderTheme !== 'female' && genderTheme !== 'male') {
      res.status(400).json({ error: 'Please select Her or Him theme.' });
      return;
    }
    if (acceptedTerms !== true) {
      res.status(400).json({ error: 'You must agree to the Terms & Conditions.' });
      return;
    }

    const normalizedEmail = googleData.email.toLowerCase();
    const normalizedUsername = username.trim().toLowerCase();
    const cleanCountry = typeof country === 'string' ? sanitizePlainText(country, 80) : '';

    const result = await mutateDatabase<{
      status: number;
      error?: string;
      code?: string;
      sessionBundle?: ReturnType<typeof issueSessionInDb>;
      newUser?: DbUser;
    }>((db) => {
      const emailExists = db.users.find((u) => u.email === normalizedEmail && u.is_verified);
      if (emailExists) {
        return {
          status: 409,
          error: 'An account with this email already exists. Log in instead.',
          code: 'EMAIL_ALREADY_EXISTS',
        };
      }

      const usernameExists = db.users.find(
        (u) => u.username.toLowerCase() === normalizedUsername && u.is_verified,
      );
      if (usernameExists) {
        return {
          status: 409,
          error: 'That username already exists. Please pick another one.',
          code: 'USERNAME_TAKEN',
        };
      }

      // Overwrite any unverified abandoned record if one existed
      db.users = db.users.filter(
        (u) =>
          u.is_verified ||
          (u.email !== normalizedEmail && u.username.toLowerCase() !== normalizedUsername),
      );

      const now = new Date().toISOString();
      const newUser: DbUser = {
        id: crypto.randomUUID(),
        full_name: sanitizePlainText(googleData.fullName, 80) || 'Couplova User',
        username: username.trim(),
        email: normalizedEmail,
        country: cleanCountry,
        date_of_birth: cleanDob,
        partner_name: cleanPartnerName,
        password_hash: null,
        google_sub: googleData.googleSub,
        gender_theme: genderTheme as GenderTheme,
        active_deck_theme: 'default',
        is_verified: true,
        last_seen_at: now,
        created_at: now,
      };

      db.users.push(newUser);
      const sessionBundle = issueSessionInDb(db, newUser);
      return { status: 201, sessionBundle, newUser };
    });

    if (result.status !== 201 || !result.sessionBundle || !result.newUser) {
      res.status(result.status).json({
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
      });
      return;
    }

    void sendWelcomeEmailForUser(result.newUser);
    res.status(201).json(result.sessionBundle);
  });

  // 6. Demo Couple Session (for immediate preview & ?autostart=1 verification)
  app.post('/api/auth/demo', async (_req, res) => {
    const sessionBundle = await mutateDatabase((db) => {
      const demoUser =
        db.users.find((u) => u.email === 'maya@couplova.app' || u.email === 'maya@couply.app') ||
        db.users[0];
      if (!demoUser) return null;
      return issueSessionInDb(db, demoUser);
    });

    if (!sessionBundle) {
      res.status(404).json({ error: 'Demo user unavailable.' });
      return;
    }
    res.json(sessionBundle);
  });

  // 7. Refresh Token with Atomic Rotation, Reuse Detection & 30-Day Inactivity Revocation
  app.post('/api/auth/refresh', async (req, res) => {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken || typeof refreshToken !== 'string') {
      res.status(400).json({ error: 'Refresh token required.' });
      return;
    }

    const tokenHash = hashRefreshToken(refreshToken);

    const result = await mutateDatabase<{
      status: number;
      error?: string;
      code?: string;
      body?: {
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        user: ReturnType<typeof sanitizeUser>;
      };
    }>((db) => {
      // Reuse detection: if an already-rotated refresh token is replayed, revoke all user sessions
      const reused = db.rotated_refresh_hashes.find((entry) => entry.token_hash === tokenHash);
      if (reused) {
        for (const s of db.sessions) {
          if (s.user_id === reused.user_id) {
            s.revoked = true;
          }
        }
        return {
          status: 401,
          error: 'Session invalidated for your security. Please log in again.',
          code: 'REFRESH_TOKEN_REUSE_DETECTED',
        };
      }

      const session = db.sessions.find((s) => s.refresh_token_hash === tokenHash);
      if (!session || session.revoked) {
        return { status: 401, error: 'Session is invalid or revoked.' };
      }

      if (
        isSessionInactiveExpired(session.last_active_at) ||
        Date.parse(session.expires_at) <= Date.now()
      ) {
        session.revoked = true;
        return {
          status: 401,
          error: 'Signed out after 30 days of inactivity.',
          code: 'SESSION_EXPIRED_INACTIVITY',
        };
      }

      const user = db.users.find((u) => u.id === session.user_id);
      if (!user || !user.is_verified) {
        return { status: 401, error: 'User not found or unverified.' };
      }

      // Rotate refresh token on every refresh
      const nextRefreshToken = generateOpaqueRefreshToken();
      db.rotated_refresh_hashes.push({
        token_hash: tokenHash,
        user_id: user.id,
        expires_at: session.expires_at,
      });
      session.refresh_token_hash = hashRefreshToken(nextRefreshToken);

      const nowIso = new Date().toISOString();
      session.last_active_at = nowIso;
      user.last_seen_at = nowIso;

      const accessToken = signAccessToken(user.id, session.id, user.email, ACCESS_TOKEN_TTL_SECONDS);
      return {
        status: 200,
        body: {
          accessToken,
          refreshToken: nextRefreshToken,
          expiresIn: ACCESS_TOKEN_TTL_SECONDS,
          user: sanitizeUser(user),
        },
      };
    });

    if (result.status !== 200 || !result.body) {
      res.status(result.status).json({
        error: result.error || 'Unable to refresh session.',
        ...(result.code ? { code: result.code } : {}),
      });
      return;
    }
    res.json(result.body);
  });

  // 8. Logout
  app.post('/api/auth/logout', requireAuth, async (req: AuthedRequest, res) => {
    await mutateDatabase((db) => {
      const session = db.sessions.find((s) => s.id === req.auth?.sessionId);
      if (session) {
        session.revoked = true;
      }
    });
    res.json({ ok: true });
  });

  // 9. Profile & Active Theme (never modifies locked gender_theme)
  app.get('/api/me', requireAuth, (req: AuthedRequest, res) => {
    const db = loadDatabase();
    const user = db.users.find((u) => u.id === req.auth?.userId);
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    res.json({ user: sanitizeUser(user) });
  });

  app.patch('/api/me', requireAuth, async (req: AuthedRequest, res) => {
    const { activeDeckTheme, partnerName } = req.body ?? {};
    const allowedThemes: ActiveDeckThemeId[] = [
      'default',
      'obsidian',
      'terracotta',
      'olive',
      'mulberry',
      'female',
      'male',
    ];

    const updated = await mutateDatabase((db) => {
      const user = db.users.find((u) => u.id === req.auth?.userId);
      if (!user) return null;

      if (typeof activeDeckTheme === 'string' && allowedThemes.includes(activeDeckTheme as ActiveDeckThemeId)) {
        user.active_deck_theme = activeDeckTheme as ActiveDeckThemeId;
      }
      if (typeof partnerName === 'string') {
        const clean = sanitizePlainText(partnerName, 40);
        if (clean) {
          user.partner_name = clean;
        }
      }
      return sanitizeUser(user);
    });

    if (!updated) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    res.json({ user: updated });
  });

  // 10. Saved Cards CRUD (validated against real deck card IDs)
  app.get('/api/saved-cards', requireAuth, (req: AuthedRequest, res) => {
    const db = loadDatabase();
    const saved = db.saved_cards
      .filter((c) => c.user_id === req.auth?.userId)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    res.json({ savedCards: saved });
  });

  app.post('/api/saved-cards/:cardId', requireAuth, async (req: AuthedRequest, res) => {
    const cardId = String(req.params.cardId || '').trim();
    if (!cardId || !VALID_CARD_IDS.has(cardId)) {
      res.status(400).json({ error: 'Invalid card ID.' });
      return;
    }

    await mutateDatabase((db) => {
      const exists = db.saved_cards.some(
        (c) => c.user_id === req.auth?.userId && c.card_id === cardId,
      );
      if (!exists && req.auth?.userId) {
        db.saved_cards.push({
          user_id: req.auth.userId,
          card_id: cardId,
          created_at: new Date().toISOString(),
        });
      }
    });
    res.status(201).json({ cardId, saved: true });
  });

  app.delete('/api/saved-cards/:cardId', requireAuth, async (req: AuthedRequest, res) => {
    const cardId = String(req.params.cardId || '').trim();
    if (!cardId || !VALID_CARD_IDS.has(cardId)) {
      res.status(400).json({ error: 'Invalid card ID.' });
      return;
    }
    await mutateDatabase((db) => {
      db.saved_cards = db.saved_cards.filter(
        (c) => !(c.user_id === req.auth?.userId && c.card_id === cardId),
      );
    });
    res.json({ cardId, saved: false });
  });

  // 10b. Couple Promises / IOUs CRUD ("Cash This In Later")
  function serializeIou(iou: import('./src/services/store').DbCoupleIou) {
    return {
      id: iou.id,
      cardId: iou.card_id,
      deckId: iou.deck_id,
      deckTitle: iou.deck_title,
      title: iou.title,
      owedBy: iou.owed_by,
      redeemed: iou.redeemed,
      redeemedAt: iou.redeemed_at,
      createdAt: iou.created_at,
    };
  }

  app.get('/api/ious', requireAuth, (req: AuthedRequest, res) => {
    const db = loadDatabase();
    const list = (db.ious || [])
      .filter((i) => i.user_id === req.auth?.userId)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .map(serializeIou);
    res.json({ ious: list });
  });

  app.post('/api/ious', requireAuth, async (req: AuthedRequest, res) => {
    const { title, owedBy, cardId, deckId, deckTitle } = req.body ?? {};
    const cleanTitle = typeof title === 'string' ? sanitizePlainText(title, 160) : '';
    if (cleanTitle.length < 3) {
      res.status(400).json({ error: 'Promise text must be at least 3 characters.' });
      return;
    }
    if (owedBy !== undefined && owedBy !== 'me' && owedBy !== 'partner' && owedBy !== 'both') {
      res.status(400).json({ error: 'Invalid owedBy selection.' });
      return;
    }
    const cleanCardId = typeof cardId === 'string' ? cardId.trim() : '';
    if (cleanCardId && !VALID_CARD_IDS.has(cleanCardId)) {
      res.status(400).json({ error: 'Invalid card reference.' });
      return;
    }
    const cleanDeckId = typeof deckId === 'string' ? deckId.trim() : '';
    if (cleanDeckId && !VALID_DECK_IDS.has(cleanDeckId)) {
      res.status(400).json({ error: 'Invalid deck reference.' });
      return;
    }

    const cleanOwedBy: 'me' | 'partner' | 'both' = owedBy ?? 'me';
    const cleanDeckTitle =
      typeof deckTitle === 'string' && sanitizePlainText(deckTitle, 80)
        ? sanitizePlainText(deckTitle, 80)
        : 'Custom Promise';

    const item = await mutateDatabase((db) => {
      const now = new Date().toISOString();
      const record = {
        id: crypto.randomUUID(),
        user_id: req.auth!.userId,
        card_id: cleanCardId,
        deck_id: cleanDeckId,
        deck_title: cleanDeckTitle,
        title: cleanTitle,
        owed_by: cleanOwedBy,
        redeemed: false,
        redeemed_at: null,
        created_at: now,
      };
      db.ious = db.ious || [];
      db.ious.push(record);
      return record;
    });

    res.status(201).json({ iou: serializeIou(item) });
  });

  app.patch('/api/ious/:iouId', requireAuth, async (req: AuthedRequest, res) => {
    const iouId = String(req.params.iouId || '').trim();
    if (!iouId || typeof req.body?.redeemed !== 'boolean') {
      res.status(400).json({ error: 'Valid iouId and boolean redeemed status are required.' });
      return;
    }

    const updated = await mutateDatabase((db) => {
      const item = (db.ious || []).find(
        (i) => i.id === iouId && i.user_id === req.auth?.userId,
      );
      if (!item) return null;
      item.redeemed = req.body.redeemed;
      item.redeemed_at = req.body.redeemed ? new Date().toISOString() : null;
      return item;
    });

    if (!updated) {
      res.status(404).json({ error: 'Promise not found.' });
      return;
    }
    res.json({ iou: serializeIou(updated) });
  });

  app.delete('/api/ious/:iouId', requireAuth, async (req: AuthedRequest, res) => {
    const iouId = String(req.params.iouId || '').trim();
    const deleted = await mutateDatabase((db) => {
      const before = (db.ious || []).length;
      db.ious = (db.ious || []).filter(
        (i) => !(i.id === iouId && i.user_id === req.auth?.userId),
      );
      return db.ious.length < before;
    });

    if (!deleted) {
      res.status(404).json({ error: 'Promise not found.' });
      return;
    }
    res.json({ ok: true, id: iouId });
  });

  // 11. Live Telemetry Heartbeat (client pulse only; telemetry reads are owner-admin only)
  app.post('/api/telemetry/heartbeat', requireAuth, async (req: AuthedRequest, res) => {
    const nowIso = new Date().toISOString();
    await mutateDatabase((db) => {
      const user = db.users.find((u) => u.id === req.auth?.userId);
      const session = db.sessions.find((s) => s.id === req.auth?.sessionId);
      if (user) {
        user.last_seen_at = nowIso;
      }
      if (session && !session.revoked) {
        session.last_active_at = nowIso;
      }
    });
    res.json({ ok: true, lastSeenAt: nowIso });
  });

  app.get('/api/telemetry/stats', requireAdminAuth, (_req, res) => {
    const db = loadDatabase();
    const now = Date.now();
    const twoMinutesAgo = now - 2 * 60 * 1000;
    const thirtyDaysAgo = now - THIRTY_DAYS_MS;

    const currentlyOnline = db.users.filter(
      (u) => u.is_verified && Date.parse(u.last_seen_at) >= twoMinutesAgo,
    ).length;

    const activeUserIds = new Set(
      db.sessions
        .filter((s) => !s.revoked && Date.parse(s.last_active_at) >= thirtyDaysAgo)
        .map((s) => s.user_id),
    );

    res.json({
      currentlyOnline,
      totalActiveUsers: activeUserIds.size,
      windowMinutes: 2,
      inactivityLimitDays: 30,
    });
  });

  // 12. Owner-Only Admin Auth & Monitoring Endpoints (/admin)
  app.get('/api/admin/auth/config', (_req, res) => {
    res.json({
      requiresPassphrase: Boolean(ADMIN_PASSWORD),
    });
  });

  app.post('/api/admin/auth/request-otp', async (req, res) => {
    const { email, passphrase } = req.body ?? {};
    if (!email || typeof email !== 'string' || !isValidEmail(email)) {
      res.status(400).json({ error: 'Enter a valid owner email address.' });
      return;
    }

    const adminLockKey = `admin:${ADMIN_EMAIL}`;
    const lockRemaining = getAccountLoginLockRemainingSeconds(adminLockKey);
    if (lockRemaining > 0) {
      res.status(429).json({
        error: `Too many failed owner attempts. Try again in ${Math.ceil(lockRemaining / 60)} minute(s).`,
        retryAfterSeconds: lockRemaining,
      });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const isOwnerEmail = timingSafeStringEqual(normalizedEmail, ADMIN_EMAIL);

    if (!isOwnerEmail) {
      recordFailedLoginAttempt(adminLockKey);
      res.status(403).json({
        error: 'Access denied. Only the Couplova owner account can open this console.',
      });
      return;
    }

    if (ADMIN_PASSWORD) {
      const candidate = typeof passphrase === 'string' ? passphrase : '';
      if (!timingSafeStringEqual(candidate, ADMIN_PASSWORD)) {
        recordFailedLoginAttempt(adminLockKey);
        res.status(401).json({ error: 'Incorrect owner passphrase.' });
        return;
      }
    }

    clearFailedLoginAttempts(adminLockKey);

    const otpResult = await mutateDatabase((db) => createOtpInDb(db, normalizedEmail, 'admin'));
    if (otpResult.cooldownRemaining > 0) {
      res.status(429).json({
        error: `Please wait ${otpResult.cooldownRemaining}s before requesting another code.`,
        retryAfterSeconds: otpResult.cooldownRemaining,
      });
      return;
    }

    const template = buildAdminOtpEmailTemplate({
      email: normalizedEmail,
      code: otpResult.code,
      expiryMinutes: OTP_TTL_MINUTES,
    });

    const dispatch = await dispatchTransactionalEmail({
      to: normalizedEmail,
      subject: template.subject,
      html: template.html,
    });

    if (dispatch.deliveredVia === 'resend' || dispatch.deliveredVia === 'gmail') {
      res.json({
        message: '6-digit owner verification code sent to your inbox.',
        email: normalizedEmail,
        cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
        deliveredVia: dispatch.deliveredVia,
      });
      return;
    }

    if (IS_PROD) {
      res.status(502).json({
        error:
          dispatch.providerMessage ||
          'Unable to dispatch owner verification email. Check SMTP or Resend secrets.',
      });
      return;
    }

    res.json({
      message: 'Preview mode: enter the 6-digit owner code below.',
      email: normalizedEmail,
      cooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      deliveredVia: 'preview',
      devOtpPreview: otpResult.code,
    });
  });

  app.post('/api/admin/auth/verify-otp', async (req, res) => {
    const { email, code } = req.body ?? {};
    if (!email || typeof email !== 'string' || !isValidEmail(email) || !code || typeof code !== 'string') {
      res.status(400).json({ error: 'Valid owner email and 6-digit code are required.' });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!timingSafeStringEqual(normalizedEmail, ADMIN_EMAIL)) {
      res.status(403).json({ error: 'Access denied. Owner privileges required.' });
      return;
    }

    const cleanedCode = code.trim();
    if (!/^\d{6}$/.test(cleanedCode)) {
      res.status(400).json({ error: 'Code must be exactly 6 digits.' });
      return;
    }

    const result = await mutateDatabase<{ status: number; error?: string }>((db) => {
      const otpRecord = [...db.otp_codes]
        .filter((o) => o.email === normalizedEmail && !o.used && o.purpose === 'admin')
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

      if (!otpRecord) {
        return { status: 400, error: 'No active admin verification code found. Request a new one.' };
      }

      if (Date.parse(otpRecord.expires_at) <= Date.now()) {
        otpRecord.used = true;
        return { status: 400, error: 'Owner verification code expired. Request a new one.' };
      }

      if (otpRecord.attempts >= MAX_OTP_ATTEMPTS) {
        otpRecord.used = true;
        return { status: 429, error: 'Maximum attempts reached. Request a new code.' };
      }

      if (!verifySecret(cleanedCode, otpRecord.code_hash)) {
        otpRecord.attempts += 1;
        if (otpRecord.attempts >= MAX_OTP_ATTEMPTS) {
          otpRecord.used = true;
        }
        const remaining = Math.max(0, MAX_OTP_ATTEMPTS - otpRecord.attempts);
        return {
          status: 400,
          error:
            remaining > 0
              ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
              : 'Code invalidated after 3 failed attempts. Request a new one.',
        };
      }

      otpRecord.used = true;
      return { status: 200 };
    });

    if (result.status !== 200) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const adminToken = signAdminToken(normalizedEmail, 60 * 60);
    res.json({
      adminToken,
      adminEmail: normalizedEmail,
      expiresIn: 60 * 60,
    });
  });

  app.get('/api/admin/overview', requireAdminAuth, (req: AuthedRequest, res) => {
    const db = loadDatabase();
    const now = Date.now();
    const twoMinutesAgo = now - 2 * 60 * 1000;
    const thirtyDaysAgo = now - THIRTY_DAYS_MS;

    const savedCountsByUser = new Map<string, number>();
    for (const item of db.saved_cards) {
      savedCountsByUser.set(item.user_id, (savedCountsByUser.get(item.user_id) || 0) + 1);
    }

    const userMap = new Map(db.users.map((u) => [u.id, u]));

    const currentlyOnline = db.users.filter(
      (u) => u.is_verified && Date.parse(u.last_seen_at) >= twoMinutesAgo,
    ).length;

    const activeSessions = db.sessions.filter(
      (s) =>
        !s.revoked &&
        Date.parse(s.last_active_at) >= thirtyDaysAgo &&
        Date.parse(s.expires_at) > now,
    );

    const activeUserIds = new Set(activeSessions.map((s) => s.user_id));
    const verifiedUsers = db.users.filter((u) => u.is_verified).length;

    const users = [...db.users]
      .sort((a, b) => Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at))
      .map((u) => ({
        id: u.id,
        fullName: u.full_name,
        username: u.username,
        email: u.email,
        partnerName: u.partner_name,
        country: u.country,
        dateOfBirth: u.date_of_birth,
        genderTheme: u.gender_theme,
        activeDeckTheme: u.active_deck_theme,
        isVerified: u.is_verified,
        authMethod: u.google_sub
          ? u.password_hash
            ? 'Google + Password'
            : 'Google OAuth'
          : 'Email + Password',
        savedCardsCount: savedCountsByUser.get(u.id) || 0,
        onlineNow: u.is_verified && Date.parse(u.last_seen_at) >= twoMinutesAgo,
        lastSeenAt: u.last_seen_at,
        createdAt: u.created_at,
      }));

    const sessions = [...db.sessions]
      .sort((a, b) => Date.parse(b.last_active_at) - Date.parse(a.last_active_at))
      .slice(0, 60)
      .map((s) => {
        const owner = userMap.get(s.user_id);
        return {
          id: s.id,
          userId: s.user_id,
          userEmail: owner?.email || 'unknown',
          userName: owner?.full_name || 'Unknown User',
          lastActiveAt: s.last_active_at,
          expiresAt: s.expires_at,
          revoked: s.revoked,
          expired: Date.parse(s.expires_at) <= now || isSessionInactiveExpired(s.last_active_at, now),
        };
      });

    const otpEvents = [...db.otp_codes]
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, 40)
      .map((o) => ({
        id: o.id,
        email: o.email,
        purpose: o.purpose,
        attempts: o.attempts,
        used: o.used,
        expiresAt: o.expires_at,
        createdAt: o.created_at,
      }));

    const gmailSmtpConfigured = Boolean(
      process.env.GMAIL_SMTP_USER?.trim() && process.env.GMAIL_SMTP_APP_PASSWORD?.trim(),
    );
    const resendKey = process.env.RESEND_API_KEY?.trim();
    const resendConfigured = Boolean(
      resendKey && resendKey.startsWith('re_') && !resendKey.includes('xxxx'),
    );
    const googleOAuthConfigured = Boolean(resolveGoogleClientId());
    const dbHealth = getDatabaseHealth();

    res.json({
      adminEmail: req.adminAuth?.email || ADMIN_EMAIL,
      telemetry: {
        currentlyOnline,
        totalActiveUsers: activeUserIds.size,
        totalUsers: db.users.length,
        verifiedUsers,
        unverifiedUsers: db.users.length - verifiedUsers,
        activeSessionsCount: activeSessions.length,
        totalSavedCards: db.saved_cards.length,
        windowMinutes: 2,
        inactivityLimitDays: 30,
      },
      users,
      sessions,
      otpEvents,
      system: {
        environment: IS_PROD ? 'production' : 'development',
        databaseMode: dbHealth.connected
          ? `PostgreSQL (${dbHealth.host ?? 'connected'})`
          : dbHealth.configured
            ? `PostgreSQL Fallback (${dbHealth.lastError || 'local JSON active'})`
            : 'Local JSON (.data/couply-db.json)',
        gmailSmtpConfigured,
        resendConfigured,
        googleOAuthConfigured,
        passphraseProtected: Boolean(ADMIN_PASSWORD),
        serverTime: new Date(now).toISOString(),
      },
    });
  });

  app.post('/api/admin/sessions/:sessionId/revoke', requireAdminAuth, async (req, res) => {
    const sessionId = String(req.params.sessionId || '').trim();
    const found = await mutateDatabase((db) => {
      const session = db.sessions.find((s) => s.id === sessionId);
      if (!session) return false;
      session.revoked = true;
      return true;
    });
    if (!found) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    res.json({ ok: true, sessionId, revoked: true });
  });

  // Unmatched API routes must always return JSON 404 instead of SPA HTML
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Global safe API error handler (never expose internal stack traces)
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/')) {
      console.error('[Couplova API Error]', err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Unexpected server error. Please try again.' });
      }
      return;
    }
    next(err);
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build not found');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Couplova server listening on http://localhost:${PORT}`);
  });
}

createApp().catch((err) => {
  console.error('Failed to start Couplova server:', err);
  process.exit(1);
});
