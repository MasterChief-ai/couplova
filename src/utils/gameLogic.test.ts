import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeVetoToken,
  createInitialVetoTokens,
  evaluateBlindPrediction,
  formatEndOfDeckCopy,
  getLockedSplashColor,
  getResendCooldownRemaining,
  isSessionInactiveExpired,
  isStrongPassword,
  isValidEmail,
  lockOptionForPrivacyHandoff,
  nextCardIndex,
  personalizePrompt,
  prepareDeckForPlay,
  prevCardIndex,
  resolveCardSwipeDirection,
  suggestIouFromCard,
  THIRTY_DAYS_MS,
  validateSignupForm,
} from './gameLogic';
import { GAME_DECKS } from '../constants/decks';

test('isValidEmail validates proper email format and rejects arbitrary text', () => {
  assert.equal(isValidEmail('maya@couplova.app'), true);
  assert.equal(isValidEmail('romeo.montague+1@sub.domain.co.uk'), true);
  assert.equal(isValidEmail('anything'), false);
  assert.equal(isValidEmail('maya@domain'), false);
  assert.equal(isValidEmail('maya@domain.c'), false);
  assert.equal(isValidEmail('maya@.com'), false);
  assert.equal(isValidEmail('.maya@couplova.app'), false);
  assert.equal(isValidEmail('maya..lin@couplova.app'), false);
});

test('isStrongPassword requires 8+ chars, uppercase, lowercase, number, and special character', () => {
  assert.equal(isStrongPassword('Verona1597!'), true);
  assert.equal(isStrongPassword('CouplovaDemo2026!'), true);
  assert.equal(isStrongPassword('verona1597!'), false); // missing uppercase
  assert.equal(isStrongPassword('VERONA1597!'), false); // missing lowercase
  assert.equal(isStrongPassword('VeronaPass!'), false); // missing number
  assert.equal(isStrongPassword('Verona1597'), false); // missing special character
  assert.equal(isStrongPassword('Ve1!'), false); // under 8 chars
});

test('validateSignupForm enforces required fields (with optional country & DOB), strong password, email format, and T&C checkbox', () => {
  const invalid = validateSignupForm({
    fullName: '',
    username: 'a',
    country: '',
    partnerName: '',
    dateOfBirth: '2024-01-01',
    email: 'not-an-email',
    password: 'weakpassword',
    confirmPassword: '456',
    genderTheme: null,
    acceptedTerms: false,
  });

  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.fullName);
  assert.ok(invalid.errors.username);
  assert.ok(invalid.errors.partnerName);
  assert.equal(invalid.errors.country, undefined);
  assert.ok(invalid.errors.dateOfBirth);
  assert.ok(invalid.errors.email);
  assert.ok(invalid.errors.password);
  assert.ok(invalid.errors.confirmPassword);
  assert.ok(invalid.errors.genderTheme);
  assert.ok(invalid.errors.acceptedTerms);

  const validWithOptionalEmpty = validateSignupForm({
    fullName: 'Maya Lin',
    username: 'maya_lin',
    country: '',
    partnerName: 'Julian',
    dateOfBirth: '',
    email: 'maya@example.com',
    password: 'StrongPassword9!',
    confirmPassword: 'StrongPassword9!',
    genderTheme: 'female',
    acceptedTerms: true,
  });

  assert.equal(validWithOptionalEmpty.valid, true);
  assert.deepEqual(validWithOptionalEmpty.errors, {});
});

test('getLockedSplashColor returns exact locked hex for female and male', () => {
  assert.equal(getLockedSplashColor('female'), '#F4C2C2');
  assert.equal(getLockedSplashColor('male'), '#B8D0E8');
});

test('30-day inactivity check revokes sessions older than 30 days', () => {
  const now = Date.UTC(2026, 10, 18, 12, 0, 0);
  const withinLimit = new Date(now - THIRTY_DAYS_MS + 60_000).toISOString();
  const expired = new Date(now - THIRTY_DAYS_MS - 1_000).toISOString();

  assert.equal(isSessionInactiveExpired(withinLimit, now), false);
  assert.equal(isSessionInactiveExpired(expired, now), true);
});

test('OTP resend cooldown strictly enforces 60 seconds', () => {
  const sentAt = 1_000_000;
  assert.equal(getResendCooldownRemaining(sentAt, sentAt + 10_000), 50);
  assert.equal(getResendCooldownRemaining(sentAt, sentAt + 60_000), 0);
  assert.equal(getResendCooldownRemaining(null, sentAt), 0);
});

test('personalizePrompt replaces partner references when a custom partner name is set and leaves defaults intact', () => {
  const base = "Whisper in your partner's ear and kiss your partner slowly.";
  assert.equal(
    personalizePrompt(base, 'Presh'),
    "Whisper in Presh's ear and kiss Presh slowly.",
  );
  assert.equal(personalizePrompt(base, ''), base);
  assert.equal(personalizePrompt(base, 'Partner'), base);
  assert.equal(
    personalizePrompt('Your partner breaks first tonight.', 'Julian'),
    'Julian breaks first tonight.',
  );
});

test('All 6 Couplova decks load with Deck 05 Would You Rather (20 cards) & Deck 06 After Hours (30 cards)', () => {
  assert.equal(GAME_DECKS.length, 6);
  const deepDeck = GAME_DECKS[0];
  assert.equal(deepDeck.title, 'Balls Deep Conversations');
  assert.equal(deepDeck.cards.length, 30);

  const wouldYouRather = GAME_DECKS[4];
  assert.equal(wouldYouRather.title, 'Would You Rather');
  assert.equal(wouldYouRather.cards.length, 20);
  assert.ok(wouldYouRather.cards.every((c) => c.type === 'dilemma' && c.options?.length === 2));
  assert.equal(wouldYouRather.cards[12].kicker, 'Steamy & Unfiltered');
  assert.match(wouldYouRather.cards[19].prompt, /Final Card/);

  const afterHours = GAME_DECKS[5];
  assert.equal(afterHours.id, 'after-hours');
  assert.equal(afterHours.title, 'After Hours');
  assert.equal(afterHours.cardColor, '#4A1C2F');
  assert.equal(afterHours.textColor, '#FAF8F5');
  assert.equal(afterHours.cards.length, 30);
  assert.equal(afterHours.cards.filter((c) => c.type === 'multiple_choice').length, 7);
  assert.equal(afterHours.cards.find((c) => c.id === 'ah-23')?.timerSeconds, 15);
  assert.equal(afterHours.cards.find((c) => c.id === 'ah-26')?.timerSeconds, 20);

  const multiCard = deepDeck.cards[0];
  const locked = lockOptionForPrivacyHandoff(multiCard, 2);
  assert.equal(locked.needsPrivacyHandoff, true);
  assert.equal(locked.lockedOptionIndex, 2);
  assert.equal(locked.lockedOptionText, multiCard.options?.[2]);

  assert.deepEqual(nextCardIndex(0, 30), { nextIndex: 1, completed: false });
  assert.deepEqual(nextCardIndex(29, 30), { nextIndex: 29, completed: true });
  assert.equal(prevCardIndex(0), 0);
  assert.equal(prevCardIndex(3), 2);
  assert.equal(
    formatEndOfDeckCopy(deepDeck.title, deepDeck.cards.length),
    'You finished all 30 cards in Balls Deep Conversations. Play again or pick another deck.',
  );
});

test('prepareDeckForPlay shuffles decks 01-05 on open while keeping Deck 06 After Hours in strict order', () => {
  const wyr = GAME_DECKS[4];
  const afterHours = GAME_DECKS[5];

  // Deterministic pseudo-RNG ensures non-identity shuffle
  let seed = 0.27;
  const fakeRng = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  const shuffledWyr = prepareDeckForPlay(wyr, { rng: fakeRng });
  assert.equal(shuffledWyr.cards.length, wyr.cards.length);
  assert.notDeepEqual(
    shuffledWyr.cards.map((c) => c.id),
    wyr.cards.map((c) => c.id),
  );

  // Deck 06 After Hours never shuffles
  const unshuffledAh = prepareDeckForPlay(afterHours, { rng: fakeRng });
  assert.deepEqual(
    unshuffledAh.cards.map((c) => c.id),
    afterHours.cards.map((c) => c.id),
  );
});

test('evaluateBlindPrediction returns In Sync on match and teasing penalty on miss', () => {
  const hit = evaluateBlindPrediction(1, 1, 'dnr-04');
  assert.equal(hit.matched, true);
  assert.equal(hit.penalty, null);

  const miss = evaluateBlindPrediction(0, 1, 'dnr-04');
  assert.equal(miss.matched, false);
  assert.ok(miss.penalty && miss.penalty.length > 5);
});

test('consumeVetoToken enforces 2 skip tokens per partner per deck run', () => {
  let tokens = createInitialVetoTokens();
  assert.deepEqual(tokens, { partnerA: 2, partnerB: 2 });

  const first = consumeVetoToken(tokens, 'partnerA');
  assert.equal(first.ok, true);
  assert.equal(first.nextTokens.partnerA, 1);
  assert.equal(first.nextTokens.partnerB, 2);

  const second = consumeVetoToken(first.nextTokens, 'partnerA');
  assert.equal(second.ok, true);
  assert.equal(second.nextTokens.partnerA, 0);

  const third = consumeVetoToken(second.nextTokens, 'partnerA');
  assert.equal(third.ok, false);
  assert.equal(third.nextTokens.partnerA, 0);
});

test('suggestIouFromCard generates personalized default IOU copy', () => {
  const dare = GAME_DECKS[5].cards.find((c) => c.id === 'ah-23')!;
  assert.equal(
    suggestIouFromCard(dare, 'Julian'),
    'Kiss Julian slowly for fifteen full seconds without using your hands',
  );
  const finalCard = GAME_DECKS[4].cards[19];
  assert.equal(
    suggestIouFromCard(finalCard, 'Julian'),
    'Clothes come off, no talking needed',
  );
});

test('resolveCardSwipeDirection respects horizontal distance and velocity thresholds', () => {
  assert.equal(resolveCardSwipeDirection(-80, 0), 'next');
  assert.equal(resolveCardSwipeDirection(-15, -400), 'next');
  assert.equal(resolveCardSwipeDirection(80, 0), 'prev');
  assert.equal(resolveCardSwipeDirection(15, 400), 'prev');
  assert.equal(resolveCardSwipeDirection(-30, -100), null);
  assert.equal(resolveCardSwipeDirection(30, 100), null);
  assert.equal(resolveCardSwipeDirection(0, 0), null);
});


