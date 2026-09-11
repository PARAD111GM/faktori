import { Children, isValidElement, useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { sectionHelp } from './section-help-content.ts';
import './section-help.css';

function plainText(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number'
    ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : '').join(' ').trim();
}

function HelpDialog({ title, scope, close }: { title: string; scope: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const help = sectionHelp(title, scope);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className="section-help-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-summary`} onClose={close}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.currentTarget.close();
    }}>
    <header><div><span className="help-kicker">Operator’s handbook</span><h2 id={`${id}-title`}>{title}</h2></div><button type="button" aria-label="Close section help" onClick={() => dialog.current?.close()}>×</button></header>
    <div className="help-content"><h3>What this shows</h3><p id={`${id}-summary`}>{help.summary}</p><h3>Where it comes from</h3><p>{help.source}</p><h3>What to do next</h3><p>{help.next}</p>{help.note && <p className="help-note">{help.note}</p>}</div>
    <footer><button type="button" onClick={() => dialog.current?.close()}>Got it</button></footer>
  </dialog>, document.body);
}

export function SectionHelp({ title, scope = 'main' }: { title: string; scope?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <><button ref={trigger} className="section-help-trigger" type="button" aria-label={`About ${title}`} aria-haspopup="dialog" onClick={event => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}>
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.4" /><path d="M10 9v5" stroke="currentColor" strokeWidth="1.5" /><circle cx="10" cy="6" r="1" fill="currentColor" /></svg>
  </button>{open && <HelpDialog title={title} scope={scope} close={() => { setOpen(false); trigger.current?.focus(); }} />}</>;
}

export function HelpHeading({ level = 2, scope = 'main', helpTitle, children, ...attributes }: HTMLAttributes<HTMLHeadingElement> & { level?: 1 | 2 | 3 | 4; scope?: string; helpTitle?: string }) {
  const Heading = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
  return <Heading {...attributes}>{children}<SectionHelp title={helpTitle ?? plainText(children)} scope={scope} /></Heading>;
}

export function HelpSummary({ scope = 'main', children, ...attributes }: HTMLAttributes<HTMLElement> & { scope?: string }) {
  return <summary {...attributes}>{children}<SectionHelp title={plainText(children)} scope={scope} /></summary>;
}
