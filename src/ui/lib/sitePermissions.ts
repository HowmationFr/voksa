import type { PermissionDecision } from '../../shared/types';

export type SitePermissions = Record<string, Record<string, PermissionDecision>>;

export type PermissionSetting = PermissionDecision | 'ask';

/**
 * Compute the next sitePermissions map after the user picks a setting for
 * one permission of one origin. 'ask' (the default) removes the stored
 * entry (and drops the origin key entirely once its last entry is gone)
 * so settings.json only ever contains explicit decisions.
 */
export function nextSitePermissions(
  current: SitePermissions,
  origin: string,
  permission: string,
  value: PermissionSetting,
): SitePermissions {
  const next: SitePermissions = { ...current };
  const forOrigin = { ...(next[origin] ?? {}) };
  if (value === 'ask') delete forOrigin[permission];
  else forOrigin[permission] = value;
  if (Object.keys(forOrigin).length === 0) delete next[origin];
  else next[origin] = forOrigin;
  return next;
}

/** Remove every stored decision for an origin ("Réinitialiser"). */
export function clearOriginPermissions(
  current: SitePermissions,
  origin: string,
): SitePermissions {
  if (!(origin in current)) return current;
  const next = { ...current };
  delete next[origin];
  return next;
}
