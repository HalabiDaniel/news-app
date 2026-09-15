import BriefingDay from '@/components/BriefingDay';
import BriefingEmptyState from '@/components/BriefingEmptyState';
import PushNudge from '@/components/PushNudge';
import { berlinDateString, berlinHour, formatDisplayDate } from '@/lib/dates';
import {
  getArticlesForDate,
  getBriefingRun,
  getLatestBriefingDate,
  isDatabaseReachable,
} from '@/lib/queries';

// Regenerate at most every 5 minutes so a fresh briefing shows up on its own.
// The daily run also pings /api/revalidate the moment it finishes, so in
// practice the content is here before the push notification is.
//
// There is deliberately no AutoRefresh component any more. A 5-minute
// location.reload() made sense when ISR was the only way to learn a briefing
// had landed; in a standalone PWA, iOS keeps the page alive for hours and that
// timer fires mid-sentence. Push tells you when there is something new.
export const revalidate = 300;

export default async function HomePage() {
  const today = berlinDateString();
  const articles = await getArticlesForDate(today);

  if (articles.length > 0) {
    return (
      <main>
        <h1 className="page-title">Heute</h1>
        <p className="page-date">{formatDisplayDate(today)}</p>
        <PushNudge />
        <BriefingDay articles={articles} />
      </main>
    );
  }

  // Only when there is nothing to read do we pay for the diagnosis.
  const [run, lastDate, dbReachable] = await Promise.all([
    getBriefingRun(today),
    getLatestBriefingDate(today),
    isDatabaseReachable(),
  ]);

  return (
    <main>
      <h1 className="page-title">Heute</h1>
      <p className="page-date">{formatDisplayDate(today)}</p>
      <BriefingEmptyState
        date={today}
        hour={berlinHour()}
        run={run}
        lastDate={lastDate}
        dbReachable={dbReachable}
      />
    </main>
  );
}
