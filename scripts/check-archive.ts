/**
 * Audit the whole archive against what the new UI expects.
 *
 *   npm run check-archive
 *
 * This is the cutover check (Phase 6.2). Both the old app and this one write to
 * the same Supabase project, so there is no data migration — but there is also
 * no guarantee that a row written a year ago by the old pipeline still renders
 * correctly here. The easy thing to miss is that the new UI has to handle the
 * FULL history, not just the rows it wrote itself: `topic_tag` did not exist
 * before the diversity check, and `footnotes` did not exist before the glossary.
 * Both are nullable for exactly that reason, and both are used on every page.
 *
 * It reads and reports; it never writes. A finding here is a UI bug to fix, not
 * data to repair.
 */
import { formatDisplayDate } from '../lib/dates';
import { buildFootnotes } from '../lib/footnotes';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { CATEGORY_ORDER, type ArticleRow } from '../lib/types';

interface Problem {
  date: string;
  category: string;
  detail: string;
}

/** Anything that would render as a blank, a crash, or a dangling reference. */
function inspect(row: ArticleRow): string[] {
  const problems: string[] = [];

  // The three columns every page dereferences without a guard.
  if (!row.title_de?.trim()) problems.push('title_de is empty');
  if (!row.content_de?.trim()) problems.push('content_de is empty');
  if (!CATEGORY_ORDER.includes(row.category)) problems.push(`unknown category "${row.category}"`);

  // footnotes must be an ARRAY of {word, explanation_de}. A row from before the
  // column existed is null, which is fine — buildFootnotes takes null. An object
  // or a JSON *string* is not fine, and is what a hand-edited row tends to be.
  if (row.footnotes !== null && row.footnotes !== undefined && !Array.isArray(row.footnotes)) {
    problems.push(`footnotes is ${typeof row.footnotes}, not an array`);
  }

  // Highlighted-but-unexplained words are legal (they stay bold and untappable),
  // so this is a note about reading quality, not a broken row — it is only worth
  // reporting when an article has no working glossary at all.
  const bold = new Set((row.content_de?.match(/\*\*([^*]+)\*\*/g) ?? []).map((s) => s));
  const { numbered } = buildFootnotes(row.content_de ?? '', Array.isArray(row.footnotes) ? row.footnotes : null);
  if (bold.size > 0 && numbered.length === 0) {
    problems.push(`${bold.size} highlighted word(s), none explained`);
  }

  return problems;
}

async function main(): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('articles')
    .select('*')
    .order('briefing_date', { ascending: true });

  if (error) {
    console.error(`Could not read articles: ${error.message}`);
    process.exit(1);
  }

  const rows = (data ?? []) as ArticleRow[];
  if (rows.length === 0) {
    console.log('No articles in the database yet — nothing to check.');
    return;
  }

  const days = new Set(rows.map((r) => r.briefing_date));
  const withoutTopicTag = rows.filter((r) => !r.topic_tag?.trim()).length;
  const withoutFootnotes = rows.filter((r) => !Array.isArray(r.footnotes) || r.footnotes.length === 0).length;

  const problems: Problem[] = [];
  for (const row of rows) {
    for (const detail of inspect(row)) {
      problems.push({ date: row.briefing_date, category: row.category, detail });
    }
  }

  const first = rows[0].briefing_date;
  const last = rows[rows.length - 1].briefing_date;

  console.log(`\nArticles     ${rows.length} across ${days.size} day(s)`);
  console.log(`Range        ${formatDisplayDate(first)}  →  ${formatDisplayDate(last)}`);
  // Both of these are expected to be non-zero on an archive that predates the
  // columns. They are printed so the number is a known quantity rather than a
  // surprise the first time somebody scrolls that far back.
  console.log(`No topic_tag ${withoutTopicTag} (pre-diversity-check rows; the title is used instead)`);
  console.log(`No footnotes ${withoutFootnotes} (pre-glossary rows; words render bold and untappable)`);

  // The vocabulary counters the /vokabeln page sorts by. Zero everywhere means
  // the persist step stopped incrementing them, which the page can't show you.
  const { data: vocab } = await supabase
    .from('vocabulary')
    .select('german_word, times_used_total, last_used_date')
    .order('last_used_date', { ascending: false, nullsFirst: false })
    .limit(1);
  const newest = vocab?.[0] as { german_word: string; times_used_total: number; last_used_date: string | null } | undefined;
  console.log(
    newest
      ? `Vocabulary   most recent: ${newest.german_word} (used ${newest.times_used_total}×, last ${newest.last_used_date ?? 'never'})`
      : 'Vocabulary   empty — the starter seed in supabase/schema.sql has not been run',
  );

  if (problems.length === 0) {
    console.log('\n✅ Every row in the archive renders under the current UI.\n');
    return;
  }

  console.log(`\n⚠️  ${problems.length} problem(s):\n`);
  for (const p of problems) {
    console.log(`  ${p.date}  ${p.category.padEnd(11)} ${p.detail}`);
  }
  console.log('\nThese are UI bugs to fix, not rows to repair — the archive is history.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
