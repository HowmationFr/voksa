/**
 * Main-process side of the i18n layer (native menu, permission dialogs...).
 * Reads the language setting on every call: cheap, and always current.
 */
import { app } from 'electron';
import { resolveLanguage, translate, type Language } from '../shared/i18n';
import { getSettings } from './storage/settings';

export function currentLanguage(): Language {
  return resolveLanguage(getSettings().language, app.getLocale());
}

export function t(source: string, params?: Record<string, string | number>): string {
  return translate(currentLanguage(), source, params);
}
