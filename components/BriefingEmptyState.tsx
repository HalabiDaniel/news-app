import Link from 'next/link';
import { formatDisplayDate, relativeDaysDe } from '@/lib/dates';
import type { BriefingRunRow } from '@/lib/queries';

// The empty state is the monitoring (Phase 3.5). There is no alerting beyond
// GitHub's own failed-run email, and with push replacing email a broken run is
// silent — no notification looks exactly like not having picked up the phone.
// So this box has one job: answer "is the app broken, or is it just early?"
//
// It answers with the last successful date. "Letztes Briefing: vor 3 Tagen" is
// a working alarm that happens to be read every morning, and it catches the
// case GitHub's notifications miss entirely — a scheduled workflow that was
// auto-disabled after 60 days of repository inactivity and never ran at all.

// The run starts at 03:23 UTC (05:23 Berlin in summer, 04:23 in winter) and
// takes a few minutes. Before this hour a missing briefing is normal; after it,
// it is news.
const EXPECTED_BY_HOUR_BERLIN = 7;

export interface BriefingEmptyStateProps {
  date: string;
  /** The berlin hour at render time; only meaningful for today. */
  hour: number | null;
  run: BriefingRunRow | null;
  lastDate: string | null;
  dbReachable: boolean;
}

export default function BriefingEmptyState({
  date,
  hour,
  run,
  lastDate,
  dbReachable,
}: BriefingEmptyStateProps) {
  const lastLine = lastDate ? (
    <p>
      Letztes Briefing: <Link href={`/archiv/${lastDate}`}>{formatDisplayDate(lastDate)}</Link> (
      {relativeDaysDe(lastDate, date)}).
    </p>
  ) : null;

  // Nothing at all came back — not the articles, not the run row, not even a
  // vocabulary probe. That is an outage, not an empty morning, and saying so
  // saves half an hour of wondering why the briefing "didn't run".
  if (!dbReachable) {
    return (
      <div className="state is-broken">
        <h2>Die Datenbank antwortet nicht.</h2>
        <p>
          Das Briefing kann gerade nicht geladen werden. Das liegt nicht am
          täglichen Lauf — bitte den Status von Supabase prüfen.
        </p>
      </div>
    );
  }

  if (run?.status === 'failed') {
    return (
      <div className="state is-broken">
        <h2>Der heutige Lauf ist fehlgeschlagen.</h2>
        {run.error_message ? (
          <p>
            <code>{run.error_message}</code>
          </p>
        ) : null}
        {lastLine}
      </div>
    );
  }

  if (run?.status === 'pending') {
    return (
      <div className="state">
        <h2>Das heutige Briefing wird gerade erstellt.</h2>
        <p>Der Lauf hat begonnen. In ein paar Minuten steht es hier.</p>
        {lastLine}
      </div>
    );
  }

  // No row for today at all. Before the expected hour that is simply early;
  // after it, the workflow never started — which is what a disabled schedule
  // looks like from here.
  const early = hour === null || hour < EXPECTED_BY_HOUR_BERLIN;

  if (early) {
    return (
      <div className="state">
        <h2>Das heutige Briefing wird gerade erstellt.</h2>
        <p>Es erscheint normalerweise gegen 5:30 Uhr (Berliner Zeit).</p>
        {lastLine}
      </div>
    );
  }

  return (
    <div className="state is-broken">
      <h2>Für heute liegt kein Briefing vor.</h2>
      <p>
        Es hätte längst da sein sollen — der tägliche Lauf ist offenbar gar nicht
        gestartet.
      </p>
      {lastLine}
    </div>
  );
}
