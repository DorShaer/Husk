import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  distDir: "out",
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: true },
  generateBuildId: () => `build-${Date.now()}`,
};

export default nextConfig;
