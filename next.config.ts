import type { NextConfig } from "next";

const dev = process.env.NODE_ENV !== "production";

/**
 * Content Security Policy, sent as Report-Only for now: the browser logs what it would block
 * and blocks nothing. Next.js starts each page with inline scripts and the pages set inline
 * styles, so both still need 'unsafe-inline'; enforcing the policy waits until those carry a
 * nonce. Framing is refused by X-Frame-Options below, which is enforced today.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Sent with every response. */
export const securityHeaders = [
  // No other site may put Settle in a frame, so nobody can be tricked into clicking through one.
  { key: "X-Frame-Options", value: "DENY" },
  // A plan's address contains its invite code; do not hand it to other sites in the Referer header.
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Content-Security-Policy-Report-Only", value: csp },
];

const nextConfig: NextConfig = {
  // Database drivers load files at runtime (PGlite's WebAssembly); keep them out of the bundle.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  // Do not advertise the framework.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
