const path = require("node:path");
const {
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require("expo/config-plugins");

// withBunnyDrive — the File Provider extension behind the Bunny Drive location
// in Files. `expo prebuild` regenerates native/ios, so the target has to be
// added here, for every variant. The target points straight at the sources in
// native/extensions/bunny-drive, so an existing ios/ can't hold a stale copy.
// They read their per-variant values from the build settings below, and those
// come from the ONE variant table.
//
// Prebuild runs without --clean over an existing ios/ too (ipad:build, and
// native:build when the identity changes), so this must be safe to run twice:
// an existing target keeps its uuid and only has its settings rewritten.
//
// The variant comes from the resolved bundle id, not RH_VARIANT: a release
// build writes its identity into app.json and leaves RH_VARIANT unset.
const {
  APPLE_TEAM_ID,
  BUNNY_DRIVE_TARGET,
  bunnyDriveIdentity,
  VARIANTS,
} = require(path.join(__dirname, "..", "..", "scripts", "lib", "ipadRelease.mjs"));

// Relative to native/ios, where the Xcode project lives.
const SOURCE_DIR = "../extensions/bunny-drive";
const SWIFT_FILE = "FileProviderExtension.swift";
const FILES = [SWIFT_FILE, "Info.plist", "BunnyDrive.entitlements"];

function identityFor(config) {
  const bundleId = config.ios?.bundleIdentifier;
  const variant = Object.values(VARIANTS).find((v) => v.bundleId === bundleId);
  if (!variant) {
    throw new Error(
      `withBunnyDrive: bundle id "${bundleId}" is not in the variant table ` +
        "(scripts/lib/ipadRelease.mjs), so it has no extension identity.",
    );
  }
  return bunnyDriveIdentity(variant);
}

function buildSettings(config, identity) {
  return {
    BUNNY_DRIVE_APP_GROUP: identity.appGroup,
    BUNNY_DRIVE_KEYCHAIN_GROUP: identity.keychainGroup,
    CODE_SIGN_ENTITLEMENTS: `${SOURCE_DIR}/BunnyDrive.entitlements`,
    CODE_SIGN_STYLE: "Automatic",
    CURRENT_PROJECT_VERSION: `"${config.ios?.buildNumber ?? "1"}"`,
    DEVELOPMENT_TEAM: process.env.NATIVE_DEV_TEAM || APPLE_TEAM_ID,
    INFOPLIST_FILE: `${SOURCE_DIR}/Info.plist`,
    IPHONEOS_DEPLOYMENT_TARGET: "16.4",
    LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
    MARKETING_VERSION: config.version,
    PRODUCT_BUNDLE_IDENTIFIER: identity.bundleId,
    PRODUCT_NAME: `"$(TARGET_NAME)"`,
    SKIP_INSTALL: "YES",
    SWIFT_VERSION: "5.0",
    TARGETED_DEVICE_FAMILY: '"2"',
  };
}

// The xcode package stores names it writes with their quotes, so its own
// findTargetKey misses a target that addTarget created.
function findTarget(project) {
  const targets = Object.entries(project.pbxNativeTargetSection());
  const match = targets.find(([, t]) => t?.name?.replace(/"/g, "") === BUNNY_DRIVE_TARGET);
  return match?.[0];
}

function addTarget(project, bundleId) {
  // Expo's template has no dependent targets, and the xcode package assumes
  // these two sections exist.
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};

  const target = project.addTarget(BUNNY_DRIVE_TARGET, "app_extension", BUNNY_DRIVE_TARGET, bundleId);
  project.addBuildPhase([SWIFT_FILE], "PBXSourcesBuildPhase", "Sources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);

  const group = project.addPbxGroup(FILES, BUNNY_DRIVE_TARGET, `"${SOURCE_DIR}"`);
  const mainGroup = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(group.uuid, mainGroup);
  return target.uuid;
}

function applySettings(project, targetUuid, settings) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  const list = project.pbxXCConfigurationList()[target.buildConfigurationList];
  const configs = project.pbxXCBuildConfigurationSection();
  for (const { value } of list.buildConfigurations) {
    Object.assign(configs[value].buildSettings, settings);
  }
}

module.exports = function withBunnyDrive(config) {
  const identity = identityFor(config);

  // Where the app leaves the extension its read grant. The extension's Info.plist
  // has the same key, so both name one group.
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.BunnyDriveKeychainGroup = `$(AppIdentifierPrefix)${identity.keychainGroup}`;
    cfg.modResults.BunnyDriveAppGroup = identity.appGroup;
    return cfg;
  });

  // The app's own group stays FIRST. iOS writes an item with no explicit group
  // to the first one, so the session stays exactly where it is today; moving it
  // is a migration of its own, with its own canary run.
  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults["com.apple.security.application-groups"] = [identity.appGroup];
    cfg.modResults["keychain-access-groups"] = [
      `$(AppIdentifierPrefix)${cfg.ios.bundleIdentifier}`,
      `$(AppIdentifierPrefix)${identity.keychainGroup}`,
    ];
    return cfg;
  });

  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const uuid = findTarget(project) ?? addTarget(project, identity.bundleId);
    applySettings(project, uuid, buildSettings(cfg, identity));
    return cfg;
  });
};
