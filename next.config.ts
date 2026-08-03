import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Self-contained HTTP integration tests run a real Next.js server. Give
  // them an isolated build directory so they can run while a developer keeps
  // the normal `.next` dev server open.
  distDir: process.env.NYXDOC_NEXT_DIST_DIR || ".next",
  // Local qualification may bind the browser to the loopback address while
  // Next reports localhost as its development origin. Keep both loopback
  // spellings on the same trusted development boundary.
  allowedDevOrigins: ["127.0.0.1"],
  typescript: {
    tsconfigPath: process.env.NYXDOC_TSCONFIG_PATH || "tsconfig.json",
  },
  poweredByHeader: false,
  // Keep one process-wide Yjs constructor on the Node side. The collaboration
  // server and the SSR copy of the editor otherwise resolve different module
  // conditions (CJS/ESM), which triggers Yjs' duplicate-import guard.
  serverExternalPackages: ["better-sqlite3", "yjs"],
  async headers() {
    return [
      {
        source: "/s/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Accel-Buffering", value: "no" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
