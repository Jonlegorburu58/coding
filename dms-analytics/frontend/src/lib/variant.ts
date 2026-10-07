import { createContext, useContext, type ComponentType, type ReactNode } from 'react';

export interface ExportButtonProps {
  build: () => Promise<string> | string;
  filename: string;
  label?: string;
  disabled?: boolean;
}

/**
 * Lets a build variant (the single-file portal) adapt shared screens without the
 * shared code importing it. The default is the normal app, so production
 * behaviour is unchanged.
 */
export interface AppVariant {
  /** Replaces the "Export CSV" (save to file) button. */
  ExportButton?: ComponentType<ExportButtonProps>;
  /** False where window.print() is unavailable. */
  canPrint: boolean;
  /** Replaces the mode badge, last-synced time and user in the top bar. */
  topbar?: ReactNode;
  /** Replaces the coverage banner. */
  coverage?: ReactNode;
  /** Replaces the "Sync & settings" navigation entry. */
  appNav?: { to: string; label: string; icon: string };
  sidenavFoot?: ReactNode;
  /** Shown by data screens instead of the first-run state when there is no data. */
  noData?: ReactNode;
  /** Shown instead of a trend chart that has fewer than two snapshots. */
  singleSnapshot?: { title: string; body: string };
}

const VariantContext = createContext<AppVariant>({ canPrint: true });
export const VariantProvider = VariantContext.Provider;
export const useVariant = () => useContext(VariantContext);
