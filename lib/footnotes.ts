import type { Footnote } from './types';

export interface NumberedFootnote {
  number: number;
  word: string;
  explanation_de: string;
}

// Pair every highlighted (**…**) word in the article body with its German
// explanation and number them in the order they first appear, so the
// superscripts in the text line up 1-to-1 with the footnote list at the bottom.
//
// Numbering is driven by the *text* (not the model's array order) for
// robustness: a highlighted word the model forgot to explain is left bold-only
// with no dangling number, and an explanation for a word that never appears is
// simply dropped. Matching is by exact surface form first, then case-insensitive.
export function buildFootnotes(
  content: string,
  footnotes: Footnote[] | null | undefined,
): { numbered: NumberedFootnote[]; numberByWord: Map<string, number> } {
  const byWord = new Map<string, string>();
  const byLower = new Map<string, string>();
  for (const f of footnotes ?? []) {
    const word = typeof f?.word === 'string' ? f.word.trim() : '';
    const exp = typeof f?.explanation_de === 'string' ? f.explanation_de.trim() : '';
    if (!word || !exp) continue;
    if (!byWord.has(word)) byWord.set(word, exp);
    const lower = word.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, exp);
  }

  const numbered: NumberedFootnote[] = [];
  const numberByWord = new Map<string, number>();
  const re = /\*\*([^*]+)\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const word = m[1].trim();
    if (numberByWord.has(word)) continue; // already numbered on an earlier appearance
    const exp = byWord.get(word) ?? byLower.get(word.toLowerCase());
    if (!exp) continue; // highlighted but unexplained → stays bold, no footnote
    const number = numbered.length + 1;
    numbered.push({ number, word, explanation_de: exp });
    numberByWord.set(word, number);
  }

  return { numbered, numberByWord };
}
