import { useEffect, useRef } from 'react';
import type { DownloadItem } from '../../shared/types';
import { voksa } from '../lib/bridge';
import { useSettingsStore } from '../stores/settingsStore';
import { useStreamStore } from '../stores/streamStore';
import { useUpdateReady } from '../stores/updatesStore';

/**
 * Sound Signals: short WebAudio cues on state transitions, so the streamer
 * HEARS the mask go up or down without looking away from OBS. Generated
 * oscillator notes, no assets, nothing to load; OBS will capture them like it
 * captures Discord's beeps, which is fine: they are short and carry nothing.
 *
 * Only TRANSITIONS beep. The mount state is swallowed on purpose: booting
 * with Stream Mode restored must stay silent, and so must the initial
 * downloads/update snapshots.
 */

type Note = { freq: number; at: number; dur: number };

const CUES: Record<'arm' | 'disarm' | 'download' | 'update', Note[]> = {
  arm: [
    { freq: 523.25, at: 0, dur: 0.09 },
    { freq: 783.99, at: 0.1, dur: 0.12 },
  ],
  disarm: [
    { freq: 783.99, at: 0, dur: 0.09 },
    { freq: 523.25, at: 0.1, dur: 0.12 },
  ],
  download: [{ freq: 659.25, at: 0, dur: 0.1 }],
  update: [
    { freq: 587.33, at: 0, dur: 0.08 },
    { freq: 587.33, at: 0.12, dur: 0.08 },
  ],
};

function playCue(kind: keyof typeof CUES): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    for (const note of CUES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.freq;
      // Tiny attack/release ramps: a raw oscillator start clicks audibly.
      gain.gain.setValueAtTime(0, now + note.at);
      gain.gain.linearRampToValueAtTime(0.1, now + note.at + 0.015);
      gain.gain.setValueAtTime(0.1, now + note.at + note.dur - 0.02);
      gain.gain.linearRampToValueAtTime(0, now + note.at + note.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + note.at);
      osc.stop(now + note.at + note.dur + 0.02);
    }
    window.setTimeout(() => void ctx.close(), 800);
  } catch {
    // no audio output: cues are best-effort by nature
  }
}

export function SoundSignals(): null {
  const cues = useSettingsStore((s) => s.settings.soundCues);
  const cuesRef = useRef(cues);
  cuesRef.current = cues;

  // Stream armed / disarmed.
  const streamEnabled = useStreamStore((s) => s.config.enabled);
  const prevStream = useRef<boolean | null>(null);
  useEffect(() => {
    if (prevStream.current === null) {
      prevStream.current = streamEnabled;
      return;
    }
    if (streamEnabled !== prevStream.current) {
      prevStream.current = streamEnabled;
      if (cuesRef.current.streamToggle) playCue(streamEnabled ? 'arm' : 'disarm');
    }
  }, [streamEnabled]);

  // Download completed: one beep per item transitioning INTO 'completed'.
  useEffect(() => {
    let known: Map<string, DownloadItem['state']> | null = null;
    return voksa.downloads.onChanged((items) => {
      if (known === null) {
        known = new Map(items.map((d) => [d.id, d.state]));
        return;
      }
      for (const d of items) {
        if (d.state === 'completed' && known.get(d.id) !== 'completed') {
          if (cuesRef.current.downloadDone) playCue('download');
        }
        known.set(d.id, d.state);
      }
    });
  }, []);

  // Update ready: rising edge only.
  const updateReady = useUpdateReady();
  const prevReady = useRef(false);
  useEffect(() => {
    if (updateReady && !prevReady.current && cuesRef.current.updateReady) playCue('update');
    prevReady.current = updateReady;
  }, [updateReady]);

  return null;
}
