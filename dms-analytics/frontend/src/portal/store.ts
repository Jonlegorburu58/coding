/**
 * In-memory state of the portal: the files being mapped and the imported
 * dataset. Nothing here is ever written to browser storage (D217); closing or
 * reloading the tab, or "Clear data", discards it.
 */
import { useSyncExternalStore } from 'react';
import type { PortalDataset } from './build';
import type { RawTable } from './readFile';
import { loadSettings, type PortalSettings } from './settings';
import { applyImport } from './shim';

export interface Draft {
  docs: RawTable | null;
  matters: RawTable | null;
  isSample: boolean;
}

export interface PortalState {
  draft: Draft;
  settings: PortalSettings;
  dataset: PortalDataset | null;
}

const emptyDraft = (): Draft => ({ docs: null, matters: null, isSample: false });

let state: PortalState = { draft: emptyDraft(), settings: loadSettings(), dataset: null };
const listeners = new Set<() => void>();

function set(next: Partial<PortalState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export const portalStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setDraft(d: Partial<Draft>) {
    set({ draft: { ...state.draft, ...d } });
  },
  setSettings(s: PortalSettings) {
    set({ settings: s });
  },
  setDataset(ds: PortalDataset) {
    applyImport(ds);
    set({ dataset: ds });
  },
  /** Drop every imported row from memory. Settings (mapping only) are kept. */
  clear() {
    applyImport(null);
    set({ dataset: null, draft: emptyDraft() });
  },
};

export function usePortal(): PortalState {
  return useSyncExternalStore(portalStore.subscribe, portalStore.get, portalStore.get);
}
