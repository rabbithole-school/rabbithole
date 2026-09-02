const fs = require("node:fs");
const path = require("node:path");
const {
  withAppDelegate,
  withDangerousMod,
  withInfoPlist,
} = require("expo/config-plugins");

const APP_DELEGATE_METHOD = `
  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    RNExternalAppDelegateUtil.application(
      application,
      configurationForConnecting: connectingSceneSession,
      options: options,
      sceneOptions: ["headless": false]
    )
  }
`;

function addSceneConfiguration(contents) {
  if (contents.includes("configurationForConnecting connectingSceneSession")) {
    return contents;
  }

  const anchor = "\n}\n\nclass ReactNativeDelegate";
  if (!contents.includes(anchor)) {
    throw new Error(
      "withExternalDisplay: could not find the AppDelegate class boundary",
    );
  }
  return contents.replace(anchor, `${APP_DELEGATE_METHOD}${anchor}`);
}

function addSceneManifest(manifest) {
  return {
    ...manifest,
    UIApplicationSupportsMultipleScenes: true,
  };
}

function addExternalDisplayBridge(contents) {
  const header = "#import <RNExternalDisplay/RNExternalDisplayUtils.h>";
  if (contents.includes(header)) return contents;
  return `${contents.trimEnd()}\n${header}\n`;
}

function withExternalDisplay(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = addSceneManifest(
      cfg.modResults.UIApplicationSceneManifest,
    );
    cfg.modResults.UIRequiresFullScreen = false;
    return cfg;
  });

  config = withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== "swift") {
      throw new Error("withExternalDisplay: expected a Swift AppDelegate");
    }
    cfg.modResults.contents = addSceneConfiguration(cfg.modResults.contents);
    return cfg;
  });

  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const projectName = cfg.modRequest.projectName;
      const headerPath = path.join(
        cfg.modRequest.platformProjectRoot,
        projectName,
        `${projectName}-Bridging-Header.h`,
      );
      const contents = fs.readFileSync(headerPath, "utf8");
      fs.writeFileSync(headerPath, addExternalDisplayBridge(contents));
      return cfg;
    },
  ]);
}

module.exports = withExternalDisplay;
module.exports.addExternalDisplayBridge = addExternalDisplayBridge;
module.exports.addSceneConfiguration = addSceneConfiguration;
module.exports.addSceneManifest = addSceneManifest;
