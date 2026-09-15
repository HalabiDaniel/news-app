import Link from 'next/link';
import { getArchiveIndex } from '@/lib/queries';
import { formatMonthLabel, formatShortDate, monthKey } from '@/lib/dates';

export const revalidate = 300;

export const metadata = { title: 'Archiv — Deutsch B2 Briefing' };

// The archive index, grouped by month, each day showing its five German titles.
//
// The old index was a bare list of dates, which is unusable past about two
// weeks: nobody remembers which Tuesday the article about the pension reform
// was. Titles make it skimmable at fifty days and beyond, and the month
// headings give the scroll some structure.
export default async function ArchivePage() {
  const days = await getArchiveIndex();

  if (days.length === 0) {
    return (
      <main>
        <h1 className="page-title">Archiv</h1>
        <div className="state">
          <h2>Noch keine Briefings vorhanden.</h2>
          <p>Sobald der erste Lauf durch ist, erscheinen die Tage hier.</p>
        </div>
      </main>
    );
  }

  // Days arrive newest-first, so months come out in the same order.
  const months: { key: string; label: string; days: typeof days }[] = [];
  for (const day of days) {
    const key = monthKey(day.date);
    let month = months[months.length - 1];
    if (!month || month.key !== key) {
      month = { key, label: formatMonthLabel(day.date), days: [] };
      months.push(month);
    }
    month.days.push(day);
  }

  return (
    <main>
      <h1 className="page-title">Archiv</h1>
      <p className="lede">
        {days.length} {days.length === 1 ? 'Tag' : 'Tage'}
      </p>

      {months.map((month) => (
        <section key={month.key}>
          <h2 className="month-heading">{month.label}</h2>
          <ul className="day-list">
            {month.days.map((day) => (
              <li key={day.date}>
                <Link href={`/archiv/${day.date}`}>
                  <p className="day-date">{formatShortDate(day.date)}</p>
                  <p className="day-titles">
                    {day.titles.map((t) => (
                      <span key={t.category}>{t.title_de}</span>
                    ))}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
