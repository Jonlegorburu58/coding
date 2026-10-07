import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { portalStore } from './store';

/** Copies text to the clipboard inside the click handler; returns false if the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

export function useClearData() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return () => {
    portalStore.clear();
    qc.clear();
    navigate('/import');
  };
}

