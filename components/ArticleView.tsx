'use client';

import { Fragment, useCallback, useRef, useState } from 'react';
import { CATEGORY_LABELS, type ArticleRow } from '@/lib/types';
import { buildFootnotes } from '@/lib/footnotes';
import FootnoteSheet from './FootnoteSheet';

// One article, with its glossary attached to the words instead of the bottom.
//
// The old email put superscript numbers in the text and the explanations in a
// list below it, which on a phone means: scroll down, read, lose your place,
// scroll back — eight to twelve times per article, five articles a day. Here
// the bold word IS the control: tap it and the explanation appears in place.
//
// buildFootnotes (lib/footnotes.ts) does the pairing and the numbering, driven
// by the order the words appear in the *text*, so a word the model highlighted
// but never explained stays bold with no dangling reference and simply isn't
// tappable.

// The bare hostname reads better than a 120-character URL on a phone; an
// unparseable value (the column is free text) falls back to the raw string.
function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

interface Active {
  word: string;
  explanation: string;
  number: number | null;
}

export default function ArticleView({ article }: { article: ArticleRow }) {
  const [active, setActive] = useState<Active | null>(null);
  // The word that opened the sheet, so closing puts the cursor back on it
  // rather than at the top of the document.
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setActive(null);
    triggerRef.current?.focus();
    triggerRef.current = null;
  }, []);

  const label = CATEGORY_LABELS[article.category] ?? article.category;
  const paragraphs = article.content_de.split(/\n{2,}/);
  const { numbered } = buildFootnotes(article.content_de, article.footnotes);

  // word → explanation, for the tap handler. Built from the numbered list so
  // the sheet can only ever show a word that actually has an explanation.
  const explanations = new Map(numbered.map((f) => [f.word, f]));

  // Turn **word** markers into elements without dangerouslySetInnerHTML, so
  // database content is always treated as plain text. A highlighted word with
  // an explanation becomes a button; one without stays a plain <strong>.
  function renderInline(text: string, key: string) {
    return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
      const m = part.match(/^\*\*([^*]+)\*\*$/);
      if (!m) return <Fragment key={`${key}-${i}`}>{part}</Fragment>;

      const word = m[1].trim();
      const footnote = explanations.get(word);
      if (!footnote) return <strong key={`${key}-${i}`}>{m[1]}</strong>;

      const isOpen = active?.word === word;
      return (
        <button
          key={`${key}-${i}`}
          type="button"
          className="gloss"
          aria-expanded={isOpen}
          onClick={(e) => {
            if (isOpen) {
              close();
              return;
            }
            triggerRef.current = e.currentTarget;
            setActive({
              word,
              explanation: footnote.explanation_de,
              number: footnote.number,
            });
          }}
        >
          {m[1]}
          <span className="gloss-number">{footnote.number}</span>
        </button>
      );
    });
  }

  return (
    <article className="article" id={article.category}>
      <p className="article-category">{label}</p>
      <h2 className="article-title">{article.title_de.replace(/\*\*/g, '')}</h2>
      <p className="article-summary">
        <span className="article-title-en">{article.title_en}</span>
        {article.summary_en}
      </p>

      <div className="article-body">
        {paragraphs.map((p, i) => (
          <p key={i}>{renderInline(p, String(i))}</p>
        ))}
      </div>

      {numbered.length > 0 && (
        // Kept, but closed: a review tool for after the read, not during it.
        <details className="footnote-list">
          <summary>{numbered.length} Wörter im Überblick</summary>
          <ol>
            {numbered.map((f) => (
              <li key={f.number} value={f.number}>
                <strong>{f.word}</strong> – {f.explanation_de}
              </li>
            ))}
          </ol>
        </details>
      )}

      {article.source_url && (
        <p className="article-source">
          Quelle:{' '}
          <a href={article.source_url} target="_blank" rel="noreferrer">
            {sourceLabel(article.source_url)}
          </a>
        </p>
      )}

      {active && (
        <FootnoteSheet
          word={active.word}
          explanation={active.explanation}
          number={active.number}
          onClose={close}
        />
      )}
    </article>
  );
}
