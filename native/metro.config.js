/* eslint-disable @typescript-eslint/no-require-imports -- Metro loads this config as CommonJS. */
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);
const vendorApi = path.join(projectRoot, "vendor", "convex_generated", "api.js");
const baseResolveRequest = config.resolver.resolveRequest;

config.resolver.nodeModulesPaths = [path.join(projectRoot, "node_modules")];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@convex/api") {
    return { type: "sourceFile", filePath: vendorApi };
  }
  return baseResolveRequest
    ? baseResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
