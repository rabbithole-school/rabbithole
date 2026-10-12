import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  APP_KIT_FILES,
  APP_KIT_V1_FILES,
} from "../../vendor/shared/appKit";
import {
  assertAppKitSourceIntegrity,
  sha256Hex,
} from "./appKitIntegrity";

describe("native app-kit assets", () => {
  it("hashes UTF-8 source identically to the manifest generator", () => {
    for (const source of ["", "abc", "Rabbithole graph: x² + 你好"]) {
      expect(sha256Hex(source)).toBe(
        createHash("sha256").update(source).digest("hex"),
      );
    }
  });

  it("keeps every renamed native asset byte-identical to its manifest", () => {
    for (const file of APP_KIT_FILES) {
      const version = APP_KIT_V1_FILES.includes(
        file as (typeof APP_KIT_V1_FILES)[number],
      )
        ? "v1"
        : "v2";
      const assetDir = path.resolve(
        __dirname,
        `../../assets/app-kit/${version}`,
      );
      const manifest = JSON.parse(
        readFileSync(path.join(assetDir, "manifest.json.kit"), "utf8"),
      ) as { libraries: Record<string, { sha256: string }> };
      const source = readFileSync(path.join(assetDir, `${file}.kit`), "utf8");

      expect(() =>
        assertAppKitSourceIntegrity(
          file,
          source,
          manifest.libraries[file].sha256,
        ),
      ).not.toThrow();
    }
  });

  it("fails closed when a bundled source does not match its manifest", () => {
    expect(() =>
      assertAppKitSourceIntegrity("katex.min.js", "tampered", "0".repeat(64)),
    ).toThrow(/integrity mismatch/);
  });
});
