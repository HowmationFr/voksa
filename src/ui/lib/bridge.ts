import type { VoksaApi } from '../../preload/voksaApi';

declare global {
  interface Window {
    voksa: VoksaApi;
  }
}

export const voksa: VoksaApi = window.voksa;
