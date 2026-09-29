import { useCallback, useEffect, useState } from 'react';

/**
 * Section 10: "Dark mode by default with a light theme."
 *
 * Default, not forced — a stated preference wins over the system's, and
 * someone who has never expressed one gets dark. The attribute is written on
 * `<html>` so the CSS in index.css can re-point every semantic token at once.
 */

export type Theme = 'dark' | 'light';

const KEY = 'cooked:theme';

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    // Private windows and blocked site data throw on access rather than
    // returning null, and a theme preference is not worth a crash.
    return null;
  }
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? 'dark');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Same as above: the theme still applies for this session.
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggle };
}
