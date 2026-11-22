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
  it("hashes UTF-8 source identically to the manifest generator", async () => {
    for (const source of ["", "abc", "Rabbithole graph: x² + 你好"]) {
      expect(await sha256Hex(source)).toBe(
        createHash("sha256").update(source).digest("hex"),
      );
    }
  });

  it("yields between slices of a large source without changing the digest", async () => {
    // ~200 KB spans several 32 KiB slices, with a multi-byte character straddling
    // slice edges somewhere along the way.
    const source = "p5 sketch: ∑ θ 🐇\n".repeat(10_000);
    let yields = 0;
    const digest = await sha256Hex(source, async () => {
      yields += 1;
    });
    expect(digest).toBe(createHash("sha256").update(source).digest("hex"));
    expect(yields).toBeGreaterThanOrEqual(3);
  });

  it("keeps every renamed native asset byte-identical to its manifest", async () => {
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

      await expect(
        assertAppKitSourceIntegrity(
          file,
          source,
          manifest.libraries[file].sha256,
        ),
      ).resolves.toBeUndefined();
    }
  });

  it("fails closed when a bundled source does not match its manifest", async () => {
    await expect(
      assertAppKitSourceIntegrity("katex.min.js", "tampered", "0".repeat(64)),
    ).rejects.toThrow(/integrity mismatch/);
  });
});
