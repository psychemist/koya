import type { NextConfig } from "next";

/**
 * Security headers are set here rather than in vercel.json so they apply in
 * `next dev` too — a CSP that only exists in production is a CSP you find out
 * about during the demo.
 *
 * `script-src 'unsafe-inline'` is required by Next's inline bootstrap and
 * hydration payload. Everything that could carry a third-party payload —
 * frames, objects, form targets, base URIs — is denied outright instead.
 *
 * THE 'unsafe-eval' EXCEPTION, AND WHY IT IS DEVELOPMENT-ONLY.
 *
 * Next's development server compiles modules through `eval` for hot module
 * replacement and source maps. Without 'unsafe-eval' the browser blocks that
 * outright, and the consequence is not a warning in the console — React never
 * hydrates, so every interactive component in the application is inert. The
 * page still renders, because the server-rendered HTML is fine, which is
 * exactly what makes the failure so easy to miss: it looks completely normal
 * until you click something.
 *
 * That is how it was missed here. The pages were being checked with `curl`,
 * which only ever sees the server-rendered markup, and a screenshot was what
 * finally showed a control that could not be selected.
 *
 * Production builds do not use `eval`, so the directive is omitted there and
 * the deployed CSP is the strict one. Two lessons encoded in one condition:
 * verify interactivity in a real browser, and never widen a production policy
 * to fix a development-only problem.
 */
const isDev = process.env.NODE_ENV !== "production";

const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const csp = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  // Development also needs a websocket back to the dev server for HMR.
  isDev ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Uploads are capped well below this in code; the ceiling is a second line
    // of defence so a large body cannot reach a route handler at all.
    serverActions: { bodySizeLimit: "12mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
