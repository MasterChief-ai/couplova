import React, { useCallback, useEffect, useState } from 'react';
import {
  adminApi,
  ApiError,
  type AdminOverviewResponse,
} from '../services/api';
import {
  clearAdminSession,
  getStoredAdminEmail,
  getStoredAdminToken,
} from '../services/storage';
import { isValidEmail } from '../utils/gameLogic';
import { BackArrowIcon, RefreshIcon } from './Icons';

type AdminTab = 'users' | 'sessions' | 'otps';

function formatTimestamp(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '-';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AdminDashboardScreen() {
  const [adminToken, setAdminToken] = useState<string | null>(() => getStoredAdminToken());
  const [adminEmail, setAdminEmail] = useState<string>(() => getStoredAdminEmail() || '');
  const [requiresPassphrase, setRequiresPassphrase] = useState(false);

  // Login / OTP state
  const [emailInput, setEmailInput] = useState(() => getStoredAdminEmail() || '');
  const [passphraseInput, setPassphraseInput] = useState('');
  const [otpStep, setOtpStep] = useState<'request' | 'verify'>('request');
  const [otpCode, setOtpCode] = useState('');
  const [devOtpPreview, setDevOtpPreview] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Overview data state
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [searchQuery, setSearchQuery] = useState('');
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .getAuthConfig()
      .then((cfg) => setRequiresPassphrase(cfg.requiresPassphrase))
      .catch(() => {});
  }, []);

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true);
    setOverviewError(null);
    try {
      const data = await adminApi.getOverview();
      setOverview(data);
      setAdminEmail(data.adminEmail);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearAdminSession();
        setAdminToken(null);
        setOverview(null);
        setAuthError('Owner session expired. Verify again to continue.');
      } else {
        setOverviewError(err instanceof Error ? err.message : 'Failed to load telemetry.');
      }
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  useEffect(() => {
    if (adminToken) {
      void loadOverview();
    }
  }, [adminToken, loadOverview]);

  async function handleRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthNotice(null);
    if (!isValidEmail(emailInput)) {
      setAuthError('Enter a valid owner email address.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await adminApi.requestOtp({
        email: emailInput.trim(),
        passphrase: passphraseInput || undefined,
      });
      setAdminEmail(res.email);
      setDevOtpPreview(res.devOtpPreview || null);
      setAuthNotice(res.message);
      setOtpCode('');
      setOtpStep('verify');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Unable to send owner code.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    const cleaned = otpCode.replace(/\D/g, '').slice(0, 6);
    if (cleaned.length !== 6) {
      setAuthError('Enter the complete 6-digit verification code.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await adminApi.verifyOtp({
        email: adminEmail || emailInput.trim(),
        code: cleaned,
      });
      setAdminToken(res.adminToken);
      setAdminEmail(res.adminEmail);
      setDevOtpPreview(null);
      setOtpStep('request');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevokeSession(sessionId: string) {
    setRevokingId(sessionId);
    try {
      await adminApi.revokeSession(sessionId);
      await loadOverview();
    } catch (err) {
      setOverviewError(err instanceof Error ? err.message : 'Failed to revoke session.');
    } finally {
      setRevokingId(null);
    }
  }

  function handleLogout() {
    adminApi.logout();
    setAdminToken(null);
    setOverview(null);
    setOtpStep('request');
    setAuthNotice('Signed out of the owner console.');
  }

  if (!adminToken) {
    const canRequest = isValidEmail(emailInput) && (!requiresPassphrase || passphraseInput.length > 0);
    return (
      <div
        data-testid="admin-login-screen"
        className="min-h-screen w-full bg-[#FAF8F5] text-[#1A1113] flex flex-col"
      >
        <div className="w-full max-w-md mx-auto flex-1 flex flex-col justify-center px-6 py-12">
          <div className="mb-8 flex items-center justify-between">
            <span className="font-wordmark text-[38px] leading-none tracking-[-0.02em]">
              couplova
            </span>
            <a
              href="/"
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#1A1113]/65 hover:text-[#1A1113] whitespace-nowrap"
            >
              <BackArrowIcon className="w-4 h-4" />
              <span>App</span>
            </a>
          </div>

          <div className="mb-6">
            <h1 className="font-display text-[30px] font-extrabold tracking-[-0.03em] leading-tight">
              Owner Console
            </h1>
            <p className="mt-2 text-[14px] text-[#1A1113]/65 leading-relaxed">
              Restricted monitoring for live app telemetry, couple accounts, active sessions, and email delivery health.
            </p>
          </div>

          {authNotice && (
            <div className="mb-4 rounded-[16px] bg-[#F4C2C2]/45 px-4 py-3 text-[13px] text-[#1A1113]">
              {authNotice}
            </div>
          )}

          {authError && (
            <div
              role="alert"
              className="mb-4 rounded-[16px] bg-[#9E472A] px-4 py-3 text-[13px] text-white"
            >
              {authError}
            </div>
          )}

          {otpStep === 'request' ? (
            <form onSubmit={handleRequestOtp} className="space-y-4">
              <div>
                <label htmlFor="admin-email" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                  Owner Email
                </label>
                <input
                  id="admin-email"
                  type="email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="owner@domain.com"
                  className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                />
              </div>

              {requiresPassphrase && (
                <div>
                  <label htmlFor="admin-passphrase" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Owner Passphrase
                  </label>
                  <input
                    id="admin-passphrase"
                    type="password"
                    value={passphraseInput}
                    onChange={(e) => setPassphraseInput(e.target.value)}
                    placeholder="Enter owner passphrase"
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={!canRequest || submitting}
                className={`w-full min-h-[52px] rounded-full font-display font-bold text-[15px] transition-colors ${
                  !canRequest
                    ? 'bg-[#1A1113]/20 text-[#1A1113]/45 cursor-not-allowed'
                    : 'bg-[#1A1113] text-[#FAF8F5] active:scale-[0.985] transition-transform disabled:opacity-60'
                }`}
              >
                {submitting ? 'Verifying owner...' : 'Send Owner Code'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <button
                type="button"
                onClick={() => {
                  setOtpStep('request');
                  setAuthError(null);
                  setDevOtpPreview(null);
                }}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#1A1113]/70 hover:text-[#1A1113]"
              >
                <BackArrowIcon className="w-4 h-4" />
                <span>Change email</span>
              </button>

              {devOtpPreview && (
                <div
                  data-testid="admin-otp-preview"
                  className="rounded-[16px] bg-[#B8D0E8]/55 px-4 py-3 text-[13px] text-[#0F1924]"
                >
                  Preview mode: owner code is{' '}
                  <strong className="font-display tracking-widest tabular-nums">
                    {devOtpPreview}
                  </strong>
                </div>
              )}

              <div>
                <label htmlFor="admin-otp-input" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                  6-Digit Owner Code
                </label>
                <input
                  id="admin-otp-input"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="w-full min-h-[56px] rounded-[18px] bg-[#F1EDE6] px-4 text-center font-display text-[28px] font-bold tracking-[0.35em] tabular-nums text-[#1A1113] placeholder:text-[#1A1113]/25 focus:outline-2 focus:outline-[#1A1113]"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[52px] rounded-full bg-[#1A1113] text-[#FAF8F5] font-display font-bold text-[15px] active:scale-[0.985] transition-transform disabled:opacity-60"
              >
                {submitting ? 'Opening Console...' : 'Verify & Open Console'}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredUsers = (overview?.users || []).filter((u) => {
    if (!normalizedQuery) return true;
    return (
      u.fullName.toLowerCase().includes(normalizedQuery) ||
      u.username.toLowerCase().includes(normalizedQuery) ||
      u.email.toLowerCase().includes(normalizedQuery) ||
      u.partnerName.toLowerCase().includes(normalizedQuery) ||
      u.country.toLowerCase().includes(normalizedQuery)
    );
  });

  const filteredSessions = (overview?.sessions || []).filter((s) => {
    if (!normalizedQuery) return true;
    return (
      s.userEmail.toLowerCase().includes(normalizedQuery) ||
      s.userName.toLowerCase().includes(normalizedQuery) ||
      s.id.toLowerCase().includes(normalizedQuery)
    );
  });

  const filteredOtps = (overview?.otpEvents || []).filter((o) => {
    if (!normalizedQuery) return true;
    return (
      o.email.toLowerCase().includes(normalizedQuery) ||
      o.purpose.toLowerCase().includes(normalizedQuery)
    );
  });

  return (
    <div
      data-testid="admin-dashboard-screen"
      className="min-h-screen w-full bg-[#FAF8F5] text-[#1A1113]"
    >
      <div className="w-full max-w-6xl mx-auto px-6 py-8 space-y-8">
        {/* Top Bar Contract: Brand -> Owner identity -> Primary actions */}
        <header className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-[#1A1113]/10">
          <div className="flex items-baseline gap-4">
            <a href="/" className="font-wordmark text-[36px] leading-none tracking-[-0.02em] whitespace-nowrap shrink-0">
              couplova
            </a>
            <span className="text-[13px] text-[#1A1113]/60 whitespace-nowrap">
              Owner Console · {adminEmail}
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={loadOverview}
              disabled={loadingOverview}
              aria-label="Refresh overview"
              className="min-h-[42px] px-4 rounded-full bg-[#F1EDE6] text-[#1A1113] text-[13px] font-medium inline-flex items-center gap-2 hover:bg-[#E7E1D8] transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshIcon className="w-4 h-4" />
              <span>{loadingOverview ? 'Refreshing...' : 'Refresh'}</span>
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="min-h-[42px] px-5 rounded-full bg-[#1A1113] text-[#FAF8F5] text-[13px] font-medium whitespace-nowrap shrink-0"
            >
              Sign Out
            </button>
          </div>
        </header>

        {overviewError && (
          <div role="alert" className="rounded-[18px] bg-[#9E472A] px-4 py-3 text-[14px] text-white">
            {overviewError}
          </div>
        )}

        {/* Live Telemetry Summary Row */}
        <section aria-label="Live telemetry overview" className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="rounded-[22px] bg-[#F1EDE6] p-5">
            <p className="text-[12px] font-medium text-[#1A1113]/60">Online Now (2m)</p>
            <p data-testid="admin-stat-online" className="font-display text-[30px] font-extrabold tabular-nums mt-1">
              {overview ? overview.telemetry.currentlyOnline : '-'}
            </p>
          </div>
          <div className="rounded-[22px] bg-[#F1EDE6] p-5">
            <p className="text-[12px] font-medium text-[#1A1113]/60">Active Couples (30d)</p>
            <p data-testid="admin-stat-active" className="font-display text-[30px] font-extrabold tabular-nums mt-1">
              {overview ? overview.telemetry.totalActiveUsers : '-'}
            </p>
          </div>
          <div className="rounded-[22px] bg-[#F1EDE6] p-5">
            <p className="text-[12px] font-medium text-[#1A1113]/60">Registered Accounts</p>
            <p className="font-display text-[30px] font-extrabold tabular-nums mt-1">
              {overview ? overview.telemetry.totalUsers ?? 0 : '-'}
            </p>
          </div>
          <div className="rounded-[22px] bg-[#F1EDE6] p-5">
            <p className="text-[12px] font-medium text-[#1A1113]/60">Active Sessions</p>
            <p className="font-display text-[30px] font-extrabold tabular-nums mt-1">
              {overview ? overview.telemetry.activeSessionsCount ?? 0 : '-'}
            </p>
          </div>
          <div className="rounded-[22px] bg-[#F1EDE6] p-5 col-span-2 md:col-span-1">
            <p className="text-[12px] font-medium text-[#1A1113]/60">Saved Cards</p>
            <p className="font-display text-[30px] font-extrabold tabular-nums mt-1">
              {overview ? overview.telemetry.totalSavedCards ?? 0 : '-'}
            </p>
          </div>
        </section>

        {/* Server Delivery & Integration Health */}
        {overview && (
          <section className="flex flex-wrap items-center justify-between gap-4 py-3 px-5 rounded-[18px] bg-[#F1EDE6] text-[13px]">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[#1A1113]/80">
              <span>
                Environment: <strong className="font-semibold text-[#1A1113]">{overview.system.environment}</strong>
              </span>
              {overview.system.databaseMode && (
                <span>
                  Storage: <strong className="font-semibold text-[#1A1113]">{overview.system.databaseMode}</strong>
                </span>
              )}
              <span>
                Gmail SMTP:{' '}
                <strong className="font-semibold text-[#1A1113]">
                  {overview.system.gmailSmtpConfigured ? 'Configured' : 'Not set'}
                </strong>
              </span>
              <span>
                Resend:{' '}
                <strong className="font-semibold text-[#1A1113]">
                  {overview.system.resendConfigured ? 'Configured' : 'Not set'}
                </strong>
              </span>
              <span>
                Google OAuth:{' '}
                <strong className="font-semibold text-[#1A1113]">
                  {overview.system.googleOAuthConfigured ? 'Configured' : 'Not set'}
                </strong>
              </span>
            </div>
            <span className="text-[#1A1113]/55 tabular-nums">
              Synced {formatTimestamp(overview.system.serverTime)}
            </span>
          </section>
        )}

        {/* Filter & Navigation Tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="inline-flex items-center gap-1 p-1 rounded-full bg-[#F1EDE6] self-start">
            {(
              [
                { id: 'users', label: `Accounts (${overview?.users.length ?? 0})` },
                { id: 'sessions', label: `Sessions (${overview?.sessions.length ?? 0})` },
                { id: 'otps', label: `OTP Log (${overview?.otpEvents.length ?? 0})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 rounded-full text-[13px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === tab.id
                    ? 'bg-[#1A1113] text-[#FAF8F5]'
                    : 'text-[#1A1113]/70 hover:text-[#1A1113]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by name, email, partner, country..."
            aria-label="Filter admin records"
            className="w-full sm:w-80 min-h-[42px] rounded-full bg-[#F1EDE6] px-4 text-[13px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
          />
        </div>

        {/* Data Tables */}
        {activeTab === 'users' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[#1A1113]/12 text-[#1A1113]/60">
                  <th className="py-3 pr-4 font-medium">User</th>
                  <th className="py-3 px-4 font-medium">Partner</th>
                  <th className="py-3 px-4 font-medium">Auth &amp; Status</th>
                  <th className="py-3 px-4 font-medium">Theme / Country</th>
                  <th className="py-3 px-4 font-medium text-right">Saved</th>
                  <th className="py-3 pl-4 font-medium text-right">Last Seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1A1113]/8">
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-[#1A1113]/55">
                      No matching couple accounts found.
                    </td>
                  </tr>
                ) : (
                  filteredUsers.map((u) => (
                    <tr key={u.id} className="hover:bg-[#F1EDE6]/55 transition-colors">
                      <td className="py-3 pr-4">
                        <p className="font-semibold text-[#1A1113]">
                          {u.fullName}{' '}
                          <span className="font-normal text-[#1A1113]/55">@{u.username}</span>
                        </p>
                        <p className="text-[#1A1113]/65">{u.email}</p>
                      </td>
                      <td className="py-3 px-4 font-medium">{u.partnerName || '-'}</td>
                      <td className="py-3 px-4">
                        <p className="text-[#1A1113]">{u.authMethod}</p>
                        <p className="text-[12px] text-[#1A1113]/60">
                          {u.isVerified ? 'Verified' : 'Pending Verification'}
                          {u.onlineNow ? ' · Online now' : ''}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-[#1A1113]/75">
                        {u.genderTheme === 'female' ? 'Her' : 'Him'} / {u.activeDeckTheme}
                        {u.country ? ` · ${u.country}` : ''}
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums font-medium">
                        {u.savedCardsCount}
                      </td>
                      <td className="py-3 pl-4 text-right tabular-nums text-[#1A1113]/65 whitespace-nowrap">
                        {formatTimestamp(u.lastSeenAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'sessions' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[#1A1113]/12 text-[#1A1113]/60">
                  <th className="py-3 pr-4 font-medium">Account</th>
                  <th className="py-3 px-4 font-medium">Session ID</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium text-right">Last Active</th>
                  <th className="py-3 pl-4 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1A1113]/8">
                {filteredSessions.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-[#1A1113]/55">
                      No matching sessions found.
                    </td>
                  </tr>
                ) : (
                  filteredSessions.map((s) => {
                    const statusLabel = s.revoked
                      ? 'Revoked'
                      : s.expired
                        ? 'Expired'
                        : 'Active';
                    return (
                      <tr key={s.id} className="hover:bg-[#F1EDE6]/55 transition-colors">
                        <td className="py-3 pr-4">
                          <p className="font-semibold">{s.userName}</p>
                          <p className="text-[#1A1113]/65">{s.userEmail}</p>
                        </td>
                        <td className="py-3 px-4 font-mono text-[12px] text-[#1A1113]/70">
                          {s.id.slice(0, 8)}
                        </td>
                        <td className="py-3 px-4 font-medium">
                          <span className={s.revoked || s.expired ? 'text-[#9E472A]' : 'text-[#556B2F]'}>
                            {statusLabel}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums text-[#1A1113]/65 whitespace-nowrap">
                          {formatTimestamp(s.lastActiveAt)}
                        </td>
                        <td className="py-3 pl-4 text-right">
                          {!s.revoked ? (
                            <button
                              type="button"
                              onClick={() => handleRevokeSession(s.id)}
                              disabled={revokingId === s.id}
                              className="px-3.5 py-1.5 rounded-full bg-[#F1EDE6] hover:bg-[#9E472A] hover:text-white text-[12px] font-medium transition-colors whitespace-nowrap"
                            >
                              {revokingId === s.id ? 'Revoking...' : 'Revoke'}
                            </button>
                          ) : (
                            <span className="text-[12px] text-[#1A1113]/40">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'otps' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-[#1A1113]/12 text-[#1A1113]/60">
                  <th className="py-3 pr-4 font-medium">Email</th>
                  <th className="py-3 px-4 font-medium">Purpose</th>
                  <th className="py-3 px-4 font-medium">State</th>
                  <th className="py-3 px-4 font-medium text-right">Attempts</th>
                  <th className="py-3 pl-4 font-medium text-right">Issued</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1A1113]/8">
                {filteredOtps.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-[#1A1113]/55">
                      No recent OTP verification records.
                    </td>
                  </tr>
                ) : (
                  filteredOtps.map((o) => (
                    <tr key={o.id} className="hover:bg-[#F1EDE6]/55 transition-colors">
                      <td className="py-3 pr-4 font-medium">{o.email}</td>
                      <td className="py-3 px-4 capitalize">{o.purpose}</td>
                      <td className="py-3 px-4 text-[#1A1113]/75">
                        {o.used ? 'Used / Invalidated' : 'Pending'}
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums">{o.attempts} / 3</td>
                      <td className="py-3 pl-4 text-right tabular-nums text-[#1A1113]/65 whitespace-nowrap">
                        {formatTimestamp(o.createdAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
