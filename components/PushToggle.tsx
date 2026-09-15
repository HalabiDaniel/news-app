'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Turning the morning notification on, and proving it still works.
 *
 * Almost everything odd in here is an iOS constraint rather than a preference:
 *
 *   * Push is offered ONLY to a site added to the Home Screen. In a Safari tab
 *     the APIs exist but subscribing fails, so a tab visitor gets the
 *     "Teilen → Zum Home-Bildschirm" instruction instead of a button that
 *     cannot work. This is the step everyone gets stuck on.
 *   * The permission prompt must come from a real user gesture. Asking on mount
 *     is silently ignored, so the ask lives inside the tap handler and nowhere
 *     else.
 *   * You get ONE prompt, ever. A denial is permanent until the home-screen app
 *     is deleted and re-added, which is why the button says what it will do
 *     before it is pressed, and why the denied state explains the only recovery.
 *   * Subscriptions expire with no event of any kind. Hence the test button,
 *     which is a permanent fixture, not scaffolding.
 */

const PASSPHRASE_STORAGE = 'pushPassphrase';
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';

type Stage =
  | 'loading'
  | 'unsupported' // no service worker / push API at all (old iOS, odd browser)
  | 'install' // works here, but only once added to the home screen
  | 'denied' // the one-shot prompt was answered "no"
  | 'off' // ready to subscribe
  | 'on'; // subscribed

type Tone = 'idle' | 'working' | 'good' | 'bad';

/**
 * The VAPID public key travels as base64url; subscribe() wants raw bytes.
 *
 * The buffer is allocated explicitly so the result is a `Uint8Array<ArrayBuffer>`
 * rather than the `ArrayBufferLike` a bare `new Uint8Array(n)` produces — as of
 * TypeScript 5.7 the latter no longer satisfies `BufferSource`.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * Is this the installed app rather than a browser tab?
 *
 * `navigator.standalone` is the iOS answer and the display-mode query is
 * everyone else's; iOS only started answering the query reliably recently, so
 * both are checked.
 */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return iosStandalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * The active service worker, or an error after 8 seconds.
 *
 * `navigator.serviceWorker.ready` never rejects and never times out: if the
 * registration failed, it simply waits forever. Racing it keeps a failed
 * install from leaving this component stuck on "Wird geprüft …" with no way to
 * find out why.
 */
function activeRegistration(): Promise<ServiceWorkerRegistration> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Der Service Worker ist nicht bereit. App schließen und neu öffnen.')),
        8000,
      ),
    ),
  ]);
}

export default function PushToggle() {
  const [stage, setStage] = useState<Stage>('loading');
  const [message, setMessage] = useState('');
  const [tone, setTone] = useState<Tone>('idle');
  const [busy, setBusy] = useState(false);
  const [askingPassphrase, setAskingPassphrase] = useState(false);
  const [passInput, setPassInput] = useState('');

  const say = useCallback((text: string, t: Tone = 'idle') => {
    setMessage(text);
    setTone(t);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        // On iOS this means below 16.4, which is the single most likely reason
        // nothing works — worth naming rather than showing a dead button.
        if (!cancelled) setStage('unsupported');
        return;
      }
      if (!isStandalone()) {
        if (!cancelled) setStage('install');
        return;
      }
      if (Notification.permission === 'denied') {
        if (!cancelled) setStage('denied');
        return;
      }

      // ServiceWorker (in the layout) has already asked for the registration;
      // this waits for it to become active rather than racing it.
      const registration = await activeRegistration();
      const existing = await registration.pushManager.getSubscription();
      if (!cancelled) setStage(existing ? 'on' : 'off');
    })().catch((err) => {
      // Most likely the worker never activated. Offer the button anyway — it
      // retries the registration — but say what went wrong rather than sit on
      // a spinner.
      if (cancelled) return;
      setStage('off');
      say(err instanceof Error ? err.message : 'Unbekannter Fehler.', 'bad');
    });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * One place for every call to /api/push/*, because they all deal with the
   * optional passphrase the same way: attach it if we have it, and surface the
   * "you need one" / "that one was wrong" answers as a form rather than an error.
   *
   * Returns null when the passphrase form has been raised instead — the caller
   * stops there, and submitting the form starts the whole thing again.
   */
  const post = useCallback(
    async (path: string, body: unknown): Promise<Response | null> => {
      const saved = localStorage.getItem(PASSPHRASE_STORAGE);
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(saved ? { 'x-push-passphrase': saved } : {}),
        },
        body: JSON.stringify(body),
      });

      if (res.status === 401) {
        const data = await res.json().catch(() => ({}));
        if (data?.error === 'wrong') {
          localStorage.removeItem(PASSPHRASE_STORAGE);
          say('Passwort falsch. Bitte erneut eingeben.', 'bad');
        } else {
          say('Dieses Gerät braucht das Push-Passwort.', 'idle');
        }
        setAskingPassphrase(true);
        return null;
      }
      return res;
    },
    [say],
  );

  const subscribe = useCallback(async () => {
    if (!VAPID_PUBLIC_KEY) {
      say('NEXT_PUBLIC_VAPID_PUBLIC_KEY fehlt in dieser Installation.', 'bad');
      return;
    }
    setBusy(true);
    say('Frage Berechtigung an …', 'working');

    try {
      // Must happen inside the gesture: iOS ignores a request made on load, and
      // this is the only chance — a denial here is permanent.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStage('denied');
        say('Berechtigung abgelehnt.', 'bad');
        return;
      }

      const registration = await activeRegistration();
      const sub =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          // Required, and on iOS the only allowed value: every push shows a
          // notification. Fine here — there is exactly one a day.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        }));

      const res = await post('/api/push/subscribe', sub.toJSON());
      if (!res) return; // waiting on the passphrase
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Fehler (${res.status}).`);
      }

      setStage('on');
      say('Aktiv. Das Briefing meldet sich morgen früh.', 'good');
    } catch (err) {
      say(err instanceof Error ? err.message : 'Unbekannter Fehler.', 'bad');
    } finally {
      setBusy(false);
    }
  }, [post, say]);

  async function unsubscribe() {
    if (busy) return;
    setBusy(true);
    say('Wird deaktiviert …', 'working');
    try {
      const registration = await activeRegistration();
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        // Tell the server first: a row that survives a failed unsubscribe keeps
        // the phone buzzing, which is the worse of the two half-states.
        const res = await post('/api/push/unsubscribe', { endpoint: sub.endpoint });
        if (!res) return;
        await sub.unsubscribe();
      }
      setStage('off');
      say('Benachrichtigungen aus.', 'idle');
    } catch (err) {
      say(err instanceof Error ? err.message : 'Unbekannter Fehler.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    if (busy) return;
    setBusy(true);
    say('Test wird gesendet …', 'working');
    try {
      const registration = await activeRegistration();
      const sub = await registration.pushManager.getSubscription();
      if (!sub) {
        setStage('off');
        throw new Error('Keine Anmeldung auf diesem Gerät gefunden.');
      }

      const res = await post('/api/push/test', sub.toJSON());
      if (!res) return;

      if (res.status === 410) {
        // The subscription had silently expired — the server has just deleted
        // the row, so the honest thing is to reset the toggle and say so.
        await sub.unsubscribe().catch(() => {});
        setStage('off');
        say('Die Anmeldung war abgelaufen. Bitte erneut aktivieren.', 'bad');
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `Fehler (${res.status}).`);
      }

      say('Gesendet. Sie sollte sofort ankommen.', 'good');
    } catch (err) {
      say(err instanceof Error ? err.message : 'Unbekannter Fehler.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  function submitPassphrase(e: React.FormEvent) {
    e.preventDefault();
    const value = passInput.trim();
    if (!value) return;
    localStorage.setItem(PASSPHRASE_STORAGE, value);
    setPassInput('');
    setAskingPassphrase(false);
    // Whatever raised the form, re-running subscribe is the right recovery: it
    // is idempotent, and it is what the user was after in the first place.
    void subscribe();
  }

  return (
    <div className="push-toggle">
      {stage === 'loading' && <p className="push-note">Wird geprüft …</p>}

      {stage === 'unsupported' && (
        <p className="push-note">
          Dieser Browser kann keine Web-Benachrichtigungen. Auf dem iPhone braucht
          es iOS 16.4 oder neuer.
        </p>
      )}

      {stage === 'install' && (
        <p className="push-note">
          Benachrichtigungen gibt es nur in der installierten App. In Safari:{' '}
          <strong>Teilen → Zum Home-Bildschirm</strong>, dann die App vom
          Home-Bildschirm öffnen und hier zurückkommen.
        </p>
      )}

      {stage === 'denied' && (
        <p className="push-note">
          Benachrichtigungen wurden für diese App abgelehnt. iOS fragt kein
          zweites Mal — dafür die App vom Home-Bildschirm löschen, erneut
          hinzufügen und die Berechtigung dann erteilen.
        </p>
      )}

      {stage === 'off' && !askingPassphrase && (
        <>
          <p className="push-note">
            Eine Benachrichtigung pro Tag, sobald das Briefing fertig ist (gegen
            5 Uhr morgens). Tippen öffnet direkt die Artikel des Tages.
          </p>
          <button type="button" onClick={() => void subscribe()} disabled={busy}>
            {busy ? 'Einen Moment …' : 'Benachrichtigungen aktivieren'}
          </button>
        </>
      )}

      {stage === 'on' && !askingPassphrase && (
        <>
          <p className="push-note">
            <strong>Aktiv</strong> auf diesem Gerät.
          </p>
          <div className="push-row">
            <button type="button" onClick={sendTest} disabled={busy}>
              Test-Benachrichtigung
            </button>
            <button type="button" className="link" onClick={unsubscribe} disabled={busy}>
              Deaktivieren
            </button>
          </div>
        </>
      )}

      {askingPassphrase && (
        <form onSubmit={submitPassphrase} className="push-form">
          <label htmlFor="push-passphrase">Push-Passwort</label>
          <input
            id="push-passphrase"
            type="password"
            autoComplete="off"
            value={passInput}
            onChange={(e) => setPassInput(e.target.value)}
            placeholder="Passwort eingeben"
          />
          <div className="push-row">
            <button type="submit">Speichern &amp; aktivieren</button>
            <button type="button" className="link" onClick={() => setAskingPassphrase(false)}>
              Abbrechen
            </button>
          </div>
          <p className="push-note">Wird nur in diesem Browser gespeichert.</p>
        </form>
      )}

      {message && (
        <p className={`push-status ${tone}`} role="status" aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}
