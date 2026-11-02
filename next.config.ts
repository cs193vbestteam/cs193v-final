import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @libsql/client ships native bindings; keep it out of the server bundle.
  serverExternalPackages: ["@libsql/client"],
};

export default nextConfig;
