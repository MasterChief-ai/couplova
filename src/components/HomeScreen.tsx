import React from 'react';
import { motion } from 'motion/react';
import { GAME_DECKS, type GameDeck } from '../constants/decks';
import { resolveTheme } from '../constants/theme';
import type { CouplyUser } from '../services/storage';
import { NextArrowIcon, SettingsGearIcon } from './Icons';

interface HomeScreenProps {
  user: CouplyUser;
  savedCount: number;
  onSelectDeck: (deck: GameDeck) => void;
  onOpenSettings: () => void;
}

export function HomeScreen({
  user,
  savedCount,
  onSelectDeck,
  onOpenSettings,
}: HomeScreenProps) {
  const theme = resolveTheme(user.activeDeckTheme);
  const rawPartner = user.partnerName?.trim();
  const displayPartner =
    rawPartner && rawPartner.toLowerCase() !== 'partner' ? rawPartner : 'your partner';

  return (
    <div
      data-testid="home-screen"
      style={{ backgroundColor: theme.canvas, color: theme.primaryInk }}
      className="min-h-screen w-full transition-colors duration-200"
    >
      <div className="w-full max-w-6xl mx-auto px-6 pb-14 pt-6 md:pt-8">
        {/* Top Bar: Romantic italic Couplova wordmark top-left, circular blush pill settings icon top-right */}
        <header className="flex items-center justify-between pb-6 md:pb-8">
          <a
            href="#decks"
            onClick={(e) => e.preventDefault()}
            className="font-wordmark text-[42px] leading-none tracking-[-0.02em] select-none whitespace-nowrap shrink-0"
            style={{ color: theme.primaryInk }}
          >
            couplova
          </a>

          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Open settings and saved cards"
            style={{ backgroundColor: '#F4C2C2', color: '#1A1113' }}
            className="w-11 h-11 rounded-full flex items-center justify-center active:scale-95 transition-transform shrink-0"
          >
            <SettingsGearIcon className="w-5 h-5" />
          </button>
        </header>

        {/* Quiet Editorial Subheading */}
        <div className="flex flex-wrap items-end justify-between gap-4 pb-6">
          <div>
            <h1
              className="font-display text-[28px] md:text-[32px] font-extrabold tracking-[-0.03em] leading-tight [text-wrap:balance]"
              style={{ color: theme.primaryInk }}
            >
              Just the Two of Us
            </h1>
            <p className="mt-1 text-[14px]" style={{ color: theme.secondaryInk }}>
              You &amp; {displayPartner} • <span className="tabular-nums">{savedCount}</span> favorites kept
            </p>
          </div>
          <p className="text-[13px] font-medium tabular-nums" style={{ color: theme.secondaryInk }}>
            {GAME_DECKS.length} moods ready for tonight
          </p>
        </div>

        {/* Tactile, Colorful Stack of Solid-Matte Playing-Card Tiles (28px radius, zero borders, zero shadows) */}
        <main className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4 md:gap-5">
          {GAME_DECKS.map((deck, idx) => {
            // 01-02 span half each on desktop, 03-05 form a 3-up row, 06 After Hours spans full width
            const desktopSpan =
              idx < 2
                ? 'lg:col-span-3'
                : idx === 5
                  ? 'md:col-span-2 lg:col-span-6'
                  : 'lg:col-span-2';

            return (
              <motion.button
                key={deck.id}
                type="button"
                data-testid={`deck-tile-${deck.id}`}
                onClick={() => onSelectDeck(deck)}
                whileTap={{ scale: 0.982 }}
                transition={{ type: 'spring', stiffness: 450, damping: 30 }}
                style={{
                  backgroundColor: deck.cardColor,
                  color: deck.textColor,
                }}
                className={`${desktopSpan} w-full text-left rounded-[28px] p-7 md:p-8 min-h-[188px] md:min-h-[214px] flex flex-col justify-between cursor-pointer select-none focus-visible:outline-2 focus-visible:outline-offset-2`}
              >
                <div className="flex items-center justify-between w-full">
                  <span
                    className="font-display text-[13px] font-bold tracking-wide tabular-nums"
                    style={{ color: deck.mutedTextColor }}
                  >
                    {deck.indexNumber}
                  </span>
                  <span
                    className="text-[13px] font-medium tabular-nums"
                    style={{ color: deck.mutedTextColor }}
                  >
                    {deck.cards.length} Cards
                  </span>
                </div>

                <div className="pt-8">
                  <h2 className="font-display text-[28px] leading-[1.15] font-extrabold tracking-[-0.03em] [text-wrap:balance]">
                    {deck.title}
                  </h2>
                  <div className="mt-2.5 flex items-end justify-between gap-4">
                    <p
                      className={`text-[14px] leading-snug ${idx === 5 ? 'max-w-xl' : 'max-w-sm'}`}
                      style={{ color: deck.mutedTextColor }}
                    >
                      {deck.descriptor}
                    </p>
                    <span className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ backgroundColor: deck.pillColor }}>
                      <NextArrowIcon className="w-4 h-4" />
                    </span>
                  </div>
                </div>
              </motion.button>
            );
          })}
        </main>
      </div>
    </div>
  );
}
