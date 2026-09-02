import { describe, expect, test } from "vitest";
import { registrationFeedback, SERIAL_PREVIEW_LIMIT } from "./importFeedback";

describe("managed-device import feedback", () => {
  test("reports a zero-added import as an error, not a success", () => {
    expect(
      registrationFeedback([
        { serial: "REGISTERED01", ok: false, skipped: true },
        { serial: "INVALID001", ok: false },
      ]),
    ).toMatchObject({
      status: "error",
      title: "No devices added",
      description:
        "1 skipped · 1 invalid — REGISTERED01, INVALID001. Review the serials below.",
      added: 0,
    });
  });

  test("names a bounded, deterministic preview of skipped and invalid serials", () => {
    const failures = Array.from(
      { length: SERIAL_PREVIEW_LIMIT + 3 },
      (_, index) => ({
        serial: `SERIAL-${index + 1}`,
        ok: false,
        skipped: index % 2 === 0,
      }),
    );

    expect(registrationFeedback([{ serial: "ADDED0001", ok: true }, ...failures]))
      .toMatchObject({
        status: "success",
        description:
          "6 skipped · 5 invalid — SERIAL-1, SERIAL-2, SERIAL-3, SERIAL-4, SERIAL-5, SERIAL-6, SERIAL-7, SERIAL-8, +3 more need attention.",
      });
  });

  test("deduplicates serials in the failure preview", () => {
    expect(
      registrationFeedback([
        { serial: "DUPLICATE01", ok: false, skipped: true },
        { serial: "DUPLICATE01", ok: false, skipped: true },
        { serial: "INVALID001", ok: false },
      ]),
    ).toMatchObject({
      status: "error",
      description:
        "2 skipped · 1 invalid — DUPLICATE01, INVALID001. Review the serials below.",
    });
  });
});
