'use client';

import { useEffect } from 'react';

/**
 * Registers /sw.js once, on every page.
 *
 * It sits in the layout rather than inside the push toggle on purpose: a
 * notification tapped days later is handled by the *worker*, not by the page
 * that subscribed, so the worker has to be installed and current regardless of
 * whether anyone visits the settings page. Registering early also means the
 * subscribe button doesn't have to wait for an install when it is pressed —
 * iOS's permission prompt is one-shot, and a button that stalls invites a
 * second tap.
 *
 * Renders nothing. Failures are logged and ignored: push is the only thing that
 * depends on the worker, and the site reads fine without it.
 */
export default function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sw] registration failed', err);
    });
  }, []);

  return null;
}
