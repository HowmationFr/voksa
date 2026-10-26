import type { WebContents } from 'electron';
import {
  webRtcPolicyFor,
  type StreamModeConfig,
  type WebRtcIpPolicy,
} from '../../shared/streamConfig';

/**
 * Stream Mode's WebRTC IP protection, applied per webContents.
 *
 * Chromium keeps the WebRTC IP handling policy in each webContents' renderer
 * prefs (the `force-webrtc-ip-handling-policy` switch is only read by
 * content_shell and headless, never by Electron), and a stub of
 * RTCPeerConnection in the preload's isolated world is invisible to page
 * scripts. So the policy is pushed onto EVERY webContents, from its creation
 * (tabs, managed popups, popups of popups, extension hosts, the chrome UI:
 * a future webContents is protected without anyone remembering to wire it),
 * and re-pushed live onto all of them whenever the config changes it.
 *
 * Applied at creation, i.e. before the first navigation: a page can never
 * build an RTCPeerConnection under the permissive default while Stream Mode
 * is on. A connection created BEFORE a toggle-ON keeps the candidates it
 * already gathered (the policy only binds new port allocators).
 */
export type WebRtcPolicyDeps = {
  getStreamConfig: () => StreamModeConfig;
  /** Subscribe to Stream Mode config changes. */
  onConfigChanged: (cb: (config: StreamModeConfig) => void) => void;
  /** Subscribe to the creation of every webContents (app 'web-contents-created'). */
  onContentsCreated: (cb: (wc: WebContents) => void) => void;
  /** Every live webContents (webContents.getAllWebContents()). */
  allContents: () => WebContents[];
};

function applyPolicy(wc: WebContents, policy: WebRtcIpPolicy): void {
  try {
    if (!wc.isDestroyed()) wc.setWebRTCIPHandlingPolicy(policy);
  } catch (err) {
    // A webContents torn down mid-loop must not stop the others.
    console.warn('[stream] could not apply the WebRTC IP policy:', err);
  }
}

/**
 * Wire the policy. Must run before any webContents exists (index.ts calls it
 * before app 'ready'), so the creation hook sees every single one.
 */
export function installWebRtcPolicy(deps: WebRtcPolicyDeps): void {
  let current = webRtcPolicyFor(deps.getStreamConfig());
  deps.onContentsCreated((wc) => applyPolicy(wc, current));
  deps.onConfigChanged((config) => {
    const next = webRtcPolicyFor(config);
    // Cosmetic or mask-only changes (dragging the color picker) leave the
    // policy alone: no renderer-prefs sync per webContents on every step.
    if (next === current) return;
    current = next;
    for (const wc of deps.allContents()) applyPolicy(wc, current);
  });
}
