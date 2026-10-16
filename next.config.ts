import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  experimental: {
    proxyClientMaxBodySize: 500 * 1024 * 1024,
  },
};

export default withWorkflow(nextConfig);
