import { describe, expect, test, vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import {
  EMERGENCY_INFO_CHANNEL_NOTICE,
  EMERGENCY_INFO_TOOL_NAME,
  emergencyInfoToolForRequest,
  makeHealthRecordTools,
} from "../healthRecordTools";
import { ROLES } from "../roles";

const callerUserId = "caller" as Id<"users">;

function stubCtx(runQuery: ReturnType<typeof vi.fn>): ActionCtx {
  return { runQuery } as unknown as ActionCtx;
}

describe("makeHealthRecordTools", () => {
  test("exposes the tool only to scholar-admin roles", async () => {
    for (const role of [
      ROLES.TEACHER,
      ROLES.SCHOOL_ADMIN,
      ROLES.PLATFORM_ADMIN,
    ]) {
      const tools = await makeHealthRecordTools(stubCtx(vi.fn()), () => {}, {
        role,
        callerUserId,
        surface: "private",
      });
      expect(tools.map((tool) => tool.name)).toEqual([
        EMERGENCY_INFO_TOOL_NAME,
      ]);
    }
    // Base `staff` is NOT a scholar-admin role by default — the retired
    // `registrar` role used to grant this by role alone; the successor is the
    // explicit `health:manage` capability grant (`hasHealthManagementAccess`),
    // covered separately below.
    for (const role of [
      ROLES.SCHOLAR,
      ROLES.PARENT,
      ROLES.CURRICULUM_DESIGNER,
      ROLES.STAFF,
    ]) {
      expect(
        await makeHealthRecordTools(stubCtx(vi.fn()), () => {}, {
          role,
          callerUserId,
          surface: "private",
        }),
      ).toEqual([]);
    }
  });

  test("exposes the tool to base staff granted the health:manage capability", async () => {
    const tools = await makeHealthRecordTools(stubCtx(vi.fn()), () => {}, {
      role: ROLES.STAFF,
      callerUserId,
      surface: "private",
      hasHealthManagementAccess: true,
    });
    expect(tools.map((tool) => tool.name)).toEqual([EMERGENCY_INFO_TOOL_NAME]);
  });

  test("natural-language emergency requests select the health-record tool", () => {
    for (const request of [
      "What is Kai's emergency info?",
      "Who are Lani's emergency contacts?",
      "Does Avery have any allergies?",
      "Show me Noah's current medications",
      "Open Mia's health record",
    ]) {
      expect(emergencyInfoToolForRequest(request)).toBe(
        EMERGENCY_INFO_TOOL_NAME,
      );
    }
    expect(emergencyInfoToolForRequest("How is Kai doing in math?")).toBeNull();
  });

  test("channel calls return a DM instruction without querying or emitting", async () => {
    const runQuery = vi.fn();
    const emit = vi.fn();
    const [tool] = await makeHealthRecordTools(stubCtx(runQuery), emit, {
      role: ROLES.TEACHER,
      callerUserId,
      surface: "channel",
    });

    expect(await tool.run({ scholarName: "Kai" })).toBe(
      EMERGENCY_INFO_CHANNEL_NOTICE,
    );
    expect(runQuery).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  test("private calls preserve institution scope and keep health values out of tool traces", async () => {
    const result = {
      status: "found" as const,
      scholar: "Kai Nakamura",
      emergencyInfo: {
        allergies: { noneKnown: false, entries: [{ allergen: "Peanuts" }] },
        medications: {
          authorizationDocumentation: "uploaded",
        },
        immunization: {
          status: "up_to_date",
          supportingDocumentation: "provide_separately",
        },
        standardProgram: {
          acknowledgmentStatus: "acknowledged",
          publicMedia: {
            publicWebsiteAndSocialMediaOptOut: true,
            privateSchoolCommunicationsIncluded: true,
          },
          exceptions: {
            fieldTrips: {
              requested: true,
              details: "Needs accessible transportation.",
            },
            physicalEducationAndRecess: { requested: false },
            swimming: { requested: false },
          },
        },
      },
      submission: { revision: 2 },
    };
    const runQuery = vi.fn().mockResolvedValue(result);
    const emit = vi.fn();
    const [tool] = await makeHealthRecordTools(stubCtx(runQuery), emit, {
      role: ROLES.STAFF,
      callerUserId,
      surface: "private",
      institutionScope: "moli",
      hasHealthManagementAccess: true,
    });

    const raw = await tool.run({ scholarName: "Kai Nakamura" });
    expect(typeof raw).toBe("string");
    if (typeof raw !== "string") throw new Error("Expected a text tool result");
    expect(JSON.parse(raw)).toEqual(result);
    expect(runQuery).toHaveBeenCalledWith(expect.anything(), {
      callerUserId,
      scholarName: "Kai Nakamura",
      institutionScope: "moli",
    });
    expect(emit).toHaveBeenCalledWith({
      toolComplete: {
        name: EMERGENCY_INFO_TOOL_NAME,
        result: "Emergency information lookup completed",
      },
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("Peanuts");
    expect(raw).toContain('"authorizationDocumentation":"uploaded"');
    expect(raw).toContain('"acknowledgmentStatus":"acknowledged"');
    expect(raw).toContain('"publicWebsiteAndSocialMediaOptOut":true');
    expect(raw).not.toMatch(/photoConsent|fieldTripConsent|swimConsent/);
    expect(raw).not.toMatch(/storageId|fileName|signedUrl|https?:\/\//i);
  });

  test("returns explicit no-record and ambiguity results", async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce({ status: "no_record", scholar: "Kai Nakamura" })
      .mockResolvedValueOnce({
        status: "ambiguous",
        candidates: ["Kai Nakamura", "Kai Tanaka"],
      });
    const [tool] = await makeHealthRecordTools(stubCtx(runQuery), () => {}, {
      role: ROLES.TEACHER,
      callerUserId,
      surface: "private",
    });

    await expect(tool.run({ scholarName: "Kai Nakamura" })).resolves.toMatch(
      /No submitted canonical/i,
    );
    await expect(tool.run({ scholarName: "Kai" })).resolves.toMatch(
      /ambiguous.*Kai Nakamura, Kai Tanaka/i,
    );
  });
});
