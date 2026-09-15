'use client';

import { useEffect, useState } from 'react';

// A small "generate now" control for pulling a fresh briefing on demand — e.g.
// some evening reading on top of the morning one — without touching the daily
// schedule (which runs in GitHub Actions, not here).
//
// It lives on /einstellungen, not on the reading surface: it is an operator
// control, and a button that spends money has no business sitting under the
// morning's prose. It calls the on-demand
// endpoint with ?force=1 so the once-a-day guard is bypassed for this run only.
//
// Note this path runs as a Vercel function and so has the 60s ceiling the
// scheduled run was moved away from: on a slow morning it may come back with
// fewer than five articles. That's the deliberate trade for a one-tap button —
// use the workflow when you need a guaranteed full run.
//
// Auth: the endpoint is protected by CRON_SECRET so random visitors can't run up
// OpenAI charges. We never bake that secret into the shipped bundle; instead the
// user enters it once and we keep it in localStorage, like a saved password.

const KEY_STORAGE = 'briefingTriggerKey';
const ENDPOINT = '/api/cron/daily-briefing?force=1';

type Status = 'idle' | 'working' | 'done' | 'error';

export default function ManualTrigger() {
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [askingKey, setAskingKey] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    setSavedKey(localStorage.getItem(KEY_STORAGE));
  }, []);

  async function run(key: string) {
    setStatus('working');
    setMessage('Erstelle ein neues Briefing … das kann bis zu einer Minute dauern. Bitte diese Seite offen lassen.');
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 401) {
          // Bad key — forget it and ask again.
          localStorage.removeItem(KEY_STORAGE);
          setSavedKey(null);
          setAskingKey(true);
          throw new Error('Schlüssel ungültig. Bitte erneut eingeben.');
        }
        throw new Error(data?.error || `Fehler (${res.status}).`);
      }

      setStatus('done');
      setMessage('Fertig! Die neuen Artikel werden geladen …');
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Unbekannter Fehler.');
    }
  }

  function handleClick() {
    if (status === 'working') return;
    if (savedKey) {
      run(savedKey);
    } else {
      setAskingKey(true);
    }
  }

  function handleSubmitKey(e: React.FormEvent) {
    e.preventDefault();
    const key = keyInput.trim();
    if (!key) return;
    localStorage.setItem(KEY_STORAGE, key);
    setSavedKey(key);
    setKeyInput('');
    setAskingKey(false);
    run(key);
  }

  return (
    <section className="manual-trigger">
      {askingKey ? (
        <form onSubmit={handleSubmitKey} className="manual-trigger-form">
          <label htmlFor="trigger-key">Auslöse-Schlüssel (CRON_SECRET)</label>
          <input
            id="trigger-key"
            type="password"
            autoComplete="off"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="Schlüssel eingeben"
          />
          <div className="manual-trigger-row">
            <button type="submit">Speichern &amp; erstellen</button>
            <button type="button" className="link" onClick={() => setAskingKey(false)}>
              Abbrechen
            </button>
          </div>
          <p className="manual-trigger-note">
            Wird nur in diesem Browser gespeichert, um das Briefing manuell auszulösen.
          </p>
        </form>
      ) : (
        <button type="button" onClick={handleClick} disabled={status === 'working'}>
          {status === 'working' ? 'Wird erstellt …' : 'Neues Briefing jetzt erstellen'}
        </button>
      )}

      {message && (
        <p className={`manual-trigger-status ${status}`} role="status" aria-live="polite">
          {message}
        </p>
      )}
    </section>
  );
}
