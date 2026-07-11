/**
 * Minimal gettext-style i18n shared by the main process and the UI.
 *
 * The SOURCE string is French (the app's original language) and doubles as
 * the dictionary key; English lives in per-domain dictionaries under en/.
 * A missing entry falls back to the French source, so an untranslated
 * string is a cosmetic bug, never a crash.
 *
 * Interpolation: "{name}" placeholders, e.g.
 *   t('Version {version} prete', { version: '1.2.0' })
 */
import { enChrome } from './en/chrome';
import { enMenus } from './en/menus';
import { enPages } from './en/pages';
import { enSettings } from './en/settings';
import { enStream } from './en/stream';
import { enDialogs } from './en/dialogs';
import { enMain } from './en/main';

export type Language = 'fr' | 'en';
export type LanguageSetting = 'system' | Language;

const EN: Record<string, string> = {
  ...enChrome,
  ...enMenus,
  ...enPages,
  ...enSettings,
  ...enStream,
  ...enDialogs,
  ...enMain,
};

/** 'system' resolves against the OS locale; anything non-French gets English. */
export function resolveLanguage(setting: LanguageSetting | undefined, systemLocale: string): Language {
  if (setting === 'fr' || setting === 'en') return setting;
  return systemLocale.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** BCP47 tag for date/number formatting (toLocaleDateString etc.). */
export function localeTag(lang: Language): string {
  return lang === 'fr' ? 'fr-FR' : 'en-US';
}

export function translate(
  lang: Language,
  source: string,
  params?: Record<string, string | number>,
): string {
  let text = lang === 'fr' ? source : (EN[source] ?? source);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      text = text.split(`{${key}}`).join(String(value));
    }
  }
  return text;
}
