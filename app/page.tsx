/**
 * Placeholder home page (Phase 1).
 *
 * Deliberately not the reading UI — that is Phase 4, and designing it here
 * would mean throwing it away. This exists so the App Router has a route to
 * render and `npm run build` proves the scaffold, the deploy and CI all work
 * before any of the real surface is written.
 */
export default function HomePage() {
  return (
    <main>
      <h1>Deutsch B2 Briefing</h1>
      <p>
        Die Seite wird gerade neu gebaut. Das tägliche Briefing läuft weiter und
        wird hier erscheinen.
      </p>
    </main>
  );
}
