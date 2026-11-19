import type { GenderTheme } from '../constants/theme';
import { LOCKED_SPLASH_TOKENS } from '../constants/theme';
import type { StoryCard } from '../constants/decks';

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const MAX_OTP_ATTEMPTS = 3;

export interface SignupFormValues {
  fullName: string;
  username: string;
  country: string;
  dateOfBirth: string;
  email: string;
  password: string;
  confirmPassword: string;
  genderTheme: GenderTheme | null;
  partnerName?: string;
  acceptedTerms: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

export function isValidDateOfBirth(dob: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob.trim())) {
    return false;
  }
  const parsed = new Date(`${dob.trim()}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  const now = new Date();
  const minAgeDate = new Date(Date.UTC(now.getUTCFullYear() - 13, now.getUTCMonth(), now.getUTCDate()));
  const oldestDate = new Date(Date.UTC(1900, 0, 1));
  return parsed <= minAgeDate && parsed >= oldestDate;
}

export const EMAIL_REGEX = /^[^\s@]+@(?:[^\s@.]+\.)+[a-zA-Z]{2,}$/;

export function isValidEmail(email: string): boolean {
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 254 || trimmed.includes('..')) {
    return false;
  }
  const [localPart] = trimmed.split('@');
  if (!localPart || localPart.startsWith('.') || localPart.endsWith('.')) {
    return false;
  }
  return EMAIL_REGEX.test(trimmed);
}

export function getPasswordErrorMessage(password: string): string | null {
  const missing: string[] = [];
  if (!password || password.length < 8) {
    missing.push('8+ characters');
  }
  if (!/[A-Z]/.test(password)) {
    missing.push('1 uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    missing.push('1 lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    missing.push('1 number');
  }
  if (!/[^A-Za-z0-9\s]/.test(password)) {
    missing.push('1 special character');
  }
  if (missing.length === 0) {
    return null;
  }
  return `Password needs ${missing.join(', ')}.`;
}

export function isStrongPassword(password: string): boolean {
  return getPasswordErrorMessage(password) === null;
}

export function validateSignupForm(values: SignupFormValues): ValidationResult {
  const errors: Record<string, string> = {};

  if (!values.fullName.trim() || values.fullName.trim().length < 2) {
    errors.fullName = 'Please enter your full name.';
  }
  if (!values.username.trim() || !/^[a-zA-Z0-9_]{3,24}$/.test(values.username.trim())) {
    errors.username = 'Username must be 3–24 letters, numbers, or underscores.';
  }
  if (!values.partnerName || !values.partnerName.trim()) {
    errors.partnerName = "Please enter your partner's name.";
  }
  if (values.dateOfBirth.trim() && !isValidDateOfBirth(values.dateOfBirth)) {
    errors.dateOfBirth = 'Please enter a valid date of birth (13+).';
  }
  if (!isValidEmail(values.email)) {
    errors.email = 'Please enter a valid email address.';
  }
  const passwordError = getPasswordErrorMessage(values.password);
  if (passwordError) {
    errors.password = passwordError;
  }
  if (values.password !== values.confirmPassword) {
    errors.confirmPassword = 'Passwords do not match.';
  }
  if (values.genderTheme !== 'female' && values.genderTheme !== 'male') {
    errors.genderTheme = 'Select Her or Him to lock your splash color.';
  }
  if (!values.acceptedTerms) {
    errors.acceptedTerms = 'You must agree to the Terms & Conditions.';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

export function getLockedSplashColor(genderTheme: GenderTheme): string {
  // Always resolves strictly from the user's locked onboarding gender selection,
  // independent of any active dashboard/card theme changed in Settings.
  return LOCKED_SPLASH_TOKENS[genderTheme].canvas;
}

export function isSessionInactiveExpired(
  lastActiveAtIso: string,
  nowMs: number = Date.now(),
): boolean {
  const lastActiveMs = Date.parse(lastActiveAtIso);
  if (Number.isNaN(lastActiveMs)) {
    return true;
  }
  return nowMs - lastActiveMs > THIRTY_DAYS_MS;
}

export function getResendCooldownRemaining(
  lastSentAtMs: number | null,
  nowMs: number = Date.now(),
): number {
  if (!lastSentAtMs) {
    return 0;
  }
  const elapsedSeconds = Math.floor((nowMs - lastSentAtMs) / 1000);
  const remaining = OTP_RESEND_COOLDOWN_SECONDS - elapsedSeconds;
  return remaining > 0 ? remaining : 0;
}

export interface GameplaySelectionResult {
  lockedOptionIndex: number;
  lockedOptionText: string;
  needsPrivacyHandoff: boolean;
}

export function lockOptionForPrivacyHandoff(
  card: StoryCard,
  optionIndex: number,
): GameplaySelectionResult {
  if (!card.options || optionIndex < 0 || optionIndex >= card.options.length) {
    throw new Error('Invalid option index for card');
  }
  return {
    lockedOptionIndex: optionIndex,
    lockedOptionText: card.options[optionIndex],
    needsPrivacyHandoff: true,
  };
}

export function nextCardIndex(currentIndex: number, totalCards: number): {
  nextIndex: number;
  completed: boolean;
} {
  if (totalCards <= 0) {
    return { nextIndex: 0, completed: true };
  }
  if (currentIndex + 1 >= totalCards) {
    return { nextIndex: currentIndex, completed: true };
  }
  return { nextIndex: currentIndex + 1, completed: false };
}

export function prevCardIndex(currentIndex: number): number {
  return currentIndex > 0 ? currentIndex - 1 : 0;
}

export function formatEndOfDeckCopy(deckTitle: string, totalCards: number): string {
  return `You finished all ${totalCards} cards in ${deckTitle}. Play again or pick another deck.`;
}

export function personalizePrompt(text: string, partnerName?: string | null): string {
  const cleaned = partnerName?.trim();
  if (!cleaned || cleaned.toLowerCase() === 'partner') {
    return text;
  }

  return text
    .replace(/\byour partner['’]s\b/gi, `${cleaned}'s`)
    .replace(/\byour partner\b/gi, cleaned);
}

export function shuffleCards<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function prepareDeckForPlay<T extends { id: string; cards: readonly StoryCard[] }>(
  deck: T,
  options: { preserveOrder?: boolean; rng?: () => number } = {},
): T {
  const { preserveOrder = false, rng = Math.random } = options;
  if (preserveOrder || deck.id === 'after-hours') {
    return {
      ...deck,
      cards: [...deck.cards],
    };
  }
  return {
    ...deck,
    cards: shuffleCards(deck.cards, rng),
  };
}

const MISS_PENALTIES = [
  '10-second slow kiss, no rushing.',
  'Owe your partner a 10-minute neck or shoulder rub later.',
  'Maintain unbroken eye contact for 10 full seconds.',
  'Whisper one honest thing you want tonight right in their ear.',
  'Winner picks the very next move once this deck closes.',
];

export interface BlindPredictionOutcome {
  matched: boolean;
  lockedOptionIndex: number;
  guessedOptionIndex: number;
  penalty: string | null;
}

export function evaluateBlindPrediction(
  lockedOptionIndex: number,
  guessedOptionIndex: number,
  cardId: string,
): BlindPredictionOutcome {
  const matched = lockedOptionIndex === guessedOptionIndex;
  if (matched) {
    return {
      matched: true,
      lockedOptionIndex,
      guessedOptionIndex,
      penalty: null,
    };
  }
  let hash = 0;
  for (let i = 0; i < cardId.length; i += 1) {
    hash = (hash * 31 + cardId.charCodeAt(i)) >>> 0;
  }
  return {
    matched: false,
    lockedOptionIndex,
    guessedOptionIndex,
    penalty: MISS_PENALTIES[hash % MISS_PENALTIES.length],
  };
}

export interface SessionVetoTokens {
  partnerA: number;
  partnerB: number;
}

export function createInitialVetoTokens(): SessionVetoTokens {
  return { partnerA: 2, partnerB: 2 };
}

export function consumeVetoToken(
  tokens: SessionVetoTokens,
  who: 'partnerA' | 'partnerB',
): { ok: boolean; nextTokens: SessionVetoTokens } {
  if (tokens[who] <= 0) {
    return { ok: false, nextTokens: tokens };
  }
  return {
    ok: true,
    nextTokens: {
      ...tokens,
      [who]: tokens[who] - 1,
    },
  };
}

export function suggestIouFromCard(card: StoryCard, partnerName?: string | null): string {
  const cleanedPrompt = personalizePrompt(card.prompt, partnerName)
    .replace(/^Final Card\s*:\s*/i, '')
    .trim();

  if (card.kicker?.includes('Dare')) {
    return cleanedPrompt.replace(/\.$/, '');
  }
  if (card.type === 'dilemma' && card.options?.length) {
    return personalizePrompt(card.options[0], partnerName);
  }
  if (cleanedPrompt.length <= 90) {
    return cleanedPrompt;
  }
  return `${cleanedPrompt.slice(0, 87).trimEnd()}...`;
}

export function resolveCardSwipeDirection(
  offsetX: number,
  velocityX: number,
): 'next' | 'prev' | null {
  if (offsetX <= -70 || velocityX <= -360) return 'next';
  if (offsetX >= 70 || velocityX >= 360) return 'prev';
  return null;
}

