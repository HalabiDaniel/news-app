/*
 * The service worker. Plain JS, no build step, served from the root so its
 * scope covers the whole site.
 *
 * It does exactly two things: show the morning notification, and open the
 * briefing when it is tapped.
 *
 * It deliberately does NOT cache anything. A service worker that caches HTML is
 * the classic way to serve yesterday's briefing forever, and this app's entire
 * point is that the content changed overnight. If offline reading is ever
 * wanted, it is a separate piece of work with its own versioning strategy.
 */

// Take over as soon as a new version is installed, rather than waiting for
// every tab to close. In a standalone PWA that moment may never come — iOS
// keeps the app alive for days — so without these two the updated worker would
// sit in "waiting" indefinitely.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  // Defensive parsing: a push event that shows no notification is a spec
  // violation browsers punish by revoking the subscription, so a malformed or
  // empty payload must still produce something visible.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  // waitUntil is mandatory. Without it iOS may kill the worker before the
  // notification is shown and the push silently vanishes.
  event.waitUntil(
    self.registration.showNotification(data.title || 'Dein Briefing ist da', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      lang: 'de',
      data: { url: data.url || '/' },
      // One notification a day, so today's replaces yesterday's instead of
      // stacking into a pile nobody clears.
      tag: data.tag || 'daily-briefing',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Reuse the open app if there is one — launching a second window would
      // lose whatever the reader was in the middle of.
      for (const client of list) {
        if ('focus' in client) {
          if ('navigate' in client && new URL(client.url).pathname !== url) {
            return client.navigate(url).then((c) => (c ? c.focus() : undefined));
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
