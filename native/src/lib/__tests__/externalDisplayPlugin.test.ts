import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  addExternalDisplayBridge,
  addSceneConfiguration,
  addSceneManifest,
}: {
  addExternalDisplayBridge: (contents: string) => string;
  addSceneConfiguration: (contents: string) => string;
  addSceneManifest: (
    manifest: Record<string, unknown> | undefined,
  ) => Record<string, unknown>;
} = require("../../../plugins/withExternalDisplay.js");

describe("withExternalDisplay", () => {
  it("adds the scene configuration method to a Swift AppDelegate once", () => {
    const source = [
      "class AppDelegate: ExpoAppDelegate {",
      "  var window: UIWindow?",
      "}",
      "",
      "class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {",
      "}",
      "",
    ].join("\n");

    const configured = addSceneConfiguration(source);

    expect(configured).toContain(
      "configurationForConnecting connectingSceneSession",
    );
    expect(addSceneConfiguration(configured)).toBe(configured);
  });

  it("adds the Objective-C bridge import once", () => {
    const source = "// Generated bridging header\n";
    const configured = addExternalDisplayBridge(source);

    expect(configured).toContain(
      "#import <RNExternalDisplay/RNExternalDisplayUtils.h>",
    );
    expect(addExternalDisplayBridge(configured)).toBe(configured);
  });

  it("preserves existing scene configuration while enabling multiple scenes", () => {
    const existing = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: "Default Configuration" },
        ],
      },
    };

    expect(addSceneManifest(existing)).toEqual({
      ...existing,
      UIApplicationSupportsMultipleScenes: true,
    });
  });
});
