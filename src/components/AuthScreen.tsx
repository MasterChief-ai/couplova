import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ApiError, couplyApi, type OtpChallengeResponse } from '../services/api';
import { LOCKED_SPLASH_TOKENS, type GenderTheme } from '../constants/theme';
import type { CouplyUser } from '../services/storage';
import { loadGoogleIdentityServices, type GoogleAccountsId } from '../utils/googleGsi';
import {
  OTP_RESEND_COOLDOWN_SECONDS,
  getPasswordErrorMessage,
  isStrongPassword,
  isValidDateOfBirth,
  isValidEmail,
  validateSignupForm,
} from '../utils/gameLogic';
import { BackArrowIcon, CheckIcon, GoogleLogoIcon } from './Icons';

interface AuthScreenProps {
  initialNotice?: string | null;
  onAuthenticated: (user: CouplyUser) => void;
}

type AuthStep = 'login' | 'signup' | 'verify-otp' | 'google-complete';

export function AuthScreen({ initialNotice, onAuthenticated }: AuthScreenProps) {
  const [step, setStep] = useState<AuthStep>('login');
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Login fields
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Signup fields
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [country, setCountry] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [partnerName, setPartnerName] = useState('');
  const [genderTheme, setGenderTheme] = useState<GenderTheme>('female');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [offerLoginForEmail, setOfferLoginForEmail] = useState<string | null>(null);

  // Google profile completion fields
  const [googlePendingToken, setGooglePendingToken] = useState('');
  const [googlePrefillEmail, setGooglePrefillEmail] = useState('');
  const [googlePrefillName, setGooglePrefillName] = useState('');
  const [googleUsername, setGoogleUsername] = useState('');
  const [googlePartnerName, setGooglePartnerName] = useState('');
  const [googleDob, setGoogleDob] = useState('');
  const [googleGender, setGoogleGender] = useState<GenderTheme>('female');
  const [googleAcceptedTerms, setGoogleAcceptedTerms] = useState(false);

  // OTP fields
  const [otpEmail, setOtpEmail] = useState('');
  const [otpPurpose, setOtpPurpose] = useState<'signup' | 'login'>('signup');
  const [otpCode, setOtpCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [devOtpPreview, setDevOtpPreview] = useState<string | null>(null);
  const [loginEmailTouched, setLoginEmailTouched] = useState(false);
  const [loginPasswordError, setLoginPasswordError] = useState<string | null>(null);
  const [signupEmailTouched, setSignupEmailTouched] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [usernameTakenError, setUsernameTakenError] = useState<string | null>(null);
  const [googleUsernameTakenError, setGoogleUsernameTakenError] = useState<string | null>(null);
  const [resolvedGoogleClientId, setResolvedGoogleClientId] = useState<string | null>(
    import.meta.env.VITE_GOOGLE_CLIENT_ID || null,
  );
  const [showGoogleFallbackButton, setShowGoogleFallbackButton] = useState(false);
  const googleFallbackRef = useRef<HTMLDivElement | null>(null);

  const loginEmailValid = isValidEmail(loginEmail);
  const signupEmailValid = isValidEmail(signupEmail);
  const signupPasswordError = getPasswordErrorMessage(password);
  const signupPasswordValid = isStrongPassword(password);
  const signupPasswordsMatch = Boolean(password && confirmPassword && password === confirmPassword);

  const canLogin = Boolean(loginEmailValid && loginPassword);
  const canCreateAccount = Boolean(
    fullName.trim().length >= 2 &&
      /^[a-zA-Z0-9_]{3,24}$/.test(username.trim()) &&
      usernameStatus !== 'taken' &&
      !usernameTakenError &&
      partnerName.trim().length >= 1 &&
      partnerName.trim().length <= 40 &&
      signupEmailValid &&
      signupPasswordValid &&
      signupPasswordsMatch &&
      (genderTheme === 'female' || genderTheme === 'male') &&
      acceptedTerms,
  );
  const canCompleteGoogle = Boolean(
    /^[a-zA-Z0-9_]{3,24}$/.test(googleUsername.trim()) &&
      !googleUsernameTakenError &&
      googlePartnerName.trim().length >= 1 &&
      googlePartnerName.trim().length <= 40 &&
      (!googleDob.trim() || isValidDateOfBirth(googleDob)) &&
      googleAcceptedTerms,
  );

  useEffect(() => {
    if (initialNotice !== undefined) {
      setNotice(initialNotice ?? null);
    }
  }, [initialNotice]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => {
      setCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  useEffect(() => {
    let active = true;
    void loadGoogleIdentityServices();
    if (!resolvedGoogleClientId) {
      couplyApi
        .getPublicConfig()
        .then((cfg) => {
          if (active && cfg.googleClientId) {
            setResolvedGoogleClientId(cfg.googleClientId);
          }
        })
        .catch(() => {
          // Ignore network error during background config prefetch
        });
    }
    return () => {
      active = false;
    };
  }, [resolvedGoogleClientId]);

  useEffect(() => {
    const trimmed = username.trim();
    if (step !== 'signup' || !/^[a-zA-Z0-9_]{3,24}$/.test(trimmed)) {
      setUsernameStatus('idle');
      setUsernameTakenError(null);
      return;
    }

    let cancelled = false;
    setUsernameStatus('checking');
    const timer = window.setTimeout(() => {
      couplyApi
        .checkUsername(trimmed)
        .then((res) => {
          if (cancelled) return;
          if (!res.available) {
            setUsernameStatus('taken');
            setUsernameTakenError(
              res.error || 'That username already exists. Please pick another one.',
            );
          } else {
            setUsernameStatus('available');
            setUsernameTakenError(null);
          }
        })
        .catch(() => {
          if (!cancelled) setUsernameStatus('idle');
        });
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [username, step]);

  useEffect(() => {
    const trimmed = googleUsername.trim();
    if (step !== 'google-complete' || !/^[a-zA-Z0-9_]{3,24}$/.test(trimmed)) {
      setGoogleUsernameTakenError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      couplyApi
        .checkUsername(trimmed)
        .then((res) => {
          if (cancelled) return;
          setGoogleUsernameTakenError(
            res.available
              ? null
              : res.error || 'That username already exists. Please pick another one.',
          );
        })
        .catch(() => {
          if (!cancelled) setGoogleUsernameTakenError(null);
        });
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [googleUsername, step]);

  function handleOtpChallenge(res: OtpChallengeResponse) {
    setOtpEmail(res.email);
    setOtpPurpose(res.purpose);
    setCooldown(res.cooldownSeconds || OTP_RESEND_COOLDOWN_SECONDS);
    setDevOtpPreview(res.devOtpPreview || null);
    setOtpCode('');
    setError(null);
    setNotice(res.message);
    setStep('verify-otp');
  }

  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoginPasswordError(null);
    setOfferLoginForEmail(null);
    if (!isValidEmail(loginEmail)) {
      setLoginEmailTouched(true);
      setError('Please enter a valid email address.');
      return;
    }
    if (!loginPassword) {
      setLoginPasswordError('Enter your password.');
      setError('Enter your password.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await couplyApi.login({ email: loginEmail.trim(), password: loginPassword });
      handleOtpChallenge(res);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'USER_NOT_FOUND') {
        setSignupEmail(loginEmail.trim());
        setFieldErrors({});
        setError(null);
        setLoginPasswordError(null);
        setNotice("No account exists for that email yet. Create your Couplova account below.");
        setStep('signup');
      } else if (
        err instanceof ApiError &&
        (err.code === 'INCORRECT_PASSWORD' || err.status === 401)
      ) {
        const msg = err.message || 'Incorrect password for this account. Please try again.';
        setLoginPasswordError(msg);
        setError(msg);
      } else {
        setError(err instanceof Error ? err.message : 'Unable to log in.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignupSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setOfferLoginForEmail(null);

    const validation = validateSignupForm({
      fullName,
      username,
      country,
      dateOfBirth,
      email: signupEmail,
      password,
      confirmPassword,
      genderTheme,
      partnerName,
      acceptedTerms,
    });

    if (usernameTakenError) {
      validation.valid = false;
      validation.errors.username = usernameTakenError;
    }

    setFieldErrors(validation.errors);
    if (!validation.valid) {
      setError('Please fix the highlighted fields before continuing.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await couplyApi.signup({
        fullName: fullName.trim(),
        username: username.trim(),
        country: country.trim(),
        dateOfBirth: dateOfBirth.trim(),
        email: signupEmail.trim(),
        password,
        confirmPassword,
        genderTheme,
        partnerName: partnerName.trim() || 'Partner',
        acceptedTerms,
      });
      handleOtpChallenge(res);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_ALREADY_EXISTS') {
        setOfferLoginForEmail(signupEmail.trim());
        setFieldErrors((prev) => ({ ...prev, email: err.message }));
      } else if (err instanceof ApiError && err.code === 'USERNAME_TAKEN') {
        setUsernameStatus('taken');
        setUsernameTakenError(err.message);
        setFieldErrors((prev) => ({ ...prev, username: err.message }));
      }
      setError(err instanceof Error ? err.message : 'Unable to create account.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const cleaned = otpCode.replace(/\D/g, '').slice(0, 6);
    if (cleaned.length !== 6) {
      setError('Enter the complete 6-digit verification code.');
      return;
    }
    setSubmitting(true);
    try {
      const session = await couplyApi.verifyOtp({
        email: otpEmail,
        code: cleaned,
        purpose: otpPurpose,
      });
      onAuthenticated(session.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid verification code.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendOtp() {
    if (cooldown > 0) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await couplyApi.resendOtp({ email: otpEmail, purpose: otpPurpose });
      setCooldown(res.cooldownSeconds || OTP_RESEND_COOLDOWN_SECONDS);
      setDevOtpPreview(res.devOtpPreview || null);
      setNotice(res.message);
    } catch (err) {
      if (err instanceof ApiError && err.retryAfterSeconds) {
        setCooldown(err.retryAfterSeconds);
      }
      setError(err instanceof Error ? err.message : 'Unable to resend code.');
    } finally {
      setSubmitting(false);
    }
  }

  function renderGooglePopupFallback(googleAccounts: GoogleAccountsId) {
    setShowGoogleFallbackButton(true);
    window.requestAnimationFrame(() => {
      const host = googleFallbackRef.current;
      if (!host) return;
      host.innerHTML = '';
      googleAccounts.renderButton(host, {
        theme: 'outline',
        size: 'large',
        shape: 'pill',
        text: step === 'signup' ? 'signup_with' : 'continue_with',
        width: Math.min(360, host.clientWidth || 320),
      });
    });
  }

  async function handleGoogleSignIn() {
    setError(null);
    let googleClientId =
      resolvedGoogleClientId || import.meta.env.VITE_GOOGLE_CLIENT_ID || null;

    if (!googleClientId) {
      try {
        const cfg = await couplyApi.getPublicConfig();
        if (cfg.googleClientId) {
          googleClientId = cfg.googleClientId;
          setResolvedGoogleClientId(cfg.googleClientId);
        }
      } catch {
        // Fall through to missing config message
      }
    }

    if (!googleClientId) {
      setError(
        'Google Sign-In needs GOOGLE_CLIENT_ID (or VITE_GOOGLE_CLIENT_ID) in environment secrets.',
      );
      return;
    }

    const googleAccounts = await loadGoogleIdentityServices();
    if (!googleAccounts) {
      setError('Unable to load Google Identity Services. Check your connection and try again.');
      return;
    }

    googleAccounts.initialize({
      client_id: googleClientId,
      ux_mode: 'popup',
      use_fedcm_for_prompt: true,
      callback: async (response: { credential?: string }) => {
        if (!response.credential) return;
        setSubmitting(true);
        try {
          const result = await couplyApi.googleSignIn({
            idToken: response.credential,
          });
          if ('needsProfileCompletion' in result && result.needsProfileCompletion) {
            setGooglePendingToken(result.pendingToken);
            setGooglePrefillEmail(result.prefill.email);
            setGooglePrefillName(result.prefill.fullName);
            setGoogleUsername('');
            setGooglePartnerName('');
            setGoogleDob('');
            setGoogleAcceptedTerms(false);
            setShowGoogleFallbackButton(false);
            setError(null);
            setNotice(null);
            setStep('google-complete');
          } else if ('user' in result) {
            onAuthenticated(result.user);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Google Sign-In failed.');
        } finally {
          setSubmitting(false);
        }
      },
    });

    googleAccounts.prompt();
    renderGooglePopupFallback(googleAccounts);
  }

  async function handleCompleteGoogleProfile(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!/^[a-zA-Z0-9_]{3,24}$/.test(googleUsername.trim())) {
      setError('Username must be 3–24 letters, numbers, or underscores.');
      return;
    }
    if (!googlePartnerName.trim() || googlePartnerName.trim().length > 40) {
      setError("Please enter your partner's name (max 40 characters).");
      return;
    }
    if (googleDob.trim() && !isValidDateOfBirth(googleDob)) {
      setError('Please enter a valid date of birth (13+).');
      return;
    }
    if (!googleAcceptedTerms) {
      setError('You must agree to the Terms & Conditions.');
      return;
    }

    setSubmitting(true);
    try {
      const session = await couplyApi.completeGoogleProfile({
        pendingToken: googlePendingToken,
        username: googleUsername.trim(),
        partnerName: googlePartnerName.trim(),
        dateOfBirth: googleDob.trim(),
        genderTheme: googleGender,
        acceptedTerms: googleAcceptedTerms,
      });
      onAuthenticated(session.user);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'USERNAME_TAKEN') {
        setGoogleUsernameTakenError(err.message);
      }
      setError(err instanceof Error ? err.message : 'Unable to finish setup.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDemoSession() {
    setError(null);
    setSubmitting(true);
    try {
      const session = await couplyApi.demoSignIn();
      onAuthenticated(session.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start demo session.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-[#FAF8F5] text-[#1A1113] flex flex-col">
      <div className="w-full max-w-6xl mx-auto flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 px-6 py-8 lg:py-14 items-center">
        {/* Editorial Left Column (visible cleanly on desktop, compact header on mobile) */}
        <section className="lg:col-span-5 flex flex-col justify-between gap-6">
          <div>
            <span className="font-wordmark text-[42px] leading-none tracking-[-0.02em] text-[#1A1113] block mb-6">
              couplova
            </span>
            <h1 className="font-display text-[32px] lg:text-[40px] font-extrabold leading-[1.12] tracking-[-0.03em] text-[#1A1113] max-w-md [text-wrap:balance]">
              Intimate pass-and-play cards for two.
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-[#1A1113]/65 max-w-md">
              For Romeo &amp; Juliet couples who want to deepen their relationship beyond a Friday dinner date at a five-star restaurant.
            </p>
          </div>

          <div className="hidden lg:grid grid-cols-2 gap-3 pt-4 max-w-md">
            <div className="rounded-[24px] p-5 bg-[#9E472A] text-white">
              <p className="text-[12px] font-medium text-white/75">01 · Core Deck</p>
              <p className="font-display font-bold text-[18px] mt-1 tracking-tight">Balls Deep Conversations</p>
            </div>
            <div className="rounded-[24px] p-5 bg-[#F4C2C2] text-[#1A1113]">
              <p className="text-[12px] font-medium text-[#1A1113]/65">03 · 3 Tiers</p>
              <p className="font-display font-bold text-[18px] mt-1 tracking-tight">Closer Than You Think</p>
            </div>
          </div>
        </section>

        {/* Form Column */}
        <section className="lg:col-span-7 w-full max-w-lg mx-auto lg:mx-0 lg:ml-auto">
          {(step === 'login' || step === 'signup') && (
            <div className="flex items-center gap-2 p-1.5 bg-[#F1EDE6] rounded-full mb-7">
              <button
                type="button"
                onClick={() => {
                  setStep('login');
                  setError(null);
                  setOfferLoginForEmail(null);
                  setFieldErrors({});
                  setShowGoogleFallbackButton(false);
                }}
                className={`flex-1 min-h-[44px] rounded-full text-[14px] font-medium transition-colors ${
                  step === 'login'
                    ? 'bg-[#1A1113] text-[#FAF8F5]'
                    : 'text-[#1A1113]/70 hover:text-[#1A1113]'
                }`}
              >
                Log In
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep('signup');
                  setError(null);
                  setOfferLoginForEmail(null);
                  setFieldErrors({});
                  setShowGoogleFallbackButton(false);
                }}
                className={`flex-1 min-h-[44px] rounded-full text-[14px] font-medium transition-colors ${
                  step === 'signup'
                    ? 'bg-[#1A1113] text-[#FAF8F5]'
                    : 'text-[#1A1113]/70 hover:text-[#1A1113]'
                }`}
              >
                Sign Up
              </button>
            </div>
          )}

          {notice && (
            <div className="mb-5 rounded-[18px] bg-[#F4C2C2]/45 px-4 py-3 text-[14px] text-[#1A1113]">
              {notice}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-5 rounded-[18px] bg-[#9E472A] px-4 py-3 text-[14px] text-white flex flex-wrap items-center justify-between gap-3"
            >
              <span>{error}</span>
              {offerLoginForEmail && (
                <button
                  type="button"
                  onClick={() => {
                    setLoginEmail(offerLoginForEmail);
                    setError(null);
                    setOfferLoginForEmail(null);
                    setNotice('Enter your password to log in to your existing account.');
                    setStep('login');
                  }}
                  className="px-4 py-1.5 rounded-full bg-white text-[#9E472A] font-display font-bold text-[13px] shrink-0"
                >
                  Log in instead
                </button>
              )}
            </div>
          )}

          <AnimatePresence mode="wait" initial={false}>
            {step === 'login' && (
              <motion.form
                key="login-form"
                initial={{ opacity: 0, y: 30 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transition: { duration: 0.72, ease: [0.22, 1, 0.36, 1] },
                }}
                exit={{
                  opacity: 0,
                  y: -10,
                  transition: { duration: 0.22, ease: [0.4, 0, 0.6, 1] },
                }}
                onSubmit={handleLoginSubmit}
                className="space-y-4"
              >
                <div>
                  <label htmlFor="login-email" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Email
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    value={loginEmail}
                    onChange={(e) => {
                      setLoginEmail(e.target.value);
                      if (error) setError(null);
                      if (loginPasswordError) setLoginPasswordError(null);
                    }}
                    onBlur={() => setLoginEmailTouched(true)}
                    placeholder="maya@couplova.app"
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                  />
                  {loginEmailTouched && loginEmail.trim() && !loginEmailValid && (
                    <p className="mt-1 text-[12px] text-[#9E472A]">
                      Enter a valid email address (e.g. maya@couplova.app).
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="login-password" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Password
                  </label>
                  <input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => {
                      setLoginPassword(e.target.value);
                      if (loginPasswordError) setLoginPasswordError(null);
                      if (error) setError(null);
                    }}
                    placeholder="Enter your password"
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                  />
                  {loginPasswordError && (
                    <p className="mt-1 text-[12px] text-[#9E472A]">{loginPasswordError}</p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={!canLogin || submitting}
                  className={`w-full min-h-[52px] rounded-full font-display font-bold text-[15px] tracking-tight transition-colors ${
                    !canLogin
                      ? 'bg-[#1A1113]/20 text-[#1A1113]/45 cursor-not-allowed'
                      : 'bg-[#1A1113] text-[#FAF8F5] active:scale-[0.985] transition-transform disabled:opacity-60'
                  }`}
                >
                  {submitting ? 'Checking account...' : 'Login'}
                </button>

                <div className="pt-2 space-y-3">
                  <button
                    type="button"
                    onClick={handleGoogleSignIn}
                    disabled={submitting}
                    className="w-full min-h-[48px] rounded-full bg-[#F1EDE6] text-[#1A1113] font-medium text-[14px] hover:bg-[#E7E1D8] transition-colors flex items-center justify-center gap-2.5"
                  >
                    <GoogleLogoIcon className="w-[18px] h-[18px]" />
                    <span>Continue with Google</span>
                  </button>

                  {showGoogleFallbackButton && (
                    <div className="rounded-[18px] bg-[#F1EDE6] p-3 flex flex-col items-center gap-2">
                      <p className="text-[12px] text-[#1A1113]/65 text-center">
                        Tap Google&apos;s secure popup button below to finish signing in:
                      </p>
                      <div ref={googleFallbackRef} className="w-full flex justify-center" />
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleDemoSession}
                    disabled={submitting}
                    className="w-full min-h-[48px] rounded-full bg-[#F4C2C2] text-[#1A1113] font-medium text-[14px] hover:bg-[#E8AEAE] transition-colors"
                  >
                    Play Instantly as Maya &amp; Julian (Demo)
                  </button>
                </div>
              </motion.form>
            )}

            {step === 'signup' && (
              <motion.form
                key="signup-form"
                initial={{ opacity: 0, y: 34 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transition: { duration: 0.76, ease: [0.22, 1, 0.36, 1] },
                }}
                exit={{
                  opacity: 0,
                  y: -10,
                  transition: { duration: 0.22, ease: [0.4, 0, 0.6, 1] },
                }}
                onSubmit={handleSignupSubmit}
                className="space-y-4"
              >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="signup-fullname" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Full Name
                  </label>
                  <input
                    id="signup-fullname"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Maya Lin"
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                  />
                  {fieldErrors.fullName && (
                    <p className="mt-1 text-[12px] text-[#9E472A]">{fieldErrors.fullName}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="signup-username" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Username
                  </label>
                  <input
                    id="signup-username"
                    type="text"
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      if (fieldErrors.username) {
                        setFieldErrors((prev) => {
                          const next = { ...prev };
                          delete next.username;
                          return next;
                        });
                      }
                    }}
                    placeholder="maya_lin"
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                  />
                  {(fieldErrors.username || usernameTakenError) && (
                    <p className="mt-1 text-[12px] text-[#9E472A]">
                      {fieldErrors.username || usernameTakenError}
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="signup-country" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Country <span className="text-[#1A1113]/40 font-normal">(optional)</span>
                  </label>
                  <input
                    id="signup-country"
                    type="text"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    placeholder="United States"
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                  />
                  {fieldErrors.country && (
                    <p className="mt-1 text-[12px] text-[#9E472A]">{fieldErrors.country}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="signup-partner" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Partner&apos;s Name
                  </label>
                  <input
                    id="signup-partner"
                    type="text"
                    value={partnerName}
                    onChange={(e) => setPartnerName(e.target.value)}
                    placeholder="Julian"
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                  />
                  {fieldErrors.partnerName && (
                    <p className="mt-1 text-[12px] text-[#9E472A]">{fieldErrors.partnerName}</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="signup-dob" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Date of Birth <span className="text-[#1A1113]/40 font-normal">(optional)</span>
                  </label>
                  <input
                    id="signup-dob"
                    type="date"
                    value={dateOfBirth}
                    onChange={(e) => setDateOfBirth(e.target.value)}
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] focus:outline-2 focus:outline-[#1A1113]"
                  />
                  {fieldErrors.dateOfBirth && (
                    <p className="mt-1 text-[12px] text-[#9E472A]">{fieldErrors.dateOfBirth}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="signup-email" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Email
                  </label>
                  <input
                    id="signup-email"
                    type="email"
                    value={signupEmail}
                    onChange={(e) => setSignupEmail(e.target.value)}
                    onBlur={() => setSignupEmailTouched(true)}
                    placeholder="you@example.com"
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                  />
                  {(fieldErrors.email ||
                    (signupEmailTouched && signupEmail.trim() && !signupEmailValid)) && (
                    <p className="mt-1 text-[12px] text-[#9E472A]">
                      {fieldErrors.email || 'Enter a valid email address (e.g. you@example.com).'}
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="signup-password" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Create Password
                  </label>
                  <input
                    id="signup-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="8+ chars, A-z, 0-9 & symbol"
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                  />
                  {(fieldErrors.password || (password.length > 0 && signupPasswordError)) && (
                    <p className="mt-1 text-[12px] text-[#9E472A]">
                      {fieldErrors.password || signupPasswordError}
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="signup-confirm" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Confirm Password
                  </label>
                  <input
                    id="signup-confirm"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                  />
                  {(fieldErrors.confirmPassword ||
                    (confirmPassword.length > 0 && !signupPasswordsMatch)) && (
                    <p className="mt-1 text-[12px] text-[#9E472A]">
                      {fieldErrors.confirmPassword || 'Passwords do not match.'}
                    </p>
                  )}
                </div>
              </div>

              {/* Gender Theme Selector (Permanently locks boot splash color) */}
              <div>
                <span className="block text-[13px] font-medium text-[#1A1113]/75 mb-2">
                  Lock Your Boot Splash Theme
                </span>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setGenderTheme('female')}
                    style={{
                      backgroundColor:
                        genderTheme === 'female'
                          ? LOCKED_SPLASH_TOKENS.female.canvas
                          : '#F1EDE6',
                      color: LOCKED_SPLASH_TOKENS.female.primaryInk,
                    }}
                    className="min-h-[54px] rounded-[18px] px-4 flex items-center justify-between font-display font-bold text-[15px] transition-colors"
                  >
                    <span>Her</span>
                    {genderTheme === 'female' && <CheckIcon className="w-4 h-4" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => setGenderTheme('male')}
                    style={{
                      backgroundColor:
                        genderTheme === 'male'
                          ? LOCKED_SPLASH_TOKENS.male.canvas
                          : '#F1EDE6',
                      color: LOCKED_SPLASH_TOKENS.male.primaryInk,
                    }}
                    className="min-h-[54px] rounded-[18px] px-4 flex items-center justify-between font-display font-bold text-[15px] transition-colors"
                  >
                    <span>Him</span>
                    {genderTheme === 'male' && <CheckIcon className="w-4 h-4" />}
                  </button>
                </div>
                {fieldErrors.genderTheme && (
                  <p className="mt-1 text-[12px] text-[#9E472A]">{fieldErrors.genderTheme}</p>
                )}
              </div>

              {/* Required Terms & Conditions */}
              <div>
                <label className="flex items-start gap-3 cursor-pointer py-1">
                  <input
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={(e) => setAcceptedTerms(e.target.checked)}
                    className="mt-0.5 h-5 w-5 accent-[#1A1113] rounded"
                  />
                  <span className="text-[13px] leading-snug text-[#1A1113]/75">
                    I agree to the Couplova Terms &amp; Conditions and Privacy Policy.
                  </span>
                </label>
                {fieldErrors.acceptedTerms && (
                  <p className="mt-1 text-[12px] text-[#9E472A]">{fieldErrors.acceptedTerms}</p>
                )}
              </div>

              <button
                type="submit"
                disabled={!canCreateAccount || submitting}
                className={`w-full min-h-[52px] rounded-full font-display font-bold text-[15px] tracking-tight transition-colors ${
                  !canCreateAccount
                    ? 'bg-[#1A1113]/20 text-[#1A1113]/45 cursor-not-allowed'
                    : 'bg-[#1A1113] text-[#FAF8F5] active:scale-[0.985] transition-transform disabled:opacity-60'
                }`}
              >
                {submitting ? 'Creating Account...' : 'Create Account'}
              </button>

              <div className="pt-1 space-y-3">
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  disabled={submitting}
                  className="w-full min-h-[48px] rounded-full bg-[#F1EDE6] text-[#1A1113] font-medium text-[14px] hover:bg-[#E7E1D8] transition-colors flex items-center justify-center gap-2.5"
                >
                  <GoogleLogoIcon className="w-[18px] h-[18px]" />
                  <span>Continue with Google</span>
                </button>

                {showGoogleFallbackButton && (
                  <div className="rounded-[18px] bg-[#F1EDE6] p-3 flex flex-col items-center gap-2">
                    <p className="text-[12px] text-[#1A1113]/65 text-center">
                      Tap Google&apos;s secure popup button below to continue:
                    </p>
                    <div ref={googleFallbackRef} className="w-full flex justify-center" />
                  </div>
                )}
              </div>
            </motion.form>
            )}
          </AnimatePresence>

          {step === 'google-complete' && (
            <motion.form
              key="google-complete-form"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
              onSubmit={handleCompleteGoogleProfile}
              className="space-y-4"
            >
              <button
                type="button"
                onClick={() => {
                  setStep('login');
                  setError(null);
                }}
                className="inline-flex items-center gap-2 min-h-[44px] text-[14px] font-medium text-[#1A1113]/70 hover:text-[#1A1113]"
              >
                <BackArrowIcon className="w-4 h-4" />
                <span>Back</span>
              </button>

              <div>
                <h2 className="font-display text-[28px] font-extrabold tracking-[-0.03em] text-[#1A1113]">
                  Finish your Couplova profile
                </h2>
                <p className="mt-1 text-[14px] text-[#1A1113]/65">
                  Signed in with Google as <span className="font-medium text-[#1A1113]">{googlePrefillName}</span> ({googlePrefillEmail}). Pick a unique username and enter your partner&apos;s name.
                </p>
              </div>

              <div>
                <label htmlFor="google-username" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                  Choose Username
                </label>
                <input
                  id="google-username"
                  type="text"
                  value={googleUsername}
                  onChange={(e) => setGoogleUsername(e.target.value)}
                  placeholder="romeo_juliet"
                  className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                />
                {googleUsernameTakenError && (
                  <p className="mt-1 text-[12px] text-[#9E472A]">{googleUsernameTakenError}</p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="google-partner" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Partner&apos;s Name
                  </label>
                  <input
                    id="google-partner"
                    type="text"
                    value={googlePartnerName}
                    onChange={(e) => setGooglePartnerName(e.target.value)}
                    placeholder="Juliet"
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] placeholder:text-[#1A1113]/40 focus:outline-2 focus:outline-[#1A1113]"
                  />
                </div>

                <div>
                  <label htmlFor="google-dob" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                    Date of Birth <span className="text-[#1A1113]/40 font-normal">(optional)</span>
                  </label>
                  <input
                    id="google-dob"
                    type="date"
                    value={googleDob}
                    onChange={(e) => setGoogleDob(e.target.value)}
                    className="w-full min-h-[48px] rounded-[16px] bg-[#F1EDE6] px-4 text-[15px] text-[#1A1113] focus:outline-2 focus:outline-[#1A1113]"
                  />
                </div>
              </div>

              <div>
                <span className="block text-[13px] font-medium text-[#1A1113]/75 mb-2">
                  Lock Your Boot Splash Theme
                </span>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setGoogleGender('female')}
                    style={{
                      backgroundColor:
                        googleGender === 'female'
                          ? LOCKED_SPLASH_TOKENS.female.canvas
                          : '#F1EDE6',
                      color: LOCKED_SPLASH_TOKENS.female.primaryInk,
                    }}
                    className="min-h-[54px] rounded-[18px] px-4 flex items-center justify-between font-display font-bold text-[15px] transition-colors"
                  >
                    <span>Her</span>
                    {googleGender === 'female' && <CheckIcon className="w-4 h-4" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => setGoogleGender('male')}
                    style={{
                      backgroundColor:
                        googleGender === 'male'
                          ? LOCKED_SPLASH_TOKENS.male.canvas
                          : '#F1EDE6',
                      color: LOCKED_SPLASH_TOKENS.male.primaryInk,
                    }}
                    className="min-h-[54px] rounded-[18px] px-4 flex items-center justify-between font-display font-bold text-[15px] transition-colors"
                  >
                    <span>Him</span>
                    {googleGender === 'male' && <CheckIcon className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <label className="flex items-start gap-3 cursor-pointer py-1">
                <input
                  type="checkbox"
                  checked={googleAcceptedTerms}
                  onChange={(e) => setGoogleAcceptedTerms(e.target.checked)}
                  className="mt-0.5 h-5 w-5 accent-[#1A1113] rounded"
                />
                <span className="text-[13px] leading-snug text-[#1A1113]/75">
                  I agree to the Couplova Terms &amp; Conditions and Privacy Policy.
                </span>
              </label>

              <button
                type="submit"
                disabled={!canCompleteGoogle || submitting}
                className={`w-full min-h-[52px] rounded-full font-display font-bold text-[15px] tracking-tight transition-colors ${
                  !canCompleteGoogle
                    ? 'bg-[#1A1113]/20 text-[#1A1113]/45 cursor-not-allowed'
                    : 'bg-[#1A1113] text-[#FAF8F5] active:scale-[0.985] transition-transform disabled:opacity-60'
                }`}
              >
                {submitting ? 'Creating Account...' : 'Create Account'}
              </button>
            </motion.form>
          )}

          {step === 'verify-otp' && (
            <motion.form
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
              onSubmit={handleVerifyOtp}
              className="space-y-5"
            >
              <button
                type="button"
                onClick={() => {
                  setStep(otpPurpose === 'signup' ? 'signup' : 'login');
                  setError(null);
                }}
                className="inline-flex items-center gap-2 min-h-[44px] text-[14px] font-medium text-[#1A1113]/70 hover:text-[#1A1113]"
              >
                <BackArrowIcon className="w-4 h-4" />
                <span>Back</span>
              </button>

              <div>
                <h2 className="font-display text-[28px] font-extrabold tracking-[-0.03em] text-[#1A1113]">
                  Enter 6-digit code
                </h2>
                <p className="mt-1.5 text-[14px] text-[#1A1113]/65">
                  Sent to <span className="font-medium text-[#1A1113]">{otpEmail}</span>. Expires in 10 minutes (max 3 attempts).
                </p>
              </div>

              {devOtpPreview && (
                <div
                  data-testid="dev-otp-preview"
                  className="rounded-[18px] bg-[#B8D0E8]/55 px-4 py-3 text-[13px] text-[#0F1924]"
                >
                  Preview mode (no email secret configured): your code is{' '}
                  <strong className="font-display tracking-widest tabular-nums">
                    {devOtpPreview}
                  </strong>
                </div>
              )}

              <div>
                <label htmlFor="otp-code-input" className="block text-[13px] font-medium text-[#1A1113]/75 mb-1.5">
                  6-Digit Verification Code
                </label>
                <input
                  id="otp-code-input"
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
                className="w-full min-h-[52px] rounded-full bg-[#1A1113] text-[#FAF8F5] font-display font-bold text-[15px] tracking-tight active:scale-[0.985] transition-transform disabled:opacity-60"
              >
                {submitting ? 'Verifying...' : 'Verify & Enter Couplova'}
              </button>

              <div className="flex items-center justify-between pt-1">
                <span className="text-[13px] text-[#1A1113]/60 tabular-nums">
                  {cooldown > 0 ? `Resend available in ${cooldown}s` : 'Did not receive a code?'}
                </span>
                <button
                  type="button"
                  onClick={handleResendOtp}
                  disabled={cooldown > 0 || submitting}
                  className="min-h-[44px] px-3 text-[14px] font-medium text-[#1A1113] disabled:opacity-40"
                >
                  Resend Code
                </button>
              </div>
            </motion.form>
          )}
        </section>
      </div>
    </div>
  );
}
