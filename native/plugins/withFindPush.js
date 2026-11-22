// withFindPush — the entitlements "Find my BunnyPad" needs (convex/bunnypadFind.ts).
//
//   aps-environment  production for the Ad Hoc channel builds (stable, canary),
//                    development for the metro dev client, whose development
//                    profile carries the sandbox value. A mismatch with the
//                    provisioning profile fails signing. It keys on the final
//                    bundle id, by the same rule as src/lib/findPush.ts, so the
//                    entitlement and the token's reported environment can't drift.
//   time-sensitive   lets a find notification break through Focus.
//
// Set here rather than with expo-notifications' `mode` option because that
// option is one value for every build. expo-notifications leaves an existing
// aps-environment alone, so this wins whatever order the mods run in.
//
// The App ID needs the Push Notifications and Time Sensitive Notifications
// capabilities, and the Ad Hoc profile regenerated after they're enabled.
const { withEntitlementsPlist } = require("expo/config-plugins");

module.exports = function withFindPush(config) {
  return withEntitlementsPlist(config, (cfg) => {
    const bundleId = cfg.ios?.bundleIdentifier ?? "";
    cfg.modResults["aps-environment"] = bundleId.endsWith(".metro")
      ? "development"
      : "production";
    cfg.modResults["com.apple.developer.usernotifications.time-sensitive"] = true;
    return cfg;
  });
};
