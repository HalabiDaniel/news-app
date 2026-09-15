import ManualTrigger from '@/components/ManualTrigger';
import PushToggle from '@/components/PushToggle';

export const metadata = { title: 'Einstellungen — Deutsch B2 Briefing' };

// Everything that is operating the app rather than reading it.
//
// Push comes first because it is the one people come here for — and because the
// test button is a diagnostic, not a setting: when no notification arrives in
// the morning, this page is the second of the three things to check (the
// empty state on "Heute" is the first).
export default function SettingsPage() {
  return (
    <main>
      <h1 className="page-title">Einstellungen</h1>
      <p className="lede">
        Das Briefing läuft täglich automatisch in GitHub Actions. Hier stehen nur
        die Handgriffe.
      </p>

      <section className="settings-section">
        <h2>Benachrichtigungen</h2>
        <PushToggle />
      </section>

      <section className="settings-section">
        <h2>Briefing manuell erstellen</h2>
        <p className="settings-note">
          Erstellt sofort ein neues Briefing für heute und überschreibt das
          vorhandene. Braucht den CRON_SECRET-Schlüssel, der nur in diesem
          Browser gespeichert wird.
        </p>
        <ManualTrigger />
      </section>
    </main>
  );
}
