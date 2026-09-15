import ArticleView from './ArticleView';
import CategoryRail from './CategoryRail';
import type { ArticleRow } from '@/lib/types';

// The reading view for one day, shared by `/` and `/archiv/[datum]` — the two
// routes differ only in their heading and in what an empty day means.
export default function BriefingDay({ articles }: { articles: ArticleRow[] }) {
  return (
    <>
      <CategoryRail categories={articles.map((a) => a.category)} />
      {articles.map((article) => (
        <ArticleView key={article.id} article={article} />
      ))}
    </>
  );
}
