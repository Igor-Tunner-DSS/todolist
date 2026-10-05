import { useEffect, useState } from 'react';
export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme as 'light' | 'dark') || 'light');
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('theme', theme); } catch { /* ignora */ } }, [theme]);
  return { theme, toggle: () => setTheme(t => (t === 'light' ? 'dark' : 'light')) };
}
