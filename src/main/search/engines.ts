import { getSettings } from '../storage/settings';
import {
  getEngine,
  resolveEngines,
  type SearchEngineDef,
} from '../../shared/searchEngines';

/**
 * The engines as they stand right now: the built-ins plus whatever the user
 * added. Resolved from settings on every call (they are seven-plus entries;
 * caching them would only buy a stale list after an edit).
 *
 * Everything in main that needs an engine goes through here, so the custom
 * ones can never be honoured in one place and ignored in another.
 */
export function currentEngines(): SearchEngineDef[] {
  return resolveEngines(getSettings().customEngines);
}

/** The user's default engine (falls back to Google if it vanished). */
export function defaultEngine(): SearchEngineDef {
  return getEngine(getSettings().searchEngine, currentEngines());
}
