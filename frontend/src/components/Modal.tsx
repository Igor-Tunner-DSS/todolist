import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './Icons';
export default function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,button.primary,button.danger')?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) { // focus trap
        const f = [...ref.current.querySelectorAll<HTMLElement>('button,input')].filter(x => !x.hasAttribute('disabled'));
        if (!f.length) return; const a = document.activeElement;
        if (e.shiftKey && a === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && a === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('keydown', k); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header><h2>{title}</h2><button type="button" className="icon" aria-label="Fechar" onClick={onClose}><CloseIcon /></button></header>
        {children}
      </div>
    </div>
  );
}
