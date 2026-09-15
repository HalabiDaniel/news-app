'use client';

import { useEffect } from 'react';

// The explanation, shown where you are rather than at the bottom of the page.
//
// A bottom sheet on a phone, a centred card on a desktop (the difference is
// pure CSS). Deliberately NOT a <dialog>: a modal dialog scroll-locks the page
// and moves focus in a way that loses your reading position on iOS, and the
// whole point of this component is that dismissing it puts you back exactly
// where you were. So: no scroll lock, no page movement, Escape and a tap
// outside both close it, and focus returns to the word you tapped.
export interface FootnoteSheetProps {
  word: string;
  explanation: string;
  number: number | null;
  onClose: () => void;
}

export default function FootnoteSheet({ word, explanation, number, onClose }: FootnoteSheetProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <>
      {/* A button, not a div: closing by tapping outside should work for a
          keyboard and a screen reader too, without inventing an ARIA role. */}
      <button
        type="button"
        className="sheet-backdrop"
        aria-label="Erklärung schließen"
        onClick={onClose}
      />
      <div className="sheet" role="dialog" aria-modal="false" aria-label={`Erklärung: ${word}`}>
        <p className="sheet-word">
          {word}
          {number !== null ? <span className="gloss-number">{number}</span> : null}
        </p>
        <p className="sheet-explanation">{explanation}</p>
        <button type="button" className="sheet-close" onClick={onClose}>
          Schließen
        </button>
      </div>
    </>
  );
}
