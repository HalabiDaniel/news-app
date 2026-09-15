'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// In standalone mode there is no browser chrome and no back button, so this bar
// is the app's entire navigation. It is fixed, it marks the current route, and
// every target is 44px tall.
const LINKS = [
  { href: '/', label: 'Heute' },
  { href: '/archiv', label: 'Archiv' },
  { href: '/vokabeln', label: 'Vokabeln' },
  { href: '/einstellungen', label: 'Einstellungen' },
];

export default function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="site-header">
      <nav aria-label="Hauptnavigation">
        {LINKS.map(({ href, label }) => {
          // "/" only matches itself; every other entry also owns its subtree,
          // so a day inside the archive still highlights "Archiv".
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
          return (
            <Link key={href} href={href} aria-current={active ? 'page' : undefined}>
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
