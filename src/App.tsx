import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AdminDashboardScreen } from './components/AdminDashboardScreen';
import { AuthScreen } from './components/AuthScreen';
import { HomeScreen } from './components/HomeScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { SplashScreen } from './components/SplashScreen';
import { StoryDeckScreen } from './components/StoryDeckScreen';
import type { GameDeck } from './constants/decks';
import {
  ApiError,
  couplyApi,
  subscribeColdStart,
  subscribeSessionExpired,
} from './services/api';
import {
  clearAuthSession,
  getCachedIous,
  getCachedSavedCardIds,
  getLockedSplashGender,
  getStoredAccessToken,
  getStoredUser,
  setCachedIous,
  setCachedSavedCardIds,
  type CoupleIou,
  type CouplyUser,
} from './services/storage';
import { prepareDeckForPlay } from './utils/gameLogic';

type AppRoute = 'splash' | 'auth' | 'home' | 'deck' | 'settings';

export default function App() {
  const isAdminPath =
    typeof window !== 'undefined' &&
    window.location.pathname.replace(/\/+$/, '') === '/admin';

  if (isAdminPath) {
    return <AdminDashboardScreen />;
  }

  return <CouplovaApp />;
}

function CouplovaApp() {
  const isAutostart =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('autostart') === '1';

  const [route, setRoute] = useState<AppRoute>(isAutostart ? 'home' : 'splash');
  const [user, setUser] = useState<CouplyUser | null>(() => getStoredUser());
  const [lockedSplashGender, setLockedSplashGender] = useState(() =>
    getLockedSplashGender(),
  );
  const [activeDeck, setActiveDeck] = useState<{
    deck: GameDeck;
    initialIndex: number;
  } | null>(null);
  const [savedCardIds, setSavedCardIds] = useState<string[]>(() =>
    getCachedSavedCardIds(),
  );
  const [ious, setIous] = useState<CoupleIou[]>(() => getCachedIous());
  const [isColdStarting, setIsColdStarting] = useState(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [bootstrapDone, setBootstrapDone] = useState(false);
  const splashEndedRef = useRef(false);

  const syncSavedCards = useCallback(async () => {
    try {
      const [cardsRes, iousRes] = await Promise.all([
        couplyApi.getSavedCards(),
        couplyApi.getIous().catch(() => null),
      ]);
      const ids = cardsRes.savedCards.map((c) => c.card_id);
      setSavedCardIds(ids);
      setCachedSavedCardIds(ids);
      if (iousRes) {
        setIous(iousRes.ious);
        setCachedIous(iousRes.ious);
      }
    } catch {
      // Offline-first: retain local saved card & IOU cache if backend is asleep
    }
  }, []);

  // Subscribe to >3s Render cold-start notice & 30-day session expiry
  useEffect(() => {
    const unsubCold = subscribeColdStart(setIsColdStarting);
    const unsubExpired = subscribeSessionExpired((reason) => {
      setUser(null);
      setSavedCardIds([]);
      setIous([]);
      setAuthNotice(reason);
      setRoute('auth');
    });
    return () => {
      unsubCold();
      unsubExpired();
    };
  }, []);

  // Handle ?confirm=... email link, ?autostart=1, or verify existing session on mount
  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        if (typeof window !== 'undefined') {
          const params = new URLSearchParams(window.location.search);
          const confirmToken = params.get('confirm');
          if (confirmToken) {
            // Immediately scrub the token from URL / browser history to prevent referrer leaks
            params.delete('confirm');
            const cleanSearch = params.toString();
            const cleanUrl = `${window.location.pathname}${cleanSearch ? `?${cleanSearch}` : ''}`;
            window.history.replaceState({}, '', cleanUrl);

            try {
              const session = await couplyApi.confirmEmailLink({ token: confirmToken });
              if (!active) return;
              setUser(session.user);
              setLockedSplashGender(session.user.genderTheme);
              setAuthNotice(null);
              setRoute('home');
              void syncSavedCards();
              return;
            } catch (err) {
              if (!active) return;
              setAuthNotice(
                err instanceof Error
                  ? err.message
                  : 'Confirmation link expired or already used. Please request a new code.',
              );
              setRoute('auth');
              return;
            }
          }
        }

        if (isAutostart && !getStoredAccessToken()) {
          try {
            const demo = await couplyApi.demoSignIn();
            if (!active) return;
            setUser(demo.user);
            setLockedSplashGender(demo.user.genderTheme);
            setRoute('home');
            void syncSavedCards();
            return;
          } catch {
            if (!active) return;
          }
        }

        if (getStoredAccessToken()) {
          try {
            const freshUser = await couplyApi.getMe();
            if (!active) return;
            setUser(freshUser);
            setLockedSplashGender(freshUser.genderTheme);
            void syncSavedCards();
          } catch (err) {
            if (!active) return;
            const isAuthRejection =
              err instanceof ApiError &&
              (err.status === 401 || err.status === 403 || err.status === 404);
            if (isAuthRejection || !getStoredUser()) {
              clearAuthSession();
              setUser(null);
              setSavedCardIds([]);
              setIous([]);
              if (isAuthRejection) {
                setRoute((curr) => (curr === 'splash' ? curr : 'auth'));
              }
            }
          }
        }
      } finally {
        if (active) {
          setBootstrapDone(true);
        }
      }
    }

    void bootstrap();
    return () => {
      active = false;
    };
  }, [isAutostart, syncSavedCards]);

  // Advance off splash once both the splash animation and initial session check complete
  useEffect(() => {
    if (!bootstrapDone || !splashEndedRef.current) return;
    setRoute((current) => {
      if (current !== 'splash') return current;
      return user && getStoredAccessToken() ? 'home' : 'auth';
    });
  }, [bootstrapDone, user]);

  // Foreground + 60-second heartbeat telemetry when authenticated
  useEffect(() => {
    if (!user) return;

    const sendPulse = () => {
      if (document.visibilityState === 'visible') {
        void couplyApi.sendHeartbeat().catch(() => {});
      }
    };

    sendPulse();
    const interval = window.setInterval(sendPulse, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        sendPulse();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [user]);

  const handleSplashComplete = useCallback(() => {
    splashEndedRef.current = true;
    if (!bootstrapDone) return;
    setRoute((current) => {
      if (current !== 'splash') return current;
      return user && getStoredAccessToken() ? 'home' : 'auth';
    });
  }, [bootstrapDone, user]);

  function handleAuthenticated(authedUser: CouplyUser) {
    setUser(authedUser);
    setLockedSplashGender(authedUser.genderTheme);
    setAuthNotice(null);
    setRoute('home');
    void syncSavedCards();
  }

  async function handleToggleSave(cardId: string) {
    let wasSaved = false;
    setSavedCardIds((prev) => {
      wasSaved = prev.includes(cardId);
      const nextIds = wasSaved ? prev.filter((id) => id !== cardId) : [cardId, ...prev];
      setCachedSavedCardIds(nextIds);
      return nextIds;
    });

    try {
      if (wasSaved) {
        await couplyApi.unsaveCard(cardId);
      } else {
        await couplyApi.saveCard(cardId);
      }
    } catch {
      // Keep local cache intact during server sleep
    }
  }

  async function handleCreateIou(payload: {
    title: string;
    owedBy: 'me' | 'partner' | 'both';
    cardId?: string;
    deckId?: string;
    deckTitle?: string;
  }) {
    const optimistic: CoupleIou = {
      id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}`,
      cardId: payload.cardId || '',
      deckId: payload.deckId || '',
      deckTitle: payload.deckTitle || 'Couplova',
      title: payload.title.trim(),
      owedBy: payload.owedBy,
      redeemed: false,
      redeemedAt: null,
      createdAt: new Date().toISOString(),
    };
    setIous((prev) => {
      const nextList = [optimistic, ...prev];
      setCachedIous(nextList);
      return nextList;
    });

    try {
      const res = await couplyApi.createIou(payload);
      setIous((prev) => {
        const nextList = [res.iou, ...prev.filter((item) => item.id !== optimistic.id)];
        setCachedIous(nextList);
        return nextList;
      });
    } catch {
      // Keep offline cache if server is temporarily asleep
    }
  }

  async function handleToggleIouRedeemed(iouId: string, redeemed: boolean) {
    const nowIso = redeemed ? new Date().toISOString() : null;
    setIous((prev) => {
      const nextList = prev.map((item) =>
        item.id === iouId ? { ...item, redeemed, redeemedAt: nowIso } : item,
      );
      setCachedIous(nextList);
      return nextList;
    });

    try {
      const res = await couplyApi.toggleIouRedeemed(iouId, redeemed);
      setIous((prev) => {
        const synced = prev.map((item) => (item.id === iouId ? res.iou : item));
        setCachedIous(synced);
        return synced;
      });
    } catch {
      // Keep optimistic cache intact
    }
  }

  async function handleDeleteIou(iouId: string) {
    setIous((prev) => {
      const nextList = prev.filter((item) => item.id !== iouId);
      setCachedIous(nextList);
      return nextList;
    });

    try {
      await couplyApi.deleteIou(iouId);
    } catch {
      // Keep optimistic cache intact
    }
  }

  async function handleLogout() {
    try {
      await couplyApi.logout();
    } catch {
      clearAuthSession();
    }
    setUser(null);
    setSavedCardIds([]);
    setIous([]);
    setActiveDeck(null);
    setRoute('auth');
  }

  return (
    <>
      {isColdStarting && (
        <div
          role="status"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 rounded-full bg-[#1A1113] text-[#FAF8F5] text-[13px] font-medium"
        >
          Waking up Couplova servers, hang tight...
        </div>
      )}

      {route === 'splash' && (
        <SplashScreen
          lockedGender={lockedSplashGender}
          onComplete={handleSplashComplete}
        />
      )}

      {route === 'auth' && (
        <AuthScreen
          initialNotice={authNotice}
          onAuthenticated={handleAuthenticated}
        />
      )}

      {route === 'home' && user && (
        <HomeScreen
          user={user}
          savedCount={savedCardIds.length}
          onSelectDeck={(deck) => {
            setActiveDeck({ deck: prepareDeckForPlay(deck), initialIndex: 0 });
            setRoute('deck');
          }}
          onOpenSettings={() => setRoute('settings')}
        />
      )}

      {route === 'deck' && activeDeck && user && (
        <StoryDeckScreen
          deck={activeDeck.deck}
          partnerName={user.partnerName}
          initialCardIndex={activeDeck.initialIndex}
          savedCardIds={savedCardIds}
          onToggleSave={handleToggleSave}
          onSaveIou={handleCreateIou}
          onClose={() => {
            setActiveDeck(null);
            setRoute('home');
          }}
        />
      )}

      {route === 'settings' && user && (
        <SettingsScreen
          user={user}
          savedCardIds={savedCardIds}
          ious={ious}
          onUserUpdated={setUser}
          onToggleSave={handleToggleSave}
          onToggleIou={handleToggleIouRedeemed}
          onDeleteIou={handleDeleteIou}
          onOpenSavedCard={(deck, cardIndex) => {
            setActiveDeck({
              deck: prepareDeckForPlay(deck, { preserveOrder: true }),
              initialIndex: cardIndex,
            });
            setRoute('deck');
          }}
          onBack={() => setRoute('home')}
          onLogout={handleLogout}
        />
      )}
    </>
  );
}
