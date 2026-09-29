import type { NextConfig } from 'next';

const config: NextConfig = {
  // The agent and MCP services are separate processes; the web build only needs app/ and lib/.
  typescript: { ignoreBuildErrors: false },
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      // The microphone is the one powerful feature this page uses, and only on itself.
      { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=()' },
    ] }];
  },
};
export default config;
