/**
 * DMCA Audio Guard, stage 1 (pure policy).
 *
 * Under Stream Mode, a BACKGROUND tab that plays sound is the classic strike:
 * a radio tab, an autoplaying ad, a video left running feed copyrighted audio
 * straight into the stream while the streamer is looking at something else.
 * The guard auto-mutes those tabs the moment they become audible, with a chip
 * on the tab to un-mute deliberately.
 *
 * Invariants, each one load-bearing:
 *  - The ACTIVE tab is never auto-muted: it is the content being shown, and
 *    cutting its sound mid-show would be the guard sabotaging the stream.
 *  - A guard-mute does NOT lift on activation. Clicking a tab is navigation,
 *    not consent: the exit is the explicit chip (allowed), nothing implicit.
 *  - The user's own mute (isMuted) is a separate flag the guard never touches:
 *    toggling Stream Mode off must restore EXACTLY the pre-stream audio state.
 *  - `allowed` is per tab and sticky for the tab's lifetime: re-guarding a tab
 *    the streamer explicitly authorized would be the tool overriding its user.
 */

export type AudioTabSnapshot = {
  isActive: boolean;
  isAudible: boolean;
  /** Muted by the USER (their toggle); the guard never stacks on it. */
  isMuted: boolean;
  /** Currently guard-muted. */
  streamMuted: boolean;
  /** The user clicked "allow on stream" on this tab. */
  allowed: boolean;
};

export type AudioGuardVerdict = 'mute' | 'unmute' | 'keep';

export function audioGuardVerdict(streamOn: boolean, tab: AudioTabSnapshot): AudioGuardVerdict {
  // Stream off, or explicitly allowed: any guard-mute is lifted. The user's
  // own mute is untouched by construction (separate flag).
  if (!streamOn || tab.allowed) return tab.streamMuted ? 'unmute' : 'keep';
  // Already guard-muted: stays, even if the tab is now active (see above).
  if (tab.streamMuted) return 'keep';
  // The user already muted it themselves: nothing to add.
  if (tab.isMuted) return 'keep';
  // The visible tab is the show.
  if (tab.isActive) return 'keep';
  return tab.isAudible ? 'mute' : 'keep';
}
