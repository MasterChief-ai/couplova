import React, { useEffect } from 'react';
import { motion } from 'motion/react';
import { LOCKED_SPLASH_TOKENS, type GenderTheme } from '../constants/theme';

interface SplashScreenProps {
  lockedGender: GenderTheme;
  onComplete: () => void;
}

export function SplashScreen({ lockedGender, onComplete }: SplashScreenProps) {
  const token = LOCKED_SPLASH_TOKENS[lockedGender];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onComplete();
    }, 850);
    return () => window.clearTimeout(timer);
  }, [onComplete]);

  return (
    <main
      data-testid="splash-screen"
      data-locked-gender={lockedGender}
      onClick={onComplete}
      style={{ backgroundColor: token.canvas, color: token.primaryInk }}
      className="min-h-screen w-full flex flex-col items-center justify-center px-6 cursor-pointer select-none"
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="text-center"
      >
        <h1 className="font-wordmark text-[42px] leading-none tracking-[-0.02em]">
          couplova
        </h1>
      </motion.div>
    </main>
  );
}
