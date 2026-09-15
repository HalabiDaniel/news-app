import type { MetadataRoute } from 'next';

/**
 * Served at /manifest.webmanifest by Next's metadata route.
 *
 * `display: 'standalone'` is not cosmetic here: iOS only offers web push to a
 * site added to the Home Screen, and it only treats a site as a web app when the
 * manifest asks for standalone (or fullscreen). Without this line the push
 * permission prompt never appears on a phone, however correct everything else is.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Deutsch B2 Briefing',
    // iOS shows roughly 12 characters under the home-screen icon before it
    // truncates, so the short name is written to fit rather than be abbreviated.
    short_name: 'B2 Briefing',
    description: 'Tägliches deutsches Nachrichten-Briefing auf CEFR-B2-Niveau.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    lang: 'de',
    // Matching globals.css: the warm paper the app is painted on, so the launch
    // screen doesn't flash white-blue before the first paint.
    background_color: '#fbfaf7',
    theme_color: '#fbfaf7',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
