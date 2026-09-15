import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Deutsch B2 Briefing',
  description: 'Tägliches deutsches Nachrichten-Briefing auf CEFR-B2-Niveau.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
