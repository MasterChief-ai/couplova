import React, { useEffect, useState } from 'react';
import { findCardById, type GameDeck } from '../constants/decks';
import {
  IN_APP_THEMES,
  LOCKED_SPLASH_TOKENS,
  resolveTheme,
  type ActiveDeckThemeId,
} from '../constants/theme';
import { couplyApi } from '../services/api';
import type { CoupleIou, CouplyUser } from '../services/storage';
import { personalizePrompt } from '../utils/gameLogic';
import { BackArrowIcon, CheckIcon, CloseIcon, HeartIcon } from './Icons';

interface SettingsScreenProps {
  user: CouplyUser;
  savedCardIds: string[];
  ious: CoupleIou[];
  onUserUpdated: (user: CouplyUser) => void;
  onToggleSave: (cardId: string) => void;
  onToggleIou: (iouId: string, redeemed: boolean) => void;
  onDeleteIou: (iouId: string) => void;
  onOpenSavedCard: (deck: GameDeck, cardIndex: number) => void;
  onBack: () => void;
  onLogout: () => void;
}

export function SettingsScreen({
  user,
  savedCardIds,
  ious,
  onUserUpdated,
  onToggleSave,
  onToggleIou,
  onDeleteIou,
  onOpenSavedCard,
  onBack,
  onLogout,
}: SettingsScreenProps) {
  const theme = resolveTheme(user.activeDeckTheme);
  const lockedSplash = LOCKED_SPLASH_TOKENS[user.genderTheme];
  const [partnerDraft, setPartnerDraft] = useState(user.partnerName || 'Partner');
  const [savingPartner, setSavingPartner] = useState(false);
  const [partnerSaved, setPartnerSaved] = useState(false);

  useEffect(() => {
    setPartnerDraft(user.partnerName || 'Partner');
  }, [user.partnerName]);

  async function handleSelectTheme(themeId: ActiveDeckThemeId) {
    try {
      const updated = await couplyApi.updatePreferences({ activeDeckTheme: themeId });
      onUserUpdated(updated);
    } catch {
      onUserUpdated({ ...user, activeDeckTheme: themeId });
    }
  }

  async function handleSavePartner(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = partnerDraft.trim().slice(0, 40);
    if (!cleaned) return;
    setSavingPartner(true);
    setPartnerSaved(false);
    try {
      const updated = await couplyApi.updatePreferences({ partnerName: cleaned });
      onUserUpdated(updated);
      setPartnerSaved(true);
    } catch {
      onUserUpdated({ ...user, partnerName: cleaned });
      setPartnerSaved(true);
    } finally {
      setSavingPartner(false);
    }
  }

  const themeChoices = Object.values(IN_APP_THEMES);

  return (
    <div
      data-testid="settings-screen"
      style={{ backgroundColor: theme.canvas, color: theme.primaryInk }}
      className="min-h-screen w-full transition-colors duration-200"
    >
      <div className="w-full max-w-4xl mx-auto px-6 py-6 md:py-10 space-y-10">
        {/* Top Bar */}
        <header className="flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 min-h-[44px] text-[15px] font-medium"
          >
            <BackArrowIcon className="w-5 h-5" />
            <span>Decks</span>
          </button>

          <button
            type="button"
            onClick={onLogout}
            style={{ backgroundColor: theme.surface, color: theme.primaryInk }}
            className="min-h-[44px] px-5 rounded-full text-[14px] font-medium active:scale-95 transition-transform"
          >
            Log Out
          </button>
        </header>

        {/* Profile & Locked Boot Splash */}
        <section className="space-y-4">
          <h1 className="font-display text-[32px] font-extrabold tracking-[-0.03em]">
            Settings &amp; Saved Cards
          </h1>
          <p className="text-[14px]" style={{ color: theme.secondaryInk }}>
            Signed in as {user.fullName} (@{user.username}) · {user.email}
          </p>

          <div
            className="pt-4 pb-6 flex flex-wrap items-center justify-between gap-4"
            style={{ borderBottom: `1px solid ${theme.hairline}` }}
          >
            <div>
              <p className="font-display font-bold text-[16px]">Locked Boot Splash Color</p>
              <p className="text-[13px] mt-0.5" style={{ color: theme.secondaryInk }}>
                Permanently locked to your onboarding selection ({lockedSplash.label})
              </p>
            </div>
            <div
              data-testid="locked-splash-preview"
              style={{
                backgroundColor: lockedSplash.canvas,
                color: lockedSplash.primaryInk,
              }}
              className="px-5 py-2.5 rounded-full font-wordmark text-[22px] leading-none"
            >
              couplova
            </div>
          </div>
        </section>

        {/* Partner Name */}
        <section
          className="pb-8 space-y-3"
          style={{ borderBottom: `1px solid ${theme.hairline}` }}
        >
          <h2 className="font-display text-[20px] font-bold tracking-tight">
            Pass-and-Play Partner Name
          </h2>
          <form onSubmit={handleSavePartner} className="flex flex-col sm:flex-row gap-3 max-w-md">
            <input
              type="text"
              aria-label="Partner name"
              maxLength={40}
              value={partnerDraft}
              onChange={(e) => {
                setPartnerDraft(e.target.value);
                setPartnerSaved(false);
              }}
              placeholder="Partner"
              style={{ backgroundColor: theme.surface, color: theme.primaryInk }}
              className="flex-1 min-h-[48px] rounded-[16px] px-4 text-[15px] focus:outline-2"
            />
            <button
              type="submit"
              disabled={savingPartner || !partnerDraft.trim()}
              style={{ backgroundColor: theme.primaryInk, color: theme.canvas }}
              className="min-h-[48px] px-6 rounded-full font-display font-bold text-[14px] active:scale-95 transition-transform disabled:opacity-50"
            >
              {savingPartner ? 'Saving...' : partnerSaved ? 'Saved' : 'Save Name'}
            </button>
          </form>
        </section>

        {/* Active Dashboard Theme Switcher */}
        <section
          className="pb-8 space-y-4"
          style={{ borderBottom: `1px solid ${theme.hairline}` }}
        >
          <div>
            <h2 className="font-display text-[20px] font-bold tracking-tight">
              Dashboard Theme
            </h2>
            <p className="text-[13px] mt-0.5" style={{ color: theme.secondaryInk }}>
              Changes your home &amp; settings palette without altering the locked boot splash.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {themeChoices.map((choice) => {
              const active = user.activeDeckTheme === choice.id;
              const matchesCanvas = choice.canvas === theme.canvas;
              return (
                <button
                  key={choice.id}
                  type="button"
                  data-testid={`theme-option-${choice.id}`}
                  aria-pressed={active}
                  onClick={() => handleSelectTheme(choice.id)}
                  style={{
                    backgroundColor: matchesCanvas ? choice.surface : choice.canvas,
                    color: choice.primaryInk,
                    outline: active ? `2px solid ${choice.primaryInk}` : 'none',
                    outlineOffset: '-2px',
                  }}
                  className="min-h-[56px] rounded-[20px] px-4 flex items-center justify-between font-display font-bold text-[14px] active:scale-[0.98] transition-transform"
                >
                  <span>{choice.label}</span>
                  {active && <CheckIcon className="w-4 h-4 shrink-0" />}
                </button>
              );
            })}
          </div>
        </section>

        {/* Promises & IOUs */}
        <section
          data-testid="promises-ious-section"
          className="pb-8 space-y-4"
          style={{ borderBottom: `1px solid ${theme.hairline}` }}
        >
          <div className="flex items-baseline justify-between">
            <div>
              <h2 className="font-display text-[20px] font-bold tracking-tight">
                Promises &amp; IOUs
              </h2>
              <p className="text-[13px] mt-0.5" style={{ color: theme.secondaryInk }}>
                Coupons, dares, and date moves saved to cash in later.
              </p>
            </div>
            <span className="text-[13px] tabular-nums" style={{ color: theme.secondaryInk }}>
              {ious.filter((i) => !i.redeemed).length} active
            </span>
          </div>

          {ious.length === 0 ? (
            <p
              data-testid="empty-ious-state"
              className="text-[15px] py-3"
              style={{ color: theme.secondaryInk }}
            >
              No promises saved yet. Tap Cash Later during any game to stash a favor or dare here.
            </p>
          ) : (
            <div className="divide-y" style={{ borderColor: theme.hairline }}>
              {ious.map((iou) => {
                const partnerLabel =
                  user.partnerName?.trim() && user.partnerName.trim().toLowerCase() !== 'partner'
                    ? user.partnerName.trim()
                    : 'your partner';
                const whoLabel =
                  iou.owedBy === 'me'
                    ? `You owe ${partnerLabel}`
                    : iou.owedBy === 'partner'
                      ? `${partnerLabel} owes you`
                      : 'Both of you';

                return (
                  <div
                    key={iou.id}
                    className="py-4 flex flex-wrap sm:flex-nowrap items-center justify-between gap-4"
                    style={{ borderColor: theme.hairline }}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium" style={{ color: theme.secondaryInk }}>
                        {whoLabel} · {iou.deckTitle || 'Couplova'}
                      </p>
                      <p
                        className={`font-display font-bold text-[17px] mt-0.5 leading-snug ${
                          iou.redeemed ? 'line-through opacity-55' : ''
                        }`}
                      >
                        {iou.title}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onToggleIou(iou.id, !iou.redeemed)}
                        style={{
                          backgroundColor: iou.redeemed ? theme.surface : theme.primaryInk,
                          color: iou.redeemed ? theme.primaryInk : theme.canvas,
                        }}
                        className="min-h-[40px] px-4 rounded-full text-[13px] font-display font-bold active:scale-95 transition-transform whitespace-nowrap"
                      >
                        {iou.redeemed ? 'Cashed In' : 'Cash In'}
                      </button>

                      <button
                        type="button"
                        onClick={() => onDeleteIou(iou.id)}
                        aria-label={`Delete promise: ${iou.title}`}
                        className="w-10 h-10 rounded-full flex items-center justify-center opacity-60 hover:opacity-100 transition-opacity"
                      >
                        <CloseIcon className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Saved Cards */}
        <section className="pb-8 space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-[20px] font-bold tracking-tight">
              Saved Questions
            </h2>
            <span className="text-[13px] tabular-nums" style={{ color: theme.secondaryInk }}>
              {savedCardIds.length} saved
            </span>
          </div>

          {savedCardIds.length === 0 ? (
            <p
              data-testid="empty-saved-state"
              className="text-[15px] py-4"
              style={{ color: theme.secondaryInk }}
            >
              No saved questions yet. Tap the heart on any card during a game to keep it here.
            </p>
          ) : (
            <div className="divide-y" style={{ borderColor: theme.hairline }}>
              {savedCardIds.map((cardId) => {
                const match = findCardById(cardId);
                if (!match) return null;
                const promptText = personalizePrompt(match.card.prompt, user.partnerName);
                return (
                  <div
                    key={cardId}
                    className="py-4 flex items-center justify-between gap-4"
                    style={{ borderColor: theme.hairline }}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenSavedCard(match.deck, match.index)}
                      className="text-left flex-1 min-h-[44px] py-1"
                    >
                      <p className="text-[12px] font-medium" style={{ color: theme.secondaryInk }}>
                        {match.deck.indexNumber} · {match.deck.title}
                      </p>
                      <p className="font-display font-bold text-[17px] mt-0.5 leading-snug">
                        {promptText}
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => onToggleSave(cardId)}
                      aria-label={`Remove saved question: ${promptText}`}
                      className="w-11 h-11 rounded-full flex items-center justify-center shrink-0"
                    >
                      <HeartIcon className="w-5 h-5" filled />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
