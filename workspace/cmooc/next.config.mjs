/** @type {import('next').NextConfig} */
const requestedDistDir = process.env.CMOOC_NEXT_DIST_DIR;
const distDir = requestedDistDir && /^\.next-stale-[a-z0-9-]+$/.test(requestedDistDir)
  ? requestedDistDir
  : ".next";

const nextConfig = {
  distDir,
  experimental: {
    serverActions: {
      allowedOrigins: ["localhost:3000","127.0.0.1:3000","localhost:3017","127.0.0.1:3017","localhost:3018","127.0.0.1:3018"]
    }
  }
};

export default nextConfig;
