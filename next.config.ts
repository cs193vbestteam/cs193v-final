import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Database drivers load files at runtime (PGlite's WebAssembly); keep them out of the bundle.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default nextConfig;
