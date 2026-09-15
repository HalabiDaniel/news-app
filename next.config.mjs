/** @type {import('next').NextConfig} */
const nextConfig = {
  // ESLint is not configured in this project; don't let it block `next build`.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
