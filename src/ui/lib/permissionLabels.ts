import {
  Bell,
  Camera,
  Clipboard,
  Crosshair,
  MapPin,
  Maximize,
  Mic,
  Monitor,
  Shield,
} from 'lucide-react';
import type React from 'react';

export type IconType = React.ComponentType<{ size?: number | string; className?: string }>;

type PermissionMeta = {
  /** Noun shown in the site-settings popover ("Caméra et micro"). */
  name: string;
  /** Verb phrase used by the permission prompt ("utiliser votre caméra / micro"). */
  request: string;
  icon: IconType;
};

/**
 * Human labels for Chromium permission names, shared by the permission
 * prompt and the site-settings popover. Keys are the raw `details.permission`
 * strings the main process stores in `settings.sitePermissions`.
 */
const PERMISSIONS: Record<string, PermissionMeta> = {
  media: { name: 'Caméra et micro', request: 'utiliser votre caméra / micro', icon: Camera },
  videoCapture: { name: 'Caméra', request: 'utiliser votre caméra', icon: Camera },
  audioCapture: { name: 'Micro', request: 'utiliser votre micro', icon: Mic },
  geolocation: { name: 'Localisation', request: 'accéder à votre position', icon: MapPin },
  notifications: { name: 'Notifications', request: 'afficher des notifications', icon: Bell },
  'display-capture': { name: 'Capture d’écran', request: 'capturer votre écran', icon: Monitor },
  'clipboard-read': {
    name: 'Presse-papiers (lecture)',
    request: 'lire votre presse-papiers',
    icon: Clipboard,
  },
  pointerLock: {
    name: 'Verrouillage du pointeur',
    request: 'verrouiller votre pointeur',
    icon: Crosshair,
  },
  fullscreen: { name: 'Plein écran', request: 'passer en plein écran', icon: Maximize },
};

export function permissionName(permission: string): string {
  return PERMISSIONS[permission]?.name ?? permission;
}

export function permissionRequestLabel(permission: string): string {
  return PERMISSIONS[permission]?.request ?? `utiliser « ${permission} »`;
}

export function permissionIcon(permission: string): IconType {
  return PERMISSIONS[permission]?.icon ?? Shield;
}
