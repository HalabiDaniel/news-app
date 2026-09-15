'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/**
 * A single quiet offer, above today's briefing: notifications are available,
 * here is where to turn them on.
 *
 * The settings page is where the real control lives, but nobody visits settings
 * on an app that works — so without this the feature ships invisible. It shows
 * only when all of the following hold, which is roughly "the one moment where
 * the offer is useful and possible":
 *
 *   * running as the installed app (iOS won't subscribe from a Safari tab),
 *   * the permission has never been answered (asking again is a no-op),
 *   * there is no subscription already,
 *   * it hasn't been dismissed before.
 *
 * Dismissal is permanent and local. This must never become a thing that nags:
 * the permission prompt is one-shot, and pestering someone into a reflexive
 * "no" costs them the feature until they delete and re-add the app.
 */
const DISMISSED_STORAGE = 'pushNudgeDismissed';

export default function PushNudge() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
      if (localStorage.getItem(DISMISSED_STORAGE)) return;
      if (Notification.permission !== 'default') return;

      const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
      const standalone = iosStandalone === true || window.matchMedia('(display-mode: standalone)').matches;
      if (!standalone) return;

      const registration = await navigator.serviceWorker.ready;
      if (await registration.pushManager.getSubscription()) return;

      if (!cancelled) setShow(true);
    })().catch(() => {
      /* Not being offered the nudge is not a failure worth reporting. */
    });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  return (
    <aside className="push-nudge">
      <span>
        Morgens eine Benachrichtigung, wenn das Briefing fertig ist?{' '}
        <Link href="/einstellungen">Einschalten</Link>
      </span>
      <button
        type="button"
        aria-label="Hinweis ausblenden"
        onClick={() => {
          localStorage.setItem(DISMISSED_STORAGE, '1');
          setShow(false);
        }}
      >
        ✕
      </button>
    </aside>
  );
}
