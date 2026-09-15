import Link from 'next/link';
import BriefingDay from '@/components/BriefingDay';
import { getArticlesForDate } from '@/lib/queries';
import { formatDisplayDate } from '@/lib/dates';

export const revalidate = 300;

// One past day. The same reading view as the homepage — an archived briefing is
// not a lesser thing, and tapping a word has to work here too.
//
// The route segment is German (`/archiv/[datum]`) like the rest of the UI. The
// old `/archive/[date]` paths redirect, in next.config.mjs.
export default async function ArchiveDatePage({
  params,
}: {
  params: Promise<{ datum: string }>;
}) {
  const { datum } = await params;
  const articles = await getArticlesForDate(datum);

  return (
    <main>
      <Link className="back-link" href="/archiv">
        ← Archiv
      </Link>
      <h1 className="page-title">{formatDisplayDate(datum)}</h1>

      {articles.length === 0 ? (
        <div className="state">
          <h2>Für dieses Datum liegt kein Briefing vor.</h2>
          <p>
            Entweder wurde an diesem Tag keines erstellt, oder das Datum stimmt
            nicht. <Link href="/archiv">Zurück zum Archiv</Link>.
          </p>
        </div>
      ) : (
        <BriefingDay articles={articles} />
      )}
    </main>
  );
}
