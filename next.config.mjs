/** @type {import('next').NextConfig} */
const nextConfig = {
  // ESLint is not configured in this project; don't let it block `next build`.
  eslint: { ignoreDuringBuilds: true },

  // The archive moved to a German route in Phase 4 (`/archiv`), because a
  // German interface on English paths was always slightly odd. Old links —
  // notably the ones in email briefings sent before the cutover — keep working.
  async redirects() {
    return [
      { source: '/archive', destination: '/archiv', permanent: true },
      { source: '/archive/:date', destination: '/archiv/:date', permanent: true },
    ];
  },
};

export default nextConfig;
