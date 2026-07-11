/**
 * UI side of the i18n layer. The source string is French; useT() returns a
 * translator bound to the resolved language (settings.language, with
 * 'system' following the OS locale via navigator.language, which the chrome
 * UI renderer inherits from the system).
 */
import { useCallback } from 'react';
import {
  localeTag,
  resolveLanguage,
  translate,
  type Language,
} from '../../shared/i18n';
import { useSettingsStore } from '../stores/settingsStore';

export function useLanguage(): Language {
  const setting = useSettingsStore((s) => s.settings.language);
  return resolveLanguage(setting, navigator.language);
}

/** BCP47 tag for toLocaleDateString / toLocaleTimeString / Intl. */
export function useLocaleTag(): string {
  return localeTag(useLanguage());
}

export function useT(): (source: string, params?: Record<string, string | number>) => string {
  const lang = useLanguage();
  return useCallback(
    (source: string, params?: Record<string, string | number>) => translate(lang, source, params),
    [lang],
  );
}
