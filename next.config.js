/** @type {import("next").NextConfig} */
const nextConfig = {
  reactCompiler: {
    compilationMode: "infer",
    panicThreshold: "none",
  },
  turbopack: {
    root: __dirname,
  },
  async redirects() {
    return [
      {
        source: "/scholar/meta",
        destination: "/scholar",
        permanent: true,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/oauth/metadata/authorization-server",
      },
      {
        source: "/.well-known/oauth-authorization-server/:path*",
        destination: "/api/oauth/metadata/authorization-server",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/oauth/metadata/protected-resource",
      },
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: "/api/oauth/metadata/protected-resource",
      },
    ];
  },
  experimental: {
    optimizePackageImports: ["@chakra-ui/react"],
  },
};

module.exports = nextConfig;
