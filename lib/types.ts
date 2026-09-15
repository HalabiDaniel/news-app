export type Category = 'politics' | 'finance' | 'technology' | 'gaming' | 'germany';

// The fixed order used everywhere: emails, the website, and the article prompt.
export const CATEGORY_ORDER: Category[] = [
  'politics',
  'finance',
  'technology',
  'gaming',
  'germany',
];

export const CATEGORY_LABELS: Record<Category, string> = {
  politics: 'Politik',
  finance: 'Finanzen',
  technology: 'Technologie',
  gaming: 'Gaming',
  germany: 'Leben in Deutschland',
};

export interface VocabNew {
  german: string;
  english: string;
}

// A highlighted word in an article paired with a short German-only explanation.
// Rendered as a numbered footnote under the article (email + website).
export interface Footnote {
  word: string;
  explanation_de: string;
}

// Shape of a single article as returned by the model.
export interface GeneratedArticle {
  category: Category;
  title_en: string;
  source_url: string | null;
  summary_en: string;
  // A short English label for what this story is ABOUT ("pension reform bill",
  // "Bundesliga streaming rights"). Written by the choice step and stored so
  // the next few days can be steered away from the same subject — this is the
  // memory that stops every Politik piece being about the same person.
  topic_tag: string;
  title_de: string;
  content_de: string;
  footnotes: Footnote[];
  vocab_used: string[];
  vocab_new: VocabNew[];
}

export interface GenerationResult {
  date: string;
  articles: GeneratedArticle[];
}

// Row shape of the `articles` table.
export interface ArticleRow {
  id: string;
  briefing_date: string;
  category: Category;
  title_en: string;
  source_url: string | null;
  summary_en: string;
  topic_tag: string | null;
  title_de: string;
  content_de: string;
  footnotes: Footnote[];
  vocab_used: string[];
  vocab_new: string[];
  created_at: string;
}

// Row shape of the `vocabulary` table.
export interface VocabRow {
  id: string;
  german_word: string;
  english_translation: string;
  cefr_level: string;
  date_first_introduced: string;
  times_used_total: number;
  last_used_date: string | null;
  created_at: string;
}

// A previously covered story, as fed back into the shortlist and choice steps so
// they can avoid repeating themselves. Deliberately tiny: they need to recognise
// a subject, not re-read the article.
export interface RecentTopic {
  briefing_date: string;
  category: Category;
  title_de: string;
  topic_tag: string | null;
}
