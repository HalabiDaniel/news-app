import { CATEGORY_LABELS, type Category } from '@/lib/types';

// Jump straight to the category you are in the mood for. Five articles is short
// enough to scroll and long enough that you shouldn't have to.
//
// Plain anchors to the ids ArticleView puts on each <article>, so it works
// before hydration and costs no JavaScript. The scroll-margin in globals.css is
// what stops a target landing under the fixed header.
export default function CategoryRail({ categories }: { categories: Category[] }) {
  if (categories.length === 0) return null;

  return (
    <nav className="category-rail" aria-label="Kategorien">
      {categories.map((category) => (
        <a key={category} href={`#${category}`}>
          {CATEGORY_LABELS[category] ?? category}
        </a>
      ))}
    </nav>
  );
}
