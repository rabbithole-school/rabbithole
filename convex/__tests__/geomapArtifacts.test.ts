import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { buildMapSection } from "../sessionHelpers";
import type { StoredMapArtifact, GeoMapSpec } from "../../lib/geomap/types";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/** Assert a map-mutation result carried an artifact id, and return it typed. */
function idOf(r: Record<string, unknown>): Id<"artifacts"> {
  if (!r.artifactId) {
    throw new Error(`expected artifactId, got ${JSON.stringify(r)}`);
  }
  return r.artifactId as Id<"artifacts">;
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "scholar",
  username = role === "scholar" ? "testscholar" : "testteacher",
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: role === "scholar" ? "Test Scholar" : "Test Teacher",
      username,
      role,
    });
  });
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("sessions", {
      userId,
      title: "Map Session",
      isArchived: false,
    });
  });
}

function validSpec(overrides: Record<string, unknown> = {}) {
  return {
    title: "Oʻahu from space",
    camera: { center: [-157.9, 21.45], zoom: 9 },
    base: "satellite",
    ...overrides,
  };
}

async function readStored(
  t: ReturnType<typeof convexTest>,
  artifactId: Id<"artifacts">,
): Promise<StoredMapArtifact> {
  const content = await t.run(async (ctx) => {
    const a = await ctx.db.get(artifactId);
    return a!.content;
  });
  return JSON.parse(content) as StoredMapArtifact;
}

async function countArtifacts(
  t: ReturnType<typeof convexTest>,
  sessionId: Id<"sessions">,
  onlyMaps = false,
) {
  return await t.run(async (ctx) => {
    const rows = (await ctx.db.query("artifacts").collect()).filter(
      (r) => r.sessionId === sessionId,
    );
    return onlyMaps ? rows.filter((r) => r.type === "map").length : rows.length;
  });
}

describe("geomap — aiCreateMapArtifact", () => {
  test("create inserts a map artifact and returns its id", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const sessionId = await seedSession(t, scholarId);

    const result = await t.mutation(internal.artifacts.aiCreateMapArtifact, {
      sessionId,
      specJson: JSON.stringify(validSpec()),
    });
    const mapId = idOf(result);
    expect(result.reused).toBe(false);

    const stored = await readStored(t, mapId);
    expect(stored.v).toBe(1);
    expect(stored.spec.v).toBe(1);
    expect(stored.spec.id).toBeTruthy(); // injected
    expect(stored.spec.base).toBe("satellite");
    expect(stored.scholarPins).toEqual([]);

    const row = await t.run(async (ctx) => ctx.db.get(mapId));
    expect(row!.type).toBe("map");
    expect(row!.lastEditedBy).toBe("ai");
  });

  test("a created map with a task forces tapToPin ON (loop is tappable)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const sessionId = await seedSession(t, scholarId);

    // Natural show_map task spec: a task, no explicit interactions.tapToPin.
    const mapId = idOf(
      await t.mutation(internal.artifacts.aiCreateMapArtifact, {
        sessionId,
        specJson: JSON.stringify(
          validSpec({
            task: {
              kind: "locate",
              prompt: "Tap Honolulu.",
              target: [-157.86, 21.31],
              toleranceKm: 25,
            },
          }),
        ),
      }),
    );

    const stored = await readStored(t, mapId);
    // Without normalization both renderers default tapToPin to !spec.task
    // (i.e. OFF), which would make the pin→grade→tutor loop dead on arrival.
    expect(stored.spec.interactions?.tapToPin).toBe(true);
  });

  test("one-map rule: a second create REUSES the row and RESETS pins", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const sessionId = await seedSession(t, scholarId);

    const first = idOf(
      await t.mutation(internal.artifacts.aiCreateMapArtifact, {
        sessionId,
        specJson: JSON.stringify(validSpec()),
      }),
    );

    // Scholar drops a pin.
    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.artifacts.scholarSetMapPins, {
      artifactId: first,
      pins: [{ id: "p1", lngLat: [-157.8, 21.3] }],
    });

    const second = await t.mutation(internal.artifacts.aiCreateMapArtifact, {
      sessionId,
      specJson: JSON.stringify(validSpec({ base: "terrain" })),
    });
    const secondId = idOf(second);
    expect(second.reused).toBe(true);
    expect(secondId).toBe(first);

    // Only ONE map artifact exists, pins were reset, spec updated.
    const stored = await readStored(t, secondId);
    expect(stored.spec.base).toBe("terrain");
    expect(stored.scholarPins).toEqual([]);
    expect(await countArtifacts(t, sessionId, true)).toBe(1);
  });

  test("validateSpec rejection surfaces the reason (no artifact written)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const sessionId = await seedSession(t, scholarId);

    const result = await t.mutation(internal.artifacts.aiCreateMapArtifact, {
      sessionId,
      specJson: JSON.stringify(validSpec({ base: "moon" })),
    });
    expect(result.error).toBeTruthy();
    expect(String(result.error)).toContain("moon");
    expect(await countArtifacts(t, sessionId)).toBe(0);
  });
});

describe("geomap — aiApplyMapOps", () => {
  test("camera patch preserves route geometry and scholar pins", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const sessionId = await seedSession(t, scholarId);

    const mapId = idOf(
      await t.mutation(internal.artifacts.aiCreateMapArtifact, {
        sessionId,
        specJson: JSON.stringify(
          validSpec({
            layers: [
              {
                id: "route",
                label: "Ocean route",
                source: {
                  geojson: {
                    type: "FeatureCollection",
                    features: [
                      {
                        type: "Feature",
                        geometry: {
                          type: "LineString",
                          coordinates: [
                            [12.5, 42.5],
                            [100, 20],
                            [179, 21],
                            [-179, 21],
                            [-157.9, 21.3],
                          ],
                        },
                      },
                    ],
                  },
                },
                paint: "arrows",
                tint: "green",
              },
            ],
          }),
        ),
      }),
    );

    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.artifacts.scholarSetMapPins, {
      artifactId: mapId,
      pins: [
        { id: "p1", lngLat: [-157.8, 21.3], label: "here" },
        { id: "p2", lngLat: [-158.0, 21.6] },
      ],
    });

    const read = await t.query(internal.artifacts.aiReadMapArtifact, {
      sessionId,
    });
    if ("error" in read) throw new Error(read.error);
    expect(read.revision).toBe(0);
    expect(read.spec.layers?.[0].source).toEqual(
      (await readStored(t, mapId)).spec.layers?.[0].source,
    );

    const updated = await t.mutation(internal.artifacts.aiApplyMapOps, {
      sessionId,
      baseRevision: read.revision,
      opsJson: JSON.stringify([
        { op: "patchCamera", camera: { zoom: 5 } },
      ]),
    });
    expect(updated.revision).toBe(1);

    const stored = await readStored(t, mapId);
    expect(stored.spec.camera).toEqual({
      center: [-157.9, 21.45],
      zoom: 5,
    });
    expect(stored.spec.layers?.[0].source).toEqual(read.spec.layers?.[0].source);
    expect(stored.scholarPins).toHaveLength(2);
    expect(stored.scholarPins[0].label).toBe("here");
  });

  test("patch rejects when no map exists yet", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const sessionId = await seedSession(t, scholarId);

    const result = await t.mutation(internal.artifacts.aiApplyMapOps, {
      sessionId,
      baseRevision: 0,
      opsJson: JSON.stringify([
        { op: "patchCamera", camera: { zoom: 5 } },
      ]),
    });
    expect(result.error).toBeTruthy();
    expect(String(result.error)).toContain("create");
  });

  test("stale patch is refused instead of overwriting a newer map", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const sessionId = await seedSession(t, scholarId);

    await t.mutation(internal.artifacts.aiCreateMapArtifact, {
      sessionId,
      specJson: JSON.stringify(validSpec()),
    });
    await t.mutation(internal.artifacts.aiApplyMapOps, {
      sessionId,
      baseRevision: 0,
      opsJson: JSON.stringify([
        { op: "patchCamera", camera: { zoom: 5 } },
      ]),
    });

    const stale = await t.mutation(internal.artifacts.aiApplyMapOps, {
      sessionId,
      baseRevision: 0,
      opsJson: JSON.stringify([
        { op: "patchCamera", camera: { zoom: 2 } },
      ]),
    });
    expect(stale.error).toContain("stale");
    expect(stale.staleRevision).toBe(1);
  });
});

describe("geomap — scholarSetMapPins", () => {
  test("owner can set pins; the tutor's spec is untouched", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const sessionId = await seedSession(t, scholarId);

    const mapId = idOf(
      await t.mutation(internal.artifacts.aiCreateMapArtifact, {
        sessionId,
        specJson: JSON.stringify(validSpec({ layers: [] })),
      }),
    );
    const specBefore = (await readStored(t, mapId)).spec;

    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.artifacts.scholarSetMapPins, {
      artifactId: mapId,
      pins: [{ id: "p1", lngLat: [-157.8, 21.3] }],
    });

    const after = await readStored(t, mapId);
    expect(after.scholarPins).toHaveLength(1);
    expect(after.spec).toEqual(specBefore); // spec byte-identical
  });

  test("a different scholar cannot set pins", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t, "scholar", "owner");
    const otherId = await seedUser(t, "scholar", "intruder");
    const sessionId = await seedSession(t, ownerId);

    const mapId = idOf(
      await t.mutation(internal.artifacts.aiCreateMapArtifact, {
        sessionId,
        specJson: JSON.stringify(validSpec()),
      }),
    );

    const asOther = await withUser(t, otherId);
    await expect(
      asOther.mutation(api.artifacts.scholarSetMapPins, {
        artifactId: mapId,
        pins: [{ id: "p1", lngLat: [-157.8, 21.3] }],
      }),
    ).rejects.toThrow();
  });

  test("pin cap is enforced", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const sessionId = await seedSession(t, scholarId);

    const mapId = idOf(
      await t.mutation(internal.artifacts.aiCreateMapArtifact, {
        sessionId,
        specJson: JSON.stringify(validSpec()),
      }),
    );

    const tooMany = Array.from({ length: 25 }, (_, i) => ({
      id: `p${i}`,
      lngLat: [-157.8, 21.3] as [number, number],
    }));
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.artifacts.scholarSetMapPins, {
        artifactId: mapId,
        pins: tooMany,
      }),
    ).rejects.toThrow();
  });
});

describe("geomap — getById access", () => {
  test("owner reads, other scholar is denied, teacher reads", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const ownerId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Map Owner",
      username: "owner",
    });
    const otherId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Map Intruder",
      username: "intruder",
    });
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      username: "map-teacher",
    });
    const sessionId = await seedSession(t, ownerId);

    const mapId = idOf(
      await t.mutation(internal.artifacts.aiCreateMapArtifact, {
        sessionId,
        specJson: JSON.stringify(validSpec()),
      }),
    );

    const asOwner = await withUser(t, ownerId);
    const owned = await asOwner.query(api.artifacts.getById, {
      artifactId: mapId,
    });
    expect(owned?._id).toBe(mapId);

    const asOther = await withUser(t, otherId);
    const denied = await asOther.query(api.artifacts.getById, {
      artifactId: mapId,
    });
    expect(denied).toBeNull();

    const asTeacher = await withUser(t, teacherId);
    const staffRead = await asTeacher.query(api.artifacts.getById, {
      artifactId: mapId,
    });
    expect(staffRead?._id).toBe(mapId);
  });
});

describe("geomap — buildMapSection", () => {
  test("renders the scholar's pins with coordinates", () => {
    const stored: StoredMapArtifact = {
      v: 1,
      spec: {
        v: 1,
        id: "m1",
        title: "Oʻahu",
        camera: { center: [-157.9, 21.45], zoom: 9 },
        base: "satellite",
        layers: [
          {
            id: "rain",
            label: "Rainfall",
            source: { geojson: { type: "FeatureCollection", features: [] } },
            paint: "isolines",
            initiallyVisible: false,
          },
        ],
      },
      scholarPins: [{ id: "p1", lngLat: [-157.82, 21.31], label: "wet side" }],
    };
    const section = buildMapSection([
      {
        id: "a1",
        title: "Oʻahu",
        content: JSON.stringify(stored),
        lastEditedBy: "ai",
        revision: 0,
        type: "map",
      },
    ]);
    expect(section).toContain("MAP");
    expect(section).toContain("Map artifact ID: `a1`");
    expect(section).toContain("wet side");
    expect(section).toContain("21.310");
    expect(section).toContain("HIDDEN");
    expect(section).toContain('show_map op:"read"');
    expect(section).toContain('op:"patch"');
    expect(section).not.toContain('op:"update"');
  });

  test("returns empty string when there is no map artifact", () => {
    expect(
      buildMapSection([
        {
          id: "d1",
          title: "Doc",
          content: "hello",
          lastEditedBy: "scholar",
          revision: 0,
          type: "text",
        },
      ]),
    ).toBe("");
    expect(buildMapSection(null)).toBe("");
  });

  test("emits a SERVER CHECK verdict for a locate task", () => {
    // Target Honolulu; a pin ~0km away is inside a generous tolerance.
    const spec: GeoMapSpec = {
      v: 1,
      id: "m2",
      title: "Find Honolulu",
      camera: { center: [-157.9, 21.3], zoom: 9 },
      base: "satellite",
      task: {
        kind: "locate",
        prompt: "Tap Honolulu.",
        target: [-157.86, 21.31],
        toleranceKm: 25,
      },
    };
    const solved: StoredMapArtifact = {
      v: 1,
      spec,
      scholarPins: [{ id: "p1", lngLat: [-157.85, 21.31] }],
    };
    const solvedSection = buildMapSection([
      {
        id: "a1",
        title: "Find Honolulu",
        content: JSON.stringify(solved),
        lastEditedBy: "ai",
        revision: 0,
        type: "map",
      },
    ]);
    expect(solvedSection).toContain("graded task (kind: locate)");
    expect(solvedSection).toContain("SERVER CHECK: the scholar's current pins SOLVE");

    const unsolved: StoredMapArtifact = {
      v: 1,
      spec,
      scholarPins: [{ id: "p1", lngLat: [0, 0] }],
    };
    const unsolvedSection = buildMapSection([
      {
        id: "a1",
        title: "Find Honolulu",
        content: JSON.stringify(unsolved),
        lastEditedBy: "ai",
        revision: 0,
        type: "map",
      },
    ]);
    expect(unsolvedSection).toContain("do NOT yet solve this task");
  });
});

describe("geomap — getById no-spoiler redaction", () => {
  test("scholar gets redacted task targets, teacher gets raw", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const ownerId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Task Owner",
      username: "taskowner",
    });
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      username: "task-teacher",
    });
    const sessionId = await seedSession(t, ownerId);

    const mapId = idOf(
      await t.mutation(internal.artifacts.aiCreateMapArtifact, {
        sessionId,
        specJson: JSON.stringify(
          validSpec({
            task: {
              kind: "locate",
              prompt: "Tap Honolulu.",
              target: [-157.86, 21.31],
              toleranceKm: 25,
            },
          }),
        ),
      }),
    );

    const asOwner = await withUser(t, ownerId);
    const owned = await asOwner.query(api.artifacts.getById, {
      artifactId: mapId,
    });
    const ownerStored = JSON.parse(owned!.content) as StoredMapArtifact;
    const ownerTask = ownerStored.spec.task;
    expect(ownerTask?.kind).toBe("locate");
    // Answer-bearing target must be blanked for the scholar.
    if (ownerTask?.kind === "locate") {
      expect(ownerTask.target).toEqual([0, 0]);
      expect(ownerTask.toleranceKm).toBe(25);
    }

    const asTeacher = await withUser(t, teacherId);
    const staffRead = await asTeacher.query(api.artifacts.getById, {
      artifactId: mapId,
    });
    const teacherStored = JSON.parse(staffRead!.content) as StoredMapArtifact;
    const teacherTask = teacherStored.spec.task;
    expect(teacherTask?.kind).toBe("locate");
    if (teacherTask?.kind === "locate") {
      expect(teacherTask.target).toEqual([-157.86, 21.31]);
    }
  });

  test("getBySession redacts the task for the scholar but not the teacher", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const ownerId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Session Owner",
      username: "sessowner",
    });
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      username: "sess-teacher",
    });
    const sessionId = await seedSession(t, ownerId);

    await t.mutation(internal.artifacts.aiCreateMapArtifact, {
      sessionId,
      specJson: JSON.stringify(
        validSpec({
          task: {
            kind: "locate",
            prompt: "Tap Honolulu.",
            target: [-157.86, 21.31],
            toleranceKm: 25,
          },
        }),
      ),
    });

    const findMap = (rows: { content: string }[] | null) => {
      const stored = (rows ?? [])
        .map((r) => {
          try {
            return JSON.parse(r.content) as StoredMapArtifact;
          } catch {
            return null;
          }
        })
        .find((s) => s?.spec?.task);
      return stored ?? null;
    };

    const asOwner = await withUser(t, ownerId);
    const ownerRows = await asOwner.query(api.artifacts.getBySession, {
      sessionId,
    });
    const ownerTask = findMap(ownerRows)?.spec.task;
    expect(ownerTask?.kind).toBe("locate");
    // The real scholar surface (getBySession) must be redacted too.
    if (ownerTask?.kind === "locate") {
      expect(ownerTask.target).toEqual([0, 0]);
    }

    const asTeacher = await withUser(t, teacherId);
    const teacherRows = await asTeacher.query(api.artifacts.getBySession, {
      sessionId,
    });
    const teacherTask = findMap(teacherRows)?.spec.task;
    expect(teacherTask?.kind).toBe("locate");
    if (teacherTask?.kind === "locate") {
      expect(teacherTask.target).toEqual([-157.86, 21.31]);
    }
  });
});
