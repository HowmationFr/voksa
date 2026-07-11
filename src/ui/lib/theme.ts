import { useEffect } from 'react';
import { voksa } from './bridge';
import { useSettingsStore } from '../stores/settingsStore';

function resolve(theme: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

function apply(resolved: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  void voksa.app.setTheme(resolved);
}

/**
 * Keeps the chrome UI (and the native window background) in sync with the
 * user's theme preference, following the OS when set to 'system'.
 */
export function useThemeSync(): void {
  const theme = useSettingsStore((s) => s.settings.theme);

  useEffect(() => {
    apply(resolve(theme));
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply(resolve('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);
}
