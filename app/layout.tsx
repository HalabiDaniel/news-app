import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import ServiceWorker from '@/components/ServiceWorker';
import SiteHeader from '@/components/SiteHeader';
import './globals.css';

export const metadata: Metadata = {
  title: 'Deutsch B2 Briefing',
  description: 'Tägliches deutsches Nachrichten-Briefing auf CEFR-B2-Niveau.',
  // `capable` is what makes iOS launch the home-screen icon without browser
  // chrome; the title is what appears under the icon, and it wins over the
  // manifest's short_name on iOS.
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'B2 Briefing' },
  // iOS ignores the manifest icons for the home screen and reads this instead.
  // It must be opaque — transparency renders as black (see scripts/generate-icons.mjs).
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  manifest: '/manifest.webmanifest',
  // Next renders `appleWebApp.capable` as the modern `mobile-web-app-capable`,
  // which Safari only started honouring in 17.4. iOS 16.4 to 17.3 still needs
  // the legacy spelling, and those are exactly the versions where push is new
  // enough to be the reason someone is reading this file. Harmless duplication.
  other: { 'apple-mobile-web-app-capable': 'yes' },
};

export const viewport: Viewport = {
  // `viewport-fit=cover` is what lets the page paint into the notch and the
  // home-indicator area; the layout then pads itself back out with
  // env(safe-area-inset-*) in globals.css. Without it iOS letterboxes the page
  // in standalone mode and the design loses its edges.
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
  // Both themes are declared so iOS tints the status bar to match whichever the
  // system is in, rather than leaving a white strip above a dark page.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfaf7' },
    { media: '(prefers-color-scheme: dark)', color: '#14130f' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>
        <SiteHeader />
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
