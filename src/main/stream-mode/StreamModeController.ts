import { EventEmitter } from 'node:events';
import os from 'node:os';
import type { StreamModeConfig } from '../../shared/streamConfig';
import { DEFAULT_STREAM_CONFIG } from '../../shared/streamConfig';
import { getSettings, setSettings } from '../storage/settings';

export type StreamModeEvents = {
  'config-changed': (config: StreamModeConfig) => void;
};

export class StreamModeController extends EventEmitter {
  private config: StreamModeConfig;
  private readonly internalHostname: string;

  constructor() {
    super();
    // One 'config-changed' listener per window (TabManager) plus the global
    // broadcast in handlers.ts: with enough windows the default cap of 10
    // would fire a spurious MaxListenersExceededWarning. Listeners are
    // balanced: TabManager.dispose() unsubscribes when its window closes.
    this.setMaxListeners(0);
    this.config = { ...DEFAULT_STREAM_CONFIG, ...getSettings().streamMode };
    this.internalHostname = os.hostname();
  }

  getConfig(): StreamModeConfig {
    return { ...this.config };
  }

  getInternalHostname(): string {
    return this.internalHostname;
  }

  update(patch: Partial<StreamModeConfig>): StreamModeConfig {
    const next: StreamModeConfig = { ...this.config, ...patch };
    this.config = next;
    setSettings({ streamMode: next });
    this.emit('config-changed', next);
    return next;
  }

  toggle(): StreamModeConfig {
    return this.update({ enabled: !this.config.enabled });
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }
}

let instance: StreamModeController | null = null;

export function getStreamMode(): StreamModeController {
  if (!instance) {
    instance = new StreamModeController();
  }
  return instance;
}
