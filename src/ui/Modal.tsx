import { useEffect, useRef, useState, type ReactNode } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog. Moved by dragging its title (it can sit over what you need to see - the line just
 * drawn for a calibration). see: the page behind stays readable (a light backdrop) and a click
 * beside the dialog doesn't close it - for dialogs about what is on the page.
 */
export function Modal({ title, sub, onClose, children, wide, actions, className, see }: { title: string; sub?: ReactNode; onClose(): void; children?: ReactNode; wide?: boolean | 'xl'; actions?: ReactNode; className?: string; see?: boolean }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [off, setOff] = useState<[number, number]>([0, 0]);
  const moving = useRef<{ x: number; y: number; ox: number; oy: number; L: number; T: number; W: number } | null>(null);
  const grab = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !box.current) return;
    const r = box.current.getBoundingClientRect();
    // (its place without the move so far)
    moving.current = { x: e.clientX, y: e.clientY, ox: off[0], oy: off[1], L: r.left - off[0], T: r.top - off[1], W: r.width };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const move = (e: React.PointerEvent<HTMLElement>) => {
    const m = moving.current;
    if (!m) return;
    // (kept in the window: always some of it - its title - left to grab)
    const nx = Math.max(-m.L - m.W + 120, Math.min(window.innerWidth - m.L - 120, m.ox + e.clientX - m.x));
    const ny = Math.max(-m.T, Math.min(window.innerHeight - m.T - 48, m.oy + e.clientY - m.y));
    setOff([nx, ny]);
  };
  const drop = () => { moving.current = null; };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  // the keyboard belongs to the dialog: it takes the focus (unless something in it asked for it),
  // Tab goes round inside it - Enter or Tab never reach the ribbon or the tabs behind it
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const back = document.activeElement as HTMLElement | null;
    if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[autofocus]') || el).focus({ preventScroll: true });
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !el.isConnected) return;
      const all = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null && getComputedStyle(x).visibility !== 'hidden');
      if (!all.length) { e.preventDefault(); return; }
      const i = all.indexOf(document.activeElement as HTMLElement);
      if (!el.contains(document.activeElement) || (e.shiftKey && i <= 0) || (!e.shiftKey && i === all.length - 1)) {
        e.preventDefault();
        all[e.shiftKey ? all.length - 1 : 0].focus();
      }
    };
    const keep = (e: FocusEvent) => { if (el.isConnected && e.target instanceof Node && !el.contains(e.target) && !(e.target as HTMLElement).closest?.('.modal, .cmenu, .toast')) el.focus({ preventScroll: true }); };
    window.addEventListener('keydown', trap, true);
    document.addEventListener('focusin', keep, true);
    return () => {
      window.removeEventListener('keydown', trap, true);
      document.removeEventListener('focusin', keep, true);
      if (back && back.isConnected && !document.querySelector('.modal')) back.focus?.({ preventScroll: true });
    };
  }, []);
  return (
    <div className={'scrim' + (see ? ' see' : '')} onPointerDown={(e) => { if (e.target === e.currentTarget && !see) onClose(); }}>
      <div ref={box} tabIndex={-1} className={'modal' + (wide === 'xl' ? ' xl' : wide ? ' wide' : '') + (className ? ' ' + className : '')} role="dialog" aria-modal="true" aria-label={title}
        style={off[0] || off[1] ? { transform: `translate(${off[0]}px, ${off[1]}px)` } : undefined}>
        <h2 className="mgrab" title="Drag to move this window" onPointerDown={grab} onPointerMove={move} onPointerUp={drop} onPointerCancel={drop} onDoubleClick={() => setOff([0, 0])}>{title}</h2>
        {sub && <p className="sub">{sub}</p>}
        {children}
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}

export interface Toast { id: number; text: string; kind?: 'ok' | 'err' | 'busy' | 'info'; action?: { label: string; run(): void }; progress?: number }
