import type { ActiveDeckThemeId, GenderTheme } from '../constants/theme';

export const API_BASE_URL = 'https://couplova.onrender.com';

function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

import {
  clearAdminSession,
  clearAuthSession,
  getStoredAccessToken,
  getStoredAdminToken,
  getStoredRefreshToken,
  saveAdminSession,
  saveAuthSession,
  updateStoredUser,
  type CoupleIou,
  type CouplyUser,
} from './storage';

type ColdStartListener = (isColdStarting: boolean) => void;
type SessionExpiredListener = (reason: string) => void;

let coldStartListener: ColdStartListener | null = null;
let sessionExpiredListener: SessionExpiredListener | null = null;

export function subscribeColdStart(listener: ColdStartListener): () => void {
  coldStartListener = listener;
  return () => {
    if (coldStartListener === listener) coldStartListener = null;
  };
}

export function subscribeSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListener = listener;
  return () => {
    if (sessionExpiredListener === listener) sessionExpiredListener = null;
  };
}

export class ApiError extends Error {
  status: number;
  code?: string;
  retryAfterSeconds?: number;

  constructor(message: string, status: number, code?: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

let inFlightRefresh: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = (async () => {
    const refreshToken = getStoredRefreshToken();
    if (!refreshToken) return null;

    const res = await fetch(resolveApiUrl('/api/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        clearAuthSession();
        if (errBody.code === 'SESSION_EXPIRED_INACTIVITY') {
          sessionExpiredListener?.('Signed out after 30 days of inactivity.');
        }
      }
      return null;
    }

    const data = (await res.json()) as {
      accessToken: string;
      refreshToken?: string;
      user: CouplyUser;
    };
    saveAuthSession({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
    });
    return data.accessToken;
  })();

  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

async function apiFetch<T>(
  path: string,
  options: RequestInit & { auth?: boolean; retry?: boolean } = {},
): Promise<T> {
  const { auth = false, retry = true, headers = {}, ...rest } = options;
  const reqHeaders = new Headers(headers);
  if (!reqHeaders.has('Content-Type') && rest.body) {
    reqHeaders.set('Content-Type', 'application/json');
  }
  if (auth) {
    const token = getStoredAccessToken();
    if (token) {
      reqHeaders.set('Authorization', `Bearer ${token}`);
    }
  }

  let coldStartTriggered = false;
  const coldStartTimer = window.setTimeout(() => {
    coldStartTriggered = true;
    coldStartListener?.(true);
  }, 3000);

  try {
    const response = await fetch(resolveApiUrl(path), { ...rest, headers: reqHeaders });

    if (response.status === 401 && auth && retry) {
      const nextToken = await refreshAccessToken();
      if (nextToken) {
        return apiFetch<T>(path, { ...options, retry: false });
      }
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(
        data.error || 'Request failed.',
        response.status,
        data.code,
        data.retryAfterSeconds,
      );
    }
    return data as T;
  } finally {
    window.clearTimeout(coldStartTimer);
    if (coldStartTriggered) {
      coldStartListener?.(false);
    }
  }
}

export interface OtpChallengeResponse {
  message: string;
  email: string;
  purpose: 'signup' | 'login';
  cooldownSeconds: number;
  deliveredVia: 'resend' | 'gmail' | 'preview';
  devOtpPreview?: string;
}

export interface AuthSessionResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: CouplyUser;
}

export interface GoogleProfileCompletionPrompt {
  needsProfileCompletion: true;
  pendingToken: string;
  prefill: {
    fullName: string;
    email: string;
  };
}

export type GoogleSignInResponse = AuthSessionResponse | GoogleProfileCompletionPrompt;

export interface TelemetryStats {
  currentlyOnline: number;
  totalActiveUsers: number;
  totalUsers?: number;
  verifiedUsers?: number;
  unverifiedUsers?: number;
  activeSessionsCount?: number;
  totalSavedCards?: number;
  windowMinutes: number;
  inactivityLimitDays: number;
}

export interface AdminUserRecord {
  id: string;
  fullName: string;
  username: string;
  email: string;
  partnerName: string;
  country: string;
  dateOfBirth: string;
  genderTheme: GenderTheme;
  activeDeckTheme: ActiveDeckThemeId;
  isVerified: boolean;
  authMethod: string;
  savedCardsCount: number;
  onlineNow: boolean;
  lastSeenAt: string;
  createdAt: string;
}

export interface AdminSessionRecord {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  lastActiveAt: string;
  expiresAt: string;
  revoked: boolean;
  expired: boolean;
}

export interface AdminOtpRecord {
  id: string;
  email: string;
  purpose: 'signup' | 'login' | 'admin';
  attempts: number;
  used: boolean;
  expiresAt: string;
  createdAt: string;
}

export interface AdminOverviewResponse {
  adminEmail: string;
  telemetry: TelemetryStats;
  users: AdminUserRecord[];
  sessions: AdminSessionRecord[];
  otpEvents: AdminOtpRecord[];
  system: {
    environment: string;
    databaseMode?: string;
    gmailSmtpConfigured: boolean;
    resendConfigured: boolean;
    googleOAuthConfigured: boolean;
    passphraseProtected: boolean;
    serverTime: string;
  };
}

export interface PublicAuthConfig {
  googleClientId: string | null;
  googleOAuthConfigured: boolean;
}

export const couplyApi = {
  getPublicConfig() {
    return apiFetch<PublicAuthConfig>('/api/auth/public-config');
  },

  checkUsername(username: string) {
    return apiFetch<{ available: boolean; error?: string }>(
      `/api/auth/check-username?username=${encodeURIComponent(username.trim())}`,
    );
  },

  signup(payload: {
    fullName: string;
    username: string;
    country: string;
    dateOfBirth: string;
    email: string;
    password: string;
    confirmPassword: string;
    genderTheme: GenderTheme;
    partnerName?: string;
    acceptedTerms: boolean;
  }) {
    return apiFetch<OtpChallengeResponse>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  login(payload: { email: string; password: string }) {
    return apiFetch<OtpChallengeResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  resendOtp(payload: { email: string; purpose: 'signup' | 'login' }) {
    return apiFetch<OtpChallengeResponse>('/api/auth/resend-otp', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async verifyOtp(payload: { email: string; code: string; purpose?: 'signup' | 'login' }) {
    const res = await apiFetch<AuthSessionResponse>('/api/auth/verify-otp', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    saveAuthSession(res);
    return res;
  },

  async confirmEmailLink(payload: { token: string }) {
    const res = await apiFetch<AuthSessionResponse>('/api/auth/confirm-email-link', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    saveAuthSession(res);
    return res;
  },

  async googleSignIn(payload: { idToken: string }) {
    const res = await apiFetch<GoogleSignInResponse>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if ('accessToken' in res) {
      saveAuthSession(res);
    }
    return res;
  },

  async completeGoogleProfile(payload: {
    pendingToken: string;
    username: string;
    partnerName: string;
    dateOfBirth: string;
    country?: string;
    genderTheme: GenderTheme;
    acceptedTerms: boolean;
  }) {
    const res = await apiFetch<AuthSessionResponse>('/api/auth/google/complete', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    saveAuthSession(res);
    return res;
  },

  async demoSignIn() {
    const res = await apiFetch<AuthSessionResponse>('/api/auth/demo', {
      method: 'POST',
    });
    saveAuthSession(res);
    return res;
  },

  async getMe() {
    const res = await apiFetch<{ user: CouplyUser }>('/api/me', { auth: true });
    updateStoredUser(res.user);
    return res.user;
  },

  async updatePreferences(payload: {
    activeDeckTheme?: ActiveDeckThemeId;
    partnerName?: string;
  }) {
    const res = await apiFetch<{ user: CouplyUser }>('/api/me', {
      method: 'PATCH',
      auth: true,
      body: JSON.stringify(payload),
    });
    updateStoredUser(res.user);
    return res.user;
  },

  getSavedCards() {
    return apiFetch<{ savedCards: Array<{ card_id: string; created_at: string }> }>(
      '/api/saved-cards',
      { auth: true },
    );
  },

  saveCard(cardId: string) {
    return apiFetch<{ cardId: string; saved: boolean }>(
      `/api/saved-cards/${encodeURIComponent(cardId)}`,
      { method: 'POST', auth: true },
    );
  },

  unsaveCard(cardId: string) {
    return apiFetch<{ cardId: string; saved: boolean }>(
      `/api/saved-cards/${encodeURIComponent(cardId)}`,
      { method: 'DELETE', auth: true },
    );
  },

  getIous() {
    return apiFetch<{ ious: CoupleIou[] }>('/api/ious', { auth: true });
  },

  createIou(payload: {
    title: string;
    owedBy: 'me' | 'partner' | 'both';
    cardId?: string;
    deckId?: string;
    deckTitle?: string;
  }) {
    return apiFetch<{ iou: CoupleIou }>('/api/ious', {
      method: 'POST',
      auth: true,
      body: JSON.stringify(payload),
    });
  },

  toggleIouRedeemed(iouId: string, redeemed: boolean) {
    return apiFetch<{ iou: CoupleIou }>(
      `/api/ious/${encodeURIComponent(iouId)}`,
      {
        method: 'PATCH',
        auth: true,
        body: JSON.stringify({ redeemed }),
      },
    );
  },

  deleteIou(iouId: string) {
    return apiFetch<{ ok: boolean; id: string }>(
      `/api/ious/${encodeURIComponent(iouId)}`,
      { method: 'DELETE', auth: true },
    );
  },

  sendHeartbeat() {
    return apiFetch<{ ok: boolean; lastSeenAt: string }>('/api/telemetry/heartbeat', {
      method: 'POST',
      auth: true,
    });
  },

  async logout() {
    try {
      await apiFetch<{ ok: boolean }>('/api/auth/logout', { method: 'POST', auth: true });
    } finally {
      clearAuthSession();
    }
  },
};

async function adminFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredAdminToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const response = await fetch(resolveApiUrl(path), { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      clearAdminSession();
    }
    throw new ApiError(data.error || 'Admin request failed.', response.status, data.code);
  }
  return data as T;
}

export const adminApi = {
  getAuthConfig() {
    return apiFetch<{ requiresPassphrase: boolean }>('/api/admin/auth/config');
  },

  requestOtp(payload: { email: string; passphrase?: string }) {
    return apiFetch<{
      message: string;
      email: string;
      cooldownSeconds: number;
      deliveredVia: 'resend' | 'gmail' | 'preview';
      devOtpPreview?: string;
    }>('/api/admin/auth/request-otp', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async verifyOtp(payload: { email: string; code: string }) {
    const res = await apiFetch<{ adminToken: string; adminEmail: string; expiresIn: number }>(
      '/api/admin/auth/verify-otp',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
    saveAdminSession(res.adminToken, res.adminEmail);
    return res;
  },

  getOverview() {
    return adminFetch<AdminOverviewResponse>('/api/admin/overview');
  },

  revokeSession(sessionId: string) {
    return adminFetch<{ ok: boolean; sessionId: string; revoked: boolean }>(
      `/api/admin/sessions/${encodeURIComponent(sessionId)}/revoke`,
      { method: 'POST' },
    );
  },

  logout() {
    clearAdminSession();
  },
};
