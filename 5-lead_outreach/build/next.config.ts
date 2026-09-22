import type { NextConfig } from 'next';

/**
 * The web service holds no Agent SDK dependency and no provider key. Keeping
 * the SDK out of this bundle is what lets the worker die without taking the
 * shareable link down with it.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ['pg'],
};

export default nextConfig;
