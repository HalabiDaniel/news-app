import Link from 'next/link';
import { getVocabulary } from '@/lib/queries';
import { formatShortDate, relativeDaysDe } from '@/lib/dates';

export const revalidate = 300;

export const metadata = { title: 'Vokabeln — Deutsch B2 Briefing' };

// The vocabulary the app has been accumulating since day one and never shown.
//
// `vocabulary` already carries `times_used_total` and `last_used_date` — the
// pipeline writes them on every run so the model can repeat words for spaced
// repetition. This page needs no new data at all; it just puts the least-seen
// words at the top, which is the order that makes the list a revision tool
// rather than a dump.
export default async function VocabularyPage() {
  const words = await getVocabulary();

  if (words.length === 0) {
    return (
      <main>
        <h1 className="page-title">Vokabeln</h1>
        <div className="state">
          <h2>Noch keine Vokabeln.</h2>
          <p>Die Wortliste füllt sich mit jedem Briefing.</p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1 className="page-title">Vokabeln</h1>
      <p className="lede">
        {words.length} Wörter, am seltensten gesehene zuerst.
      </p>

      <ul className="vocab-list">
        {words.map((w) => (
          <li key={w.id}>
            <p className="vocab-word">{w.german_word}</p>
            <p className="vocab-english">{w.english_translation}</p>
            <p className="vocab-meta">
              {w.times_used_total === 0
                ? 'noch nicht wiederholt'
                : `${w.times_used_total}× verwendet`}
              {w.last_used_date ? ` · zuletzt ${relativeDaysDe(w.last_used_date)}` : null}
              {w.source ? (
                <>
                  {' · aus '}
                  <Link href={`/archiv/${w.source.date}`}>
                    {formatShortDate(w.source.date)}: {w.source.title_de}
                  </Link>
                </>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
