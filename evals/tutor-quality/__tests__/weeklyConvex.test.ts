import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWeeklyCandidates, persistWeeklySample } from "../lib/weeklyConvex";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const exec = vi.mocked(execFileSync);
afterEach(() => vi.resetAllMocks());

describe("weekly Convex boundary", () => {
  it("reads a real child-process result larger than Node's default buffer", async () => {
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const script = 'process.stdout.write(JSON.stringify([{transcript:"x".repeat(2*1024*1024)}]))';
    expect(() => real.execFileSync(process.execPath, ["-e", script])).toThrow();
    exec.mockImplementation((_file, _args, options) =>
      real.execFileSync(process.execPath, ["-e", script], options),
    );
    const rows = fetchWeeklyCandidates<{ transcript: string }>(
      "qualityPulse:sessionsToJudge", { limit: 1000 },
    );
    expect(rows[0].transcript).toHaveLength(2 * 1024 * 1024);
    expect(exec).toHaveBeenCalledWith(
      "npx", ["convex", "run", "qualityPulse:sessionsToJudge", '{"limit":1000}'],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it.each(["ENOBUFS", "ENOENT"])("withholds child-process output and arguments on %s", (code) => {
    exec.mockImplementation(() => {
      throw Object.assign(new Error("command includes private-evidence"), {
        code, status: 1, stdout: "private-transcript", stderr: "private-error",
        spawnargs: ["private-evidence"],
      });
    });
    let caught: unknown;
    try {
      persistWeeklySample("qualityPulse:recordSample", { evidence: "private-evidence" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain(code);
    expect(String(caught)).not.toContain("private");
    expect(caught).not.toHaveProperty("stdout");
    expect(caught).not.toHaveProperty("cause");
  });

  it("accepts leading CLI logs and an empty candidate pool", () => {
    exec.mockReturnValue("CLI diagnostic\n[]\n");
    expect(fetchWeeklyCandidates("qualityPulse:handoffsToJudge", {})).toEqual([]);
  });

  it.each(["private-transcript", '[{"content":"private-transcript"', '{"error":"private-transcript"}'])(
    "rejects malformed or wrong-shaped candidate results without echoing them",
    (output) => {
      exec.mockReturnValue(output);
      expect(() => fetchWeeklyCandidates("qualityPulse:sessionsToJudge", {}))
        .toThrow(/^Weekly Convex call qualityPulse:sessionsToJudge (returned invalid JSON; output withheld.|did not return a candidate array.)$/);
    },
  );

  it.each([true, false])("preserves confirmed skipped=%s persistence results", (skipped) => {
    exec.mockReturnValue(`CLI diagnostic\n${JSON.stringify({ skipped })}`);
    expect(persistWeeklySample("qualityPulse:recordSample", {})).toEqual({ skipped });
  });

  it.each(["{}", '{"skipped":"false"}', "null", "[]", "private-evidence"])(
    "never converts an invalid persistence response into success",
    (output) => {
      exec.mockReturnValue(output);
      expect(() => persistWeeklySample("qualityPulse:recordHandoffSample", {})).toThrow();
    },
  );
});
