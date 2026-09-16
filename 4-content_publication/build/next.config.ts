import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Server Actions and route handlers do every model, scrape and publish call.
  // Nothing that touches a credential is allowed to reach the browser bundle.
  serverExternalPackages: ['pg'],
  poweredByHeader: false,
};

export default nextConfig;
