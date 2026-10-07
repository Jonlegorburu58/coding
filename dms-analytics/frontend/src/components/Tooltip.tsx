import { useCallback, useState, type ReactNode } from 'react';

export interface TipState { x: number; y: number; content: ReactNode }

/** One floating tooltip for hover and keyboard focus on chart marks. Content is rendered as React text. */
export function useTip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const show = useCallback((e: { clientX: number; clientY: number } | DOMRect, content: ReactNode) => {
    if ('clientX' in e) setTip({ x: e.clientX + 14, y: e.clientY + 14, content });
    else setTip({ x: e.left + e.width / 2, y: e.bottom + 8, content });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const node = tip ? (
    <div className="tip" role="tooltip" style={{ left: Math.min(tip.x, window.innerWidth - 300), top: tip.y }}>
      {tip.content}
    </div>
  ) : null;
  return { show, hide, node };
}
