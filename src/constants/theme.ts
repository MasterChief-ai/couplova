export type GenderTheme = 'female' | 'male';

export type ActiveDeckThemeId =
  | 'default'
  | 'obsidian'
  | 'terracotta'
  | 'olive'
  | 'mulberry'
  | 'female'
  | 'male';

export interface ThemePalette {
  id: ActiveDeckThemeId;
  label: string;
  canvas: string;
  surface: string;
  primaryInk: string;
  secondaryInk: string;
  hairline: string;
  accentPillBg: string;
  accentPillInk: string;
  isDark: boolean;
}

export const LOCKED_SPLASH_TOKENS: Record<
  GenderTheme,
  {
    canvas: string;
    surface: string;
    primaryInk: string;
    secondaryInk: string;
    label: string;
  }
> = {
  female: {
    canvas: '#F4C2C2',
    surface: '#E8AEAE',
    primaryInk: '#1A1113',
    secondaryInk: 'rgba(26, 17, 19, 0.55)',
    label: 'Her (Warm Rose)',
  },
  male: {
    canvas: '#B8D0E8',
    surface: '#A3C0DE',
    primaryInk: '#0F1924',
    secondaryInk: 'rgba(15, 25, 36, 0.55)',
    label: 'Him (Powder Slate)',
  },
};

export const IN_APP_THEMES: Record<ActiveDeckThemeId, ThemePalette> = {
  default: {
    id: 'default',
    label: 'Warm Cream',
    canvas: '#FAF8F5',
    surface: '#F1EDE6',
    primaryInk: '#1A1113',
    secondaryInk: 'rgba(26, 17, 19, 0.58)',
    hairline: 'rgba(26, 17, 19, 0.08)',
    accentPillBg: '#F4C2C2',
    accentPillInk: '#1A1113',
    isDark: false,
  },
  obsidian: {
    id: 'obsidian',
    label: 'Obsidian',
    canvas: '#121212',
    surface: '#1E1E1E',
    primaryInk: '#FAF8F5',
    secondaryInk: 'rgba(250, 248, 245, 0.55)',
    hairline: 'rgba(250, 248, 245, 0.10)',
    accentPillBg: '#1E1E1E',
    accentPillInk: '#FAF8F5',
    isDark: true,
  },
  terracotta: {
    id: 'terracotta',
    label: 'Terracotta',
    canvas: '#9E472A',
    surface: '#873A20',
    primaryInk: '#FAF8F5',
    secondaryInk: 'rgba(250, 248, 245, 0.65)',
    hairline: 'rgba(250, 248, 245, 0.14)',
    accentPillBg: '#873A20',
    accentPillInk: '#FAF8F5',
    isDark: true,
  },
  olive: {
    id: 'olive',
    label: 'Olive',
    canvas: '#556B2F',
    surface: '#465925',
    primaryInk: '#FAF8F5',
    secondaryInk: 'rgba(250, 248, 245, 0.65)',
    hairline: 'rgba(250, 248, 245, 0.14)',
    accentPillBg: '#465925',
    accentPillInk: '#FAF8F5',
    isDark: true,
  },
  mulberry: {
    id: 'mulberry',
    label: 'Mulberry',
    canvas: '#8B4367',
    surface: '#733554',
    primaryInk: '#FAF8F5',
    secondaryInk: 'rgba(250, 248, 245, 0.65)',
    hairline: 'rgba(250, 248, 245, 0.14)',
    accentPillBg: '#733554',
    accentPillInk: '#FAF8F5',
    isDark: true,
  },
  female: {
    id: 'female',
    label: 'Warm Rose',
    canvas: '#F4C2C2',
    surface: '#E8AEAE',
    primaryInk: '#1A1113',
    secondaryInk: 'rgba(26, 17, 19, 0.58)',
    hairline: 'rgba(26, 17, 19, 0.10)',
    accentPillBg: '#E8AEAE',
    accentPillInk: '#1A1113',
    isDark: false,
  },
  male: {
    id: 'male',
    label: 'Powder Slate',
    canvas: '#B8D0E8',
    surface: '#A3C0DE',
    primaryInk: '#0F1924',
    secondaryInk: 'rgba(15, 25, 36, 0.58)',
    hairline: 'rgba(15, 25, 36, 0.10)',
    accentPillBg: '#A3C0DE',
    accentPillInk: '#0F1924',
    isDark: false,
  },
};

export function resolveTheme(themeId: string | undefined): ThemePalette {
  if (themeId && themeId in IN_APP_THEMES) {
    return IN_APP_THEMES[themeId as ActiveDeckThemeId];
  }
  return IN_APP_THEMES.default;
}
