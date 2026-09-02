import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { devServerUrlFromHostUri } from "../devClientSafety";

describe("devServerUrlFromHostUri", () => {
  it("normalizes Expo hostUri values to the registry URL", () => {
    expect(devServerUrlFromHostUri("169.254.12.8:8417")).toBe(
      "http://169.254.12.8:8417",
    );
    expect(devServerUrlFromHostUri("http://192.168.4.20:8417/path")).toBe(
      "http://192.168.4.20:8417",
    );
  });

  it("rejects empty, malformed, and non-network values", () => {
    expect(devServerUrlFromHostUri(null)).toBeNull();
    expect(devServerUrlFromHostUri("not a host")).toBeNull();
    expect(devServerUrlFromHostUri("file:///tmp/bundle.js")).toBeNull();
  });
});

describe("DevClientSafety native guard", () => {
  it("keeps only the live bundle's server instead of selecting a different registered server", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../../../modules/dev-client-safety/ios/DevClientSafetyModule.swift",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(source).toContain("self.probeMetro(preferredUrl)");
    expect(source).toContain("defaults.set([preferredUrl: current]");
    expect(source).not.toContain("recentApps.max");
    expect(source).not.toContain("recentApps.values.first");
  });

  it("records an Expo-compatible entry when a localhost picker load reports 127.0.0.1", () => {
    const source = readFileSync(
      fileURLToPath(
        new URL(
          "../../../modules/dev-client-safety/ios/DevClientSafetyModule.swift",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(source).toContain("private func registryEntry(for serverUrl: String)");
    expect(source).toContain('"timestamp": Int64(Date().timeIntervalSince1970 * 1_000)');
    expect(source).toContain('"url": serverUrl');
    expect(source).toContain(
      "recentApps[preferredUrl] ?? self.registryEntry(for: preferredUrl)",
    );
  });
});
