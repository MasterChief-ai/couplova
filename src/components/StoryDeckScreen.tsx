import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { GAME_DECKS, type GameDeck, type StoryCard } from '../constants/decks';
import {
  consumeVetoToken,
  createInitialVetoTokens,
  evaluateBlindPrediction,
  formatEndOfDeckCopy,
  lockOptionForPrivacyHandoff,
  nextCardIndex,
  personalizePrompt,
  prepareDeckForPlay,
  prevCardIndex,
  resolveCardSwipeDirection,
  suggestIouFromCard,
  type BlindPredictionOutcome,
  type SessionVetoTokens,
} from '../utils/gameLogic';
import {
  BackArrowIcon,
  CheckIcon,
  CloseIcon,
  CouponIcon,
  HeartIcon,
  NextArrowIcon,
  ShieldIcon,
  TimerIcon,
} from './Icons';

interface StoryDeckScreenProps {
  deck: GameDeck;
  partnerName: string;
  initialCardIndex?: number;
  savedCardIds: string[];
  onToggleSave: (cardId: string) => void;
  onSaveIou: (payload: {
    title: string;
    owedBy: 'me' | 'partner' | 'both';
    cardId?: string;
    deckId?: string;
    deckTitle?: string;
  }) => void | Promise<void>;
  onClose: () => void;
}

type CardPhase =
  | 'answering'
  | 'handoff'
  | 'guessing'
  | 'revealed'
  | 'veto-picker'
  | 'veto-call'
  | 'veto-stare';

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function StoryDeckScreen({
  deck,
  partnerName,
  initialCardIndex = 0,
  savedCardIds,
  onToggleSave,
  onSaveIou,
  onClose,
}: StoryDeckScreenProps) {
  const [cards, setCards] = useState<StoryCard[]>(() => deck.cards);
  const [cardIndex, setCardIndex] = useState(
    Math.min(Math.max(initialCardIndex, 0), Math.max(deck.cards.length - 1, 0)),
  );
  const [swipeDirection, setSwipeDirection] = useState<1 | -1>(1);
  const [isCompleted, setIsCompleted] = useState(false);

  // Lock In & Match (Blind Prediction) state
  const [phase, setPhase] = useState<CardPhase>('answering');
  const [selectedOptionIdx, setSelectedOptionIdx] = useState<number | null>(null);
  const [lockedOptionIdx, setLockedOptionIdx] = useState<number | null>(null);
  const [predictionOutcome, setPredictionOutcome] = useState<BlindPredictionOutcome | null>(null);
  const [penaltySavedAsIou, setPenaltySavedAsIou] = useState(false);

  // Veto / Plead the Fifth state (2 tokens per partner per deck run)
  const [vetoTokens, setVetoTokens] = useState<SessionVetoTokens>(() =>
    createInitialVetoTokens(),
  );
  const [vetoDodger, setVetoDodger] = useState<'partnerA' | 'partnerB' | null>(null);
  const [vetoedCardIds, setVetoedCardIds] = useState<string[]>([]);
  const [stareSecondsLeft, setStareSecondsLeft] = useState(10);

  // Cash This In Later (IOU drawer) state
  const [iouOpen, setIouOpen] = useState(false);
  const [iouTitle, setIouTitle] = useState('');
  const [iouOwedBy, setIouOwedBy] = useState<'me' | 'partner' | 'both'>('me');
  const [iouSavedNotice, setIouSavedNotice] = useState<string | null>(null);

  // Spicy Timer / Hot Seat Timer state
  const currentCard = cards[cardIndex];
  const cardTimerDuration = currentCard?.timerSeconds ?? (deck.hasHotSeatTimer ? 15 : 0);
  const isHotSeatMode = Boolean(deck.hasHotSeatTimer);

  const [hotSeatEnabled, setHotSeatEnabled] = useState(isHotSeatMode);
  const [timerRunning, setTimerRunning] = useState(isHotSeatMode);
  const [secondsLeft, setSecondsLeft] = useState(cardTimerDuration || 15);

  const isSaved = currentCard ? savedCardIds.includes(currentCard.id) : false;
  const rawPartner = partnerName.trim();
  const displayPartner =
    rawPartner && rawPartner.toLowerCase() !== 'partner' ? rawPartner : 'your partner';
  const partnerChipLabel =
    rawPartner && rawPartner.toLowerCase() !== 'partner' ? rawPartner : 'Partner';

  // Sync if deck prop swaps (e.g., jumping to another deck from Settings)
  useEffect(() => {
    const clampedIndex = Math.min(
      Math.max(initialCardIndex, 0),
      Math.max(deck.cards.length - 1, 0),
    );
    setCards(deck.cards);
    setCardIndex(clampedIndex);
    setIsCompleted(false);
    setVetoTokens(createInitialVetoTokens());
    setVetoedCardIds([]);
    resetCardTransientState(deck.cards[clampedIndex]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck]);

  // Reset card-scoped timer whenever card changes
  useEffect(() => {
    const duration = currentCard?.timerSeconds ?? (isHotSeatMode ? 15 : 0);
    setSecondsLeft(duration || 15);
    setTimerRunning(isHotSeatMode && hotSeatEnabled);
  }, [cardIndex, currentCard?.id, currentCard?.timerSeconds, isHotSeatMode, hotSeatEnabled]);

  // Active Spicy Timer / Hot Seat Countdown interval
  useEffect(() => {
    if (cardTimerDuration <= 0 || isCompleted || phase !== 'answering' || !timerRunning) {
      return;
    }
    if (isHotSeatMode && !hotSeatEnabled) {
      return;
    }
    if (secondsLeft <= 0) return;

    const id = window.setInterval(() => {
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [cardTimerDuration, isCompleted, phase, timerRunning, isHotSeatMode, hotSeatEnabled, secondsLeft]);

  // 10-second Veto Stare-Down / Kiss countdown
  useEffect(() => {
    if (phase !== 'veto-stare' || stareSecondsLeft <= 0) return;
    const id = window.setInterval(() => {
      setStareSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, stareSecondsLeft]);

  // Keyboard ArrowLeft / ArrowRight support when not typing in an input
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || iouOpen) return;
      if (e.key === 'ArrowRight' && !isCompleted) {
        e.preventDefault();
        handleNext();
      } else if (e.key === 'ArrowLeft' && (cardIndex > 0 || isCompleted)) {
        e.preventDefault();
        handlePrev();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Reserve cards from other decks or unused slots for Veto replacement
  const reservePool = useMemo(() => {
    const inPlayIds = new Set(cards.map((c) => c.id));
    const sameDeckPool = deck.cards.filter((c) => c.id !== currentCard?.id);
    const extraPool = GAME_DECKS.filter((d) => d.id === deck.id || d.id === 'deep-conversations')
      .flatMap((d) => d.cards)
      .filter((c) => !inPlayIds.has(c.id));
    return [...extraPool, ...sameDeckPool];
  }, [cards, deck.cards, deck.id, currentCard?.id]);

  function resetCardTransientState(targetCard?: StoryCard) {
    setPhase('answering');
    setSelectedOptionIdx(null);
    setLockedOptionIdx(null);
    setPredictionOutcome(null);
    setPenaltySavedAsIou(false);
    setVetoDodger(null);
    setStareSecondsLeft(10);
    setIouOpen(false);
    setIouSavedNotice(null);
    if (targetCard) {
      const duration = targetCard.timerSeconds ?? (isHotSeatMode ? 15 : 0);
      setSecondsLeft(duration || 15);
      setTimerRunning(isHotSeatMode && hotSeatEnabled);
    }
  }

  function handleNext() {
    setSwipeDirection(1);
    const res = nextCardIndex(cardIndex, cards.length);
    if (res.completed) {
      resetCardTransientState();
      setIsCompleted(true);
    } else {
      const nextCard = cards[res.nextIndex];
      setCardIndex(res.nextIndex);
      resetCardTransientState(nextCard);
    }
  }

  function handlePrev() {
    setSwipeDirection(-1);
    if (isCompleted) {
      setIsCompleted(false);
      return;
    }
    const prevIdx = prevCardIndex(cardIndex);
    setCardIndex(prevIdx);
    resetCardTransientState(cards[prevIdx]);
  }

  function handleLockIn() {
    if (!currentCard || selectedOptionIdx === null) return;
    const locked = lockOptionForPrivacyHandoff(currentCard, selectedOptionIdx);
    setLockedOptionIdx(locked.lockedOptionIndex);
    setPhase('handoff');
  }

  function handlePartnerGuess(guessIdx: number) {
    if (!currentCard || lockedOptionIdx === null) return;
    const outcome = evaluateBlindPrediction(lockedOptionIdx, guessIdx, currentCard.id);
    setPredictionOutcome(outcome);
    setPenaltySavedAsIou(false);
    setPhase('revealed');
  }

  function handleBurnVeto(who: 'partnerA' | 'partnerB') {
    const result = consumeVetoToken(vetoTokens, who);
    if (!result.ok) return;
    setVetoTokens(result.nextTokens);
    setVetoDodger(who);
    setPhase('veto-call');
  }

  function handleVetoDrawReplacement() {
    if (!currentCard) {
      handleNext();
      return;
    }

    const blockedIds = new Set([...vetoedCardIds, currentCard.id]);
    setVetoedCardIds((prev) => (prev.includes(currentCard.id) ? prev : [...prev, currentCard.id]));

    // Prefer swapping with an untouched, unvetoed card later in the deck
    let swapTarget = -1;
    for (let idx = cards.length - 1; idx > cardIndex; idx -= 1) {
      if (!blockedIds.has(cards[idx].id)) {
        swapTarget = idx;
        break;
      }
    }

    if (swapTarget !== -1) {
      const nextList = [...cards];
      const replacement = nextList[swapTarget];
      nextList[swapTarget] = nextList[cardIndex];
      nextList[cardIndex] = replacement;
      setCards(nextList);
      resetCardTransientState(replacement);
      return;
    }

    const fallback = reservePool.find((c) => !blockedIds.has(c.id));
    if (fallback) {
      const nextList = [...cards];
      nextList[cardIndex] = fallback;
      setCards(nextList);
      resetCardTransientState(fallback);
      return;
    }

    handleNext();
  }

  function handleVetoForceStare() {
    setStareSecondsLeft(10);
    setPhase('veto-stare');
  }

  function handlePlayAgain() {
    const freshDeck = prepareDeckForPlay(deck);
    setCards(freshDeck.cards);
    setIsCompleted(false);
    setCardIndex(0);
    setVetoTokens(createInitialVetoTokens());
    setVetoedCardIds([]);
    resetCardTransientState(freshDeck.cards[0]);
  }

  function openIouComposer() {
    if (!currentCard) return;
    setIouTitle(suggestIouFromCard(currentCard, partnerName));
    setIouOwedBy('me');
    setIouSavedNotice(null);
    setIouOpen(true);
  }

  async function handleSubmitIou(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = iouTitle.trim();
    if (cleaned.length < 3 || !currentCard) return;
    await onSaveIou({
      title: cleaned,
      owedBy: iouOwedBy,
      cardId: currentCard.id,
      deckId: deck.id,
      deckTitle: deck.title,
    });
    setIouOpen(false);
    setIouSavedNotice('Saved to Promises & IOUs');
  }

  async function handleSavePenaltyAsIou() {
    if (!predictionOutcome?.penalty || !currentCard) return;
    await onSaveIou({
      title: personalizePrompt(predictionOutcome.penalty, partnerName),
      owedBy: 'partner',
      cardId: currentCard.id,
      deckId: deck.id,
      deckTitle: deck.title,
    });
    setPenaltySavedAsIou(true);
  }

  const totalTokensLeft = vetoTokens.partnerA + vetoTokens.partnerB;
  const dodgerLabel = vetoDodger === 'partnerA' ? 'You' : partnerChipLabel;
  const callerLabel = vetoDodger === 'partnerA' ? displayPartner : 'Your';

  return (
    <div
      data-testid="story-deck-screen"
      style={{ backgroundColor: deck.cardColor, color: deck.textColor }}
      className="min-h-screen w-full flex flex-col justify-between relative select-none overflow-hidden"
    >
      {/* Top Bar: Segmented 3px Story Progress Bars + Centered Deck Title */}
      <header className="w-full max-w-2xl mx-auto px-5 pt-5 z-20">
        <div className="flex items-center gap-1 w-full" aria-label="Deck progress">
          {cards.map((card, idx) => {
            const isFilled = isCompleted || idx <= cardIndex;
            return (
              <div
                key={`${card.id}-${idx}`}
                className="h-[3px] flex-1 rounded-full transition-colors duration-200"
                style={{
                  backgroundColor: isFilled
                    ? deck.progressFillColor
                    : deck.progressTrackColor,
                }}
              />
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-2 pt-4">
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handlePrev}
              disabled={cardIndex === 0 && !isCompleted}
              aria-label="Previous card"
              className="w-11 h-11 rounded-full flex items-center justify-center disabled:opacity-25 active:scale-95 transition-transform"
            >
              <BackArrowIcon className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 min-w-0 text-center px-1">
            <p className="font-display text-[13px] font-bold tracking-tight truncate">
              {deck.title}
            </p>
            <p
              className="text-[12px] tabular-nums"
              style={{ color: deck.mutedTextColor }}
            >
              {isCompleted
                ? `${cards.length} of ${cards.length}`
                : `Card ${cardIndex + 1} of ${cards.length}`}
            </p>
          </div>

          <div className="flex items-center justify-end gap-1 shrink-0">
            {isHotSeatMode && !isCompleted && (
              <button
                type="button"
                onClick={() => {
                  const nextEnabled = !hotSeatEnabled;
                  setHotSeatEnabled(nextEnabled);
                  setTimerRunning(nextEnabled);
                }}
                aria-label="Toggle Hot Seat timer"
                style={{ backgroundColor: deck.pillColor }}
                className="min-h-[38px] px-3 rounded-full flex items-center gap-1.5 text-[12px] font-medium tabular-nums"
              >
                <TimerIcon className="w-3.5 h-3.5" />
                <span>{hotSeatEnabled ? `${secondsLeft}s` : 'Off'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Back to decks"
              className="w-11 h-11 rounded-full flex items-center justify-center active:scale-95 transition-transform"
            >
              <CloseIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Center Stage */}
      <main className="flex-1 w-full max-w-xl mx-auto px-7 py-6 flex flex-col justify-center z-10">
        <AnimatePresence mode="wait">
          {isCompleted ? (
            <motion.div
              key="end-of-deck"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.2 }}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.35}
              dragMomentum={false}
              onDragEnd={(_e, info) => {
                if (resolveCardSwipeDirection(info.offset.x, info.velocity.x) === 'prev') {
                  handlePrev();
                }
              }}
              className="text-center space-y-8 touch-pan-y"
            >
              <div className="space-y-3">
                <p
                  className="text-[13px] font-medium"
                  style={{ color: deck.mutedTextColor }}
                >
                  Deck Complete
                </p>
                <h1 className="font-display text-[28px] sm:text-[32px] font-extrabold leading-[1.2] tracking-[-0.03em] [text-wrap:balance]">
                  {formatEndOfDeckCopy(deck.title, cards.length)}
                </h1>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 max-w-sm mx-auto">
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    backgroundColor: deck.progressFillColor,
                    color: deck.cardColor,
                  }}
                  className="flex-1 min-h-[52px] px-6 rounded-full font-display font-bold text-[15px] active:scale-[0.98] transition-transform"
                >
                  Back to Decks
                </button>
                <button
                  type="button"
                  onClick={handlePlayAgain}
                  style={{
                    backgroundColor: deck.pillColor,
                    color: deck.textColor,
                  }}
                  className="flex-1 min-h-[52px] px-6 rounded-full font-display font-bold text-[15px] active:scale-[0.98] transition-transform"
                >
                  Play Again
                </button>
              </div>
            </motion.div>
          ) : iouOpen && currentCard ? (
            <motion.form
              key={`iou-composer-${currentCard.id}`}
              onSubmit={handleSubmitIou}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="w-full max-w-md mx-auto space-y-5"
            >
              <div className="text-center space-y-1.5">
                <p className="text-[13px] font-medium" style={{ color: deck.mutedTextColor }}>
                  Cash This In Later
                </p>
                <h2 className="font-display text-[26px] font-extrabold tracking-[-0.03em]">
                  Save a Promise or IOU
                </h2>
              </div>

              <div className="space-y-3">
                <label className="sr-only" htmlFor="iou-title-input">
                  Promise or IOU description
                </label>
                <textarea
                  id="iou-title-input"
                  rows={2}
                  value={iouTitle}
                  onChange={(e) => setIouTitle(e.target.value)}
                  placeholder="e.g. 10-minute neck rub before bed"
                  style={{
                    backgroundColor: deck.pillColor,
                    color: deck.textColor,
                  }}
                  className="w-full rounded-[20px] px-4 py-3 text-[15px] font-medium leading-snug focus:outline-2 resize-none placeholder:opacity-60"
                />

                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { id: 'me', label: `You owe ${partnerChipLabel}` },
                      { id: 'partner', label: `${partnerChipLabel} owes you` },
                      { id: 'both', label: 'Both of us' },
                    ] as const
                  ).map((choice) => {
                    const active = iouOwedBy === choice.id;
                    return (
                      <button
                        key={choice.id}
                        type="button"
                        onClick={() => setIouOwedBy(choice.id)}
                        style={{
                          backgroundColor: active ? deck.progressFillColor : deck.pillColor,
                          color: active ? deck.cardColor : deck.textColor,
                        }}
                        className="min-h-[44px] px-2.5 rounded-full text-[12px] font-semibold transition-colors"
                      >
                        {choice.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setIouOpen(false)}
                  style={{ backgroundColor: deck.pillColor, color: deck.textColor }}
                  className="flex-1 min-h-[48px] rounded-full font-display font-bold text-[14px]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={iouTitle.trim().length < 3}
                  style={{
                    backgroundColor: deck.progressFillColor,
                    color: deck.cardColor,
                  }}
                  className="flex-1 min-h-[48px] rounded-full font-display font-bold text-[14px] disabled:opacity-40"
                >
                  Save Promise
                </button>
              </div>
            </motion.form>
          ) : phase === 'veto-picker' ? (
            <motion.div
              key="veto-picker"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="text-center space-y-6 max-w-md mx-auto w-full"
            >
              <div className="space-y-2">
                <p className="text-[13px] font-medium" style={{ color: deck.mutedTextColor }}>
                  Veto Token
                </p>
                <h1 className="font-display text-[28px] sm:text-[32px] font-extrabold leading-[1.18] tracking-[-0.03em]">
                  Who is pleading the fifth?
                </h1>
                <p className="text-[14px]" style={{ color: deck.mutedTextColor }}>
                  Dodge this card, and the other person gets to pick the replacement or force a 10-second stare-down.
                </p>
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  disabled={vetoTokens.partnerA <= 0}
                  onClick={() => handleBurnVeto('partnerA')}
                  style={{ backgroundColor: deck.pillColor, color: deck.textColor }}
                  className="w-full min-h-[54px] px-6 rounded-full font-display font-bold text-[15px] flex items-center justify-between disabled:opacity-35 active:scale-[0.985] transition-transform"
                >
                  <span>You Plead the Fifth</span>
                  <span className="text-[13px] tabular-nums" style={{ color: deck.mutedTextColor }}>
                    {vetoTokens.partnerA} left
                  </span>
                </button>

                <button
                  type="button"
                  disabled={vetoTokens.partnerB <= 0}
                  onClick={() => handleBurnVeto('partnerB')}
                  style={{ backgroundColor: deck.pillColor, color: deck.textColor }}
                  className="w-full min-h-[54px] px-6 rounded-full font-display font-bold text-[15px] flex items-center justify-between disabled:opacity-35 active:scale-[0.985] transition-transform"
                >
                  <span>{partnerChipLabel} Pleads the Fifth</span>
                  <span className="text-[13px] tabular-nums" style={{ color: deck.mutedTextColor }}>
                    {vetoTokens.partnerB} left
                  </span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => setPhase('answering')}
                className="text-[13px] font-medium underline underline-offset-4 py-2"
                style={{ color: deck.mutedTextColor }}
              >
                Never mind, play the card
              </button>
            </motion.div>
          ) : phase === 'veto-call' ? (
            <motion.div
              key="veto-call"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="text-center space-y-6 max-w-md mx-auto w-full"
            >
              <div className="space-y-2">
                <p className="text-[13px] font-medium" style={{ color: deck.mutedTextColor }}>
                  Token Burned
                </p>
                <h1 className="font-display text-[28px] sm:text-[32px] font-extrabold leading-[1.18] tracking-[-0.03em]">
                  {callerLabel === 'Your' ? 'Your Call' : `${callerLabel}'s Call`}
                </h1>
                <p className="text-[15px]" style={{ color: deck.mutedTextColor }}>
                  {dodgerLabel} skipped that card. Pick what happens instead:
                </p>
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  onClick={handleVetoDrawReplacement}
                  style={{
                    backgroundColor: deck.progressFillColor,
                    color: deck.cardColor,
                  }}
                  className="w-full min-h-[54px] px-6 rounded-full font-display font-bold text-[15px] active:scale-[0.985] transition-transform"
                >
                  Draw Replacement Card
                </button>

                <button
                  type="button"
                  onClick={handleVetoForceStare}
                  style={{ backgroundColor: deck.pillColor, color: deck.textColor }}
                  className="w-full min-h-[54px] px-6 rounded-full font-display font-bold text-[15px] active:scale-[0.985] transition-transform"
                >
                  Force 10s Stare-Down or Kiss
                </button>
              </div>
            </motion.div>
          ) : phase === 'veto-stare' ? (
            <motion.div
              key="veto-stare"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.2 }}
              className="text-center space-y-6 max-w-md mx-auto w-full"
            >
              <div className="space-y-2">
                <p className="text-[13px] font-medium" style={{ color: deck.mutedTextColor }}>
                  Veto Consequence
                </p>
                <h1 className="font-display text-[30px] sm:text-[34px] font-extrabold leading-[1.18] tracking-[-0.03em]">
                  Eyes locked, or kiss until zero.
                </h1>
              </div>

              <div className="space-y-3">
                <div
                  className="w-full h-[5px] rounded-full overflow-hidden"
                  style={{ backgroundColor: deck.progressTrackColor }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-1000 ease-linear"
                    style={{
                      width: `${(stareSecondsLeft / 10) * 100}%`,
                      backgroundColor: deck.progressFillColor,
                    }}
                  />
                </div>
                <p
                  data-testid="veto-stare-countdown"
                  className="font-display text-[26px] font-extrabold tabular-nums"
                >
                  {stareSecondsLeft > 0 ? formatCountdown(stareSecondsLeft) : 'Time’s up'}
                </p>
              </div>

              <button
                type="button"
                onClick={handleNext}
                style={{
                  backgroundColor: deck.progressFillColor,
                  color: deck.cardColor,
                }}
                className="min-h-[52px] px-8 rounded-full font-display font-bold text-[15px] active:scale-[0.985] transition-transform"
              >
                {stareSecondsLeft > 0 ? 'Finish & Next Card' : 'Next Card'}
              </button>
            </motion.div>
          ) : phase === 'handoff' ? (
            <motion.div
              key={`handoff-${currentCard.id}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="text-center space-y-8"
            >
              <div className="space-y-3">
                <p
                  className="text-[13px] font-medium"
                  style={{ color: deck.mutedTextColor }}
                >
                  Answer Locked
                </p>
                <h1 className="font-display text-[30px] sm:text-[34px] font-extrabold leading-[1.18] tracking-[-0.03em] [text-wrap:balance]">
                  Hand the phone to {displayPartner} to guess what they picked
                </h1>
                <p className="text-[15px]" style={{ color: deck.mutedTextColor }}>
                  No peeking. Tap below once {displayPartner} has the phone.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setPhase('guessing')}
                style={{
                  backgroundColor: deck.progressFillColor,
                  color: deck.cardColor,
                }}
                className="min-h-[54px] px-10 rounded-full font-display font-bold text-[16px] active:scale-[0.98] transition-transform"
              >
                Ready to Guess
              </button>
            </motion.div>
          ) : phase === 'revealed' && predictionOutcome && currentCard.options ? (
            <motion.div
              key={`revealed-${currentCard.id}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="w-full space-y-6"
            >
              <div className="text-center space-y-3">
                <div className="inline-flex items-center gap-2 justify-center">
                  {predictionOutcome.matched ? (
                    <span
                      data-testid="match-verdict-badge"
                      style={{
                        backgroundColor: deck.progressFillColor,
                        color: deck.cardColor,
                      }}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full font-display text-[13px] font-bold"
                    >
                      <CheckIcon className="w-4 h-4" />
                      <span>In Sync</span>
                    </span>
                  ) : (
                    <span
                      data-testid="match-verdict-badge"
                      style={{
                        backgroundColor: deck.pillColor,
                        color: deck.textColor,
                      }}
                      className="inline-flex items-center px-4 py-1.5 rounded-full font-display text-[13px] font-bold"
                    >
                      Missed
                    </span>
                  )}
                </div>

                <h2 className="font-display text-[22px] sm:text-[26px] font-extrabold leading-[1.22] tracking-[-0.03em] [text-wrap:balance]">
                  {personalizePrompt(currentCard.prompt, partnerName)}
                </h2>
              </div>

              {/* Side-by-side Answer vs Guess Reveal */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div
                  style={{
                    backgroundColor: deck.progressFillColor,
                    color: deck.cardColor,
                  }}
                  className="rounded-[22px] p-5 space-y-1.5"
                >
                  <p className="text-[12px] font-semibold opacity-70">Locked Answer</p>
                  <p className="font-display font-bold text-[15px] leading-snug">
                    {personalizePrompt(
                      currentCard.options[predictionOutcome.lockedOptionIndex] || '',
                      partnerName,
                    )}
                  </p>
                </div>

                <div
                  style={{
                    backgroundColor: deck.pillColor,
                    color: deck.textColor,
                  }}
                  className="rounded-[22px] p-5 space-y-1.5"
                >
                  <p className="text-[12px] font-semibold" style={{ color: deck.mutedTextColor }}>
                    {partnerChipLabel} Guessed
                  </p>
                  <p className="font-display font-bold text-[15px] leading-snug">
                    {personalizePrompt(
                      currentCard.options[predictionOutcome.guessedOptionIndex] || '',
                      partnerName,
                    )}
                  </p>
                </div>
              </div>

              {predictionOutcome.matched ? (
                <p className="text-center text-[14px]" style={{ color: deck.mutedTextColor }}>
                  Direct hit. Zero penalties, take the point and keep moving.
                </p>
              ) : (
                <div className="text-center space-y-3">
                  <p className="text-[15px] font-medium">
                    Teasing Penalty:{' '}
                    {personalizePrompt(predictionOutcome.penalty || '', partnerName)}
                  </p>
                  <button
                    type="button"
                    disabled={penaltySavedAsIou}
                    onClick={handleSavePenaltyAsIou}
                    style={{ backgroundColor: deck.pillColor, color: deck.textColor }}
                    className="min-h-[42px] px-5 rounded-full text-[13px] font-display font-bold disabled:opacity-60"
                  >
                    {penaltySavedAsIou ? 'Saved to Promises & IOUs' : 'Save Penalty as IOU'}
                  </button>
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key={`${currentCard.id}-${phase}`}
              data-testid="swipeable-card"
              initial={{ opacity: 0, x: swipeDirection * 28 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -swipeDirection * 28 }}
              transition={{ type: 'spring', stiffness: 360, damping: 32 }}
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.38}
              dragMomentum={false}
              onDragEnd={(_e, info) => {
                const dir = resolveCardSwipeDirection(info.offset.x, info.velocity.x);
                if (dir === 'next') {
                  handleNext();
                } else if (dir === 'prev' && cardIndex > 0) {
                  handlePrev();
                }
              }}
              className="w-full touch-pan-y cursor-grab active:cursor-grabbing"
            >
              <div className="text-center mb-7">
                {phase === 'guessing' ? (
                  <p
                    className="text-[13px] font-medium mb-3"
                    style={{ color: deck.mutedTextColor }}
                  >
                    Guessing Turn · {partnerChipLabel}
                  </p>
                ) : currentCard.tier ? (
                  <p
                    className="text-[13px] font-medium mb-3"
                    style={{ color: deck.mutedTextColor }}
                  >
                    Level {currentCard.tierLevel} · {currentCard.tier}
                  </p>
                ) : currentCard.kicker ? (
                  <p
                    className="text-[13px] font-medium mb-3"
                    style={{ color: deck.mutedTextColor }}
                  >
                    {currentCard.kicker}
                  </p>
                ) : null}

                <h1 className="font-display text-[28px] sm:text-[32px] font-extrabold leading-[1.22] tracking-[-0.03em] [text-wrap:balance]">
                  {personalizePrompt(currentCard.prompt, partnerName)}
                </h1>

                {phase === 'guessing' && (
                  <p className="text-[14px] mt-3" style={{ color: deck.mutedTextColor }}>
                    Tap the answer you think was locked in.
                  </p>
                )}
              </div>

              {/* Minimalist Spicy Timer / Hot Seat Progress Bar on Timed Cards */}
              {phase === 'answering' && cardTimerDuration > 0 && (!isHotSeatMode || hotSeatEnabled) && (
                <div
                  data-testid="card-spicy-timer"
                  className="max-w-sm mx-auto mb-7 space-y-2.5"
                >
                  <div
                    className="w-full h-[4px] rounded-full overflow-hidden"
                    style={{ backgroundColor: deck.progressTrackColor }}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-1000 ease-linear"
                      style={{
                        width: `${Math.max(0, Math.min(100, (secondsLeft / cardTimerDuration) * 100))}%`,
                        backgroundColor: deck.progressFillColor,
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="tabular-nums font-medium" style={{ color: deck.mutedTextColor }}>
                      {secondsLeft > 0 ? formatCountdown(secondsLeft) : 'Time’s up'}
                    </span>

                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          if (secondsLeft === 0) {
                            setSecondsLeft(cardTimerDuration);
                            setTimerRunning(true);
                          } else {
                            setTimerRunning((prev) => !prev);
                          }
                        }}
                        className="font-display font-bold text-[13px] min-h-[36px] px-3.5 rounded-full"
                        style={{ backgroundColor: deck.pillColor, color: deck.textColor }}
                      >
                        {secondsLeft === 0
                          ? `Restart ${cardTimerDuration}s`
                          : timerRunning
                            ? 'Pause'
                            : `Start ${cardTimerDuration}s`}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Option Buttons: Lock In (Partner A) or Blind Guess (Partner B) */}
              {currentCard.options && currentCard.options.length > 0 && (
                <div className="space-y-3 w-full max-w-md mx-auto">
                  {currentCard.options.map((opt, idx) => {
                    const isSelected = phase === 'answering' && selectedOptionIdx === idx;
                    const renderedOption = personalizePrompt(opt, partnerName);
                    return (
                      <motion.button
                        key={opt}
                        type="button"
                        whileTap={{ scale: 0.985 }}
                        onClick={() => {
                          if (phase === 'guessing') {
                            handlePartnerGuess(idx);
                          } else {
                            setSelectedOptionIdx(idx);
                          }
                        }}
                        style={{
                          backgroundColor: isSelected
                            ? deck.progressFillColor
                            : deck.pillColor,
                          color: isSelected ? deck.cardColor : deck.textColor,
                        }}
                        className="w-full min-h-[54px] py-3.5 px-6 rounded-full text-center text-[15px] font-semibold leading-snug transition-colors cursor-pointer"
                      >
                        {renderedOption}
                      </motion.button>
                    );
                  })}

                  {phase === 'answering' && (
                    <div className="pt-2">
                      <button
                        type="button"
                        disabled={selectedOptionIdx === null}
                        onClick={handleLockIn}
                        style={{
                          backgroundColor:
                            selectedOptionIdx === null
                              ? deck.pillColor
                              : deck.progressFillColor,
                          color:
                            selectedOptionIdx === null
                              ? deck.mutedTextColor
                              : deck.cardColor,
                        }}
                        className="w-full min-h-[52px] rounded-full font-display font-bold text-[15px] transition-colors disabled:cursor-not-allowed active:scale-[0.985]"
                      >
                        Lock In
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Subtle Veto / Plead the Fifth Trigger + IOU Confirmation */}
              {phase === 'answering' && (
                <div className="mt-6 flex flex-col items-center gap-2">
                  <button
                    type="button"
                    disabled={totalTokensLeft <= 0}
                    onClick={() => setPhase('veto-picker')}
                    className="inline-flex items-center gap-2 min-h-[40px] px-4 rounded-full text-[12px] font-medium transition-opacity disabled:opacity-35"
                    style={{ backgroundColor: deck.pillColor, color: deck.textColor }}
                  >
                    <ShieldIcon className="w-3.5 h-3.5" />
                    <span className="tabular-nums">
                      Plead the Fifth · You {vetoTokens.partnerA} · {partnerChipLabel}{' '}
                      {vetoTokens.partnerB}
                    </span>
                  </button>

                  {iouSavedNotice && (
                    <p
                      role="status"
                      className="text-[13px] font-medium"
                      style={{ color: deck.mutedTextColor }}
                    >
                      {iouSavedNotice}
                    </p>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Bottom Bar: 1.75px Monochrome SVG Stroke Icons (Save, Cash Later, Next) */}
      {!isCompleted ? (
        <footer className="w-full max-w-xs mx-auto pb-8 pt-4 px-6 z-20 flex items-center justify-between">
          <button
            type="button"
            onClick={() => currentCard && onToggleSave(currentCard.id)}
            aria-label={isSaved ? 'Remove card from saved' : 'Save card'}
            aria-pressed={isSaved}
            className="w-12 h-12 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          >
            <HeartIcon className="w-6 h-6" filled={isSaved} />
          </button>

          <button
            type="button"
            onClick={openIouComposer}
            aria-label="Cash this in later"
            className="min-h-[44px] px-4 rounded-full flex items-center gap-2 text-[13px] font-medium active:scale-95 transition-transform"
            style={{ backgroundColor: deck.pillColor, color: deck.textColor }}
          >
            <CouponIcon className="w-4 h-4" />
            <span>Cash Later</span>
          </button>

          <button
            type="button"
            onClick={handleNext}
            aria-label="Next card"
            className="w-12 h-12 rounded-full flex items-center justify-center active:scale-90 transition-transform"
          >
            <NextArrowIcon className="w-6 h-6" />
          </button>
        </footer>
      ) : (
        <div className="pb-10" />
      )}
    </div>
  );
}
