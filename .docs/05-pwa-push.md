# Phase 5 — PWA and push notifications

Replace the email with a home-screen app that buzzes when the briefing lands.

**Done when:** the phone gets a notification each morning, tapping it opens
that day's briefing, and this works for a week without re-granting anything.

---

## 5.1 Read this before estimating the phase

iOS web push works, but Apple's constraints are unusual and most web-push
tutorials ignore them. Getting these wrong produces a feature that appears to
work in Chrome on a laptop and silently does nothing on the actual phone.

1. **iOS 16.4+ only.** Confirm the phone's version first.
2. **Home Screen only.** Push does **not** work for a site open in a Safari
   tab. The app must be added via Share → Add to Home Screen, and notifications
   only arrive for the standalone instance. This is the whole reason the PWA
   half of this phase exists.
3. **The manifest must declare `display: standalone`** (or `fullscreen`), or
   iOS won't treat it as a web app and push won't be offered.
4. **Permission must be requested from a real user gesture** — inside a tap
   handler. Calling `Notification.requestPermission()` on page load is silently
   ignored on iOS. It needs a button the user presses.
5. **Permission can only be asked once.** If the user denies it, the prompt
   never appears again; the only recovery is deleting the home-screen app and
   re-adding it. Make the button explain what it does *before* it's pressed.
6. **Subscriptions die.** Deleting and re-adding the PWA, and sometimes an iOS
   update, invalidates the subscription. The server finds out only by getting
   `404`/`410` when it tries to push. There is no event. This is why a test
   button (5.6) is not a nice-to-have.
7. **No silent push, no badge counts** without extra work. Every push shows a
   notification. That's fine — we send exactly one a day.

Budget time for device testing. This cannot be verified in a desktop browser.

## 5.2 The manifest

`app/manifest.ts` (Next.js metadata route, served at `/manifest.webmanifest`):

```ts
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Deutsch B2 Briefing',
    short_name: 'B2 Briefing',      // iOS shows ~12 chars under the icon
    start_url: '/',
    display: 'standalone',           // required for iOS push
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
```

Plus, in `app/layout.tsx`:

```ts
export const metadata: Metadata = {
  title: 'Deutsch B2 Briefing',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'B2 Briefing' },
};

export const viewport: Viewport = {
  viewportFit: 'cover',            // pairs with the safe-area padding in Phase 4
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111111' },
  ],
};
```

Icons needed in `public/`: `icon-192.png`, `icon-512.png`,
`icon-maskable-512.png`, and **`apple-touch-icon.png` at 180×180**. iOS reads
the last one for the home-screen icon and it must be opaque — transparency
renders as black.

## 5.3 VAPID keys

Generate once:

```bash
npx web-push generate-vapid-keys
```

| Key | Where it goes |
|---|---|
| Public | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (Vercel) and `VAPID_PUBLIC_KEY` (Actions secret) |
| Private | `VAPID_PRIVATE_KEY` — **Actions secret only**. Never `NEXT_PUBLIC_`, never in Vercel unless a route sends push |
| Subject | `VAPID_SUBJECT`, a `mailto:` or an https URL. Required by the spec |

The public key reaching the browser is correct and by design.

**If you regenerate the keys, every existing subscription breaks** and every
device must re-subscribe. Generate once, store carefully.

## 5.4 The service worker

`public/sw.js` — plain JS, served from the root so its scope covers the site.
Not a module, no build step.

```js
self.addEventListener('push', (event) => {
  const data = (() => { try { return event.data.json(); } catch { return {}; } })();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Dein Briefing ist da', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      data: { url: data.url || '/' },
      tag: 'daily-briefing',      // one a day replaces the last, never stacks
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(url) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    }),
  );
});
```

Notes:

- **`event.waitUntil` is mandatory** in both handlers. Without it iOS may kill
  the worker before the notification is shown, and the push silently vanishes.
- **Defensive JSON parsing.** A malformed payload must still produce a
  notification — a push event that shows nothing is a spec violation some
  browsers punish by revoking the subscription.
- **`tag`** makes today's notification replace yesterday's rather than piling up.

Keep it minimal. **Do not add offline caching in this phase.** A service worker
that caches HTML is the classic way to serve a stale briefing forever; if
offline reading is wanted, it's a separate piece of work with its own
versioning strategy.

## 5.5 Subscribing

A `PushToggle` client component, on a `/einstellungen` page (and prompted once
from the home page if not yet subscribed).

Flow:

1. **Detect standalone.** `window.matchMedia('(display-mode: standalone)')`, or
   `navigator.standalone` on iOS. If the site is in a Safari tab on iOS, don't
   show a broken button — show the instruction: *Teilen → Zum Home-Bildschirm.*
   This is the step everyone gets stuck on.
2. **Explain, then ask.** One line about what arrives and when, then a button.
   Remember: one shot at the permission prompt.
3. On tap: `Notification.requestPermission()` →
   `registration.pushManager.subscribe({ userVisibleOnly: true,
   applicationServerKey: <public key, base64url → Uint8Array> })`.
4. `POST /api/push/subscribe` with the subscription JSON.
5. Show current state — subscribed or not, and a test button.

### `POST /api/push/subscribe`

Upsert on `endpoint` so re-subscribing updates rather than duplicates:

```ts
await supabase.from('push_subscriptions').upsert({
  endpoint: sub.endpoint,
  p256dh: sub.keys.p256dh,
  auth: sub.keys.auth,
  user_agent: request.headers.get('user-agent')?.slice(0, 200) ?? null,
}, { onConflict: 'endpoint' });
```

**This endpoint is publicly reachable on a public site.** It writes to the
database on an unauthenticated POST. Protect it:

- Validate shape strictly: `endpoint` must be `https:`, both keys present and
  plausibly sized. Reject anything else with a 400.
- Cap the table — if `count(*) > 50`, refuse. This is a personal app; fifty
  devices is already absurd and the cap turns unbounded growth into a
  contained failure.
- Consider requiring a shared passphrase. Slightly annoying once per device,
  and it closes the endpoint completely. Recommended given there is exactly one
  intended user.

Also `POST /api/push/unsubscribe` (delete by endpoint) so the toggle turns off.

## 5.6 The test button

Non-negotiable. `POST /api/push/test` sends a push to the calling subscription
immediately.

Without it, verifying push means waiting until tomorrow morning, and when
nothing arrives you can't tell whether the subscription died, the send failed,
or iOS swallowed it. With it, checking takes two seconds.

Put it on the settings page permanently, not just during development. It is how
you'll answer "did I stop getting these because it broke, or because there was
no briefing?" — which is the exact question Phase 3.5 says will come up.

## 5.7 Sending from the daily run

`lib/push.ts`, called by `scripts/run-briefing.ts` after `onPersisted`
(Phase 2.3).

Order matters: **articles are written and the site cache is revalidated before
the push goes out.** Notifying first means tapping it lands on a page that
hasn't updated yet — the exact failure the `revalidate` ping exists to prevent.

```ts
import webpush from 'web-push';

export async function sendBriefingPush(date: string, count: number): Promise<number> {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, SITE_URL } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('[push] VAPID keys not set — skipping notifications.');
    return 0;
  }
  webpush.setVapidDetails(VAPID_SUBJECT ?? 'mailto:info@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const supabase = getSupabaseAdmin();
  const { data: subs } = await supabase.from('push_subscriptions').select('*');

  const payload = JSON.stringify({
    title: 'Dein Briefing ist da',
    body: `${count} neue Artikel – ${formatDisplayDate(date)}`,
    url: '/',
  });

  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      );
      sent++;
      await supabase.from('push_subscriptions')
        .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
        .eq('endpoint', s.endpoint);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Gone for good — the only signal a subscription is dead.
        await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        console.warn(`[push] dropped expired subscription (${status}).`);
      } else {
        await supabase.rpc('increment_push_failure', { ep: s.endpoint }).catch(() => {});
        console.warn(`[push] send failed (${status ?? 'unknown'}).`);
      }
    }
  }
  return sent;
}
```

Non-negotiables in that code:

- **`404`/`410` must delete the row.** It is the only way a dead subscription
  is ever cleaned up, and without it the table fills with endpoints that fail
  every morning forever.
- **Push failure must never fail the run.** The briefing is written and on the
  website; a notification problem is not a reason to mark the day failed. Wrap
  the whole call at the caller and log loudly.
- **Write the count to `briefing_runs.push_sent`.** When no notification
  arrives, that number is the first thing you'll want: `0` means no live
  subscriptions, `1` means it was sent and lost downstream.

## 5.8 Testing on the actual device

In order — each step fails differently:

1. Deploy. Open the site **in Safari on the iPhone**.
2. Share → **Add to Home Screen**. Close Safari.
3. Open from the home screen. Confirm no browser chrome (that's standalone).
4. Settings → enable notifications → **grant**.
5. **Test push.** It should arrive within seconds. If not, stop here — nothing
   downstream will work.
6. `workflow_dispatch` the briefing with `force: true`. Confirm the
   notification arrives and tapping it opens today's articles, already present.
7. Leave it overnight. Confirm the scheduled run notifies.
8. A week later, test-push again — this catches silent subscription expiry,
   which is the most likely long-term failure.

## 5.9 Acceptance criteria

- [ ] Installs to the iPhone home screen with the right icon and name
- [ ] Runs standalone with no browser chrome
- [ ] Permission prompt appears from a tap, and only in standalone mode
- [ ] Safari-tab visitors see the "add to home screen" instruction instead
- [ ] Test push arrives within seconds
- [ ] The scheduled run notifies, and the tapped notification opens fresh content
- [ ] `push_sent` recorded on `briefing_runs`
- [ ] Expired subscriptions are deleted on 404/410
- [ ] A push failure does not fail the briefing
- [ ] `VAPID_PRIVATE_KEY` appears in no client bundle (`grep` the build output)
