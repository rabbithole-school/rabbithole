import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { alertEmoji } from "../alerts";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("alert emoji", () => {
  test("uses a value-neutral practice glyph without changing warning fallback", () => {
    expect(alertEmoji("practice_stuck", "warning")).toBe("🧗");
    expect(alertEmoji("device_low_battery", "warning")).toBe("⚠️");
    expect(alertEmoji("practice_not_yet_taught", "info")).toBe("ℹ️");
  });

  test("overwhelm gets a feeling glyph at both severities, not a severity glyph", () => {
    expect(alertEmoji("chat_overwhelm", "info")).toBe("😫");
    expect(alertEmoji("chat_overwhelm", "warning")).toBe("😫");
    // Its cognitive sibling keeps the severity fallback — they must stay
    // visually distinguishable in a Slack channel.
    expect(alertEmoji("chat_stuck", "warning")).toBe("⚠️");
  });
});

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "platform_admin",
): Promise<Id<"users">> {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${role}`,
      username: `test${role}`,
      role,
    }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  return userId;
}

async function insertAlertForSlackDelivery(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("alerts", {
      kind: "welfare",
      severity: "critical",
      title: "Needs follow-up",
      body: "A delivery receipt test.",
      source: "test",
      status: "open",
      createdAt: Date.now(),
    }),
  );
}

describe("alerts.linkAlertsChannel", () => {
  test("admin can link, and linking again moves the single channel", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    const r1 = await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_ALERTS_1",
      unlink: false,
    });
    expect(r1.ok).toBe(true);

    const r2 = await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_ALERTS_2",
      unlink: false,
    });
    expect(r2.ok).toBe(true);

    const rows = await t.run(async (ctx) => ctx.db.query("alertChannel").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].slackChannelId).toBe("C_ALERTS_2");
    // Legacy call without role → defaults to "catchall"
    expect(rows[0].role).toBe("catchall");
  });

  test("non-admin is forbidden", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const res = await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: teacher,
      slackChannelId: "C_ALERTS",
      unlink: false,
    });
    expect(res.ok).toBe(false);
    const rows = await t.run(async (ctx) => ctx.db.query("alertChannel").collect());
    expect(rows).toHaveLength(0);
  });

  test("unlink only removes when this channel is the linked one", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_REAL",
      unlink: false,
    });

    const wrong = await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_OTHER",
      unlink: true,
    });
    expect(wrong.ok).toBe(false);

    const right = await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_REAL",
      unlink: true,
    });
    expect(right.ok).toBe(true);
    const rows = await t.run(async (ctx) => ctx.db.query("alertChannel").collect());
    expect(rows).toHaveLength(0);
  });

  test("platform-ops role links a separate channel alongside catchall", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    // Link a catchall channel first.
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_CATCHALL",
      unlink: false,
      role: "catchall",
    });

    // Now link a platform-ops channel.
    const r = await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_PLATFORM_OPS",
      unlink: false,
      role: "platform-ops",
    });
    expect(r.ok).toBe(true);

    const rows = await t.run(async (ctx) => ctx.db.query("alertChannel").collect());
    expect(rows).toHaveLength(2);
    const catchallRow = rows.find((r) => r.role === "catchall");
    const platformOpsRow = rows.find((r) => r.role === "platform-ops");
    expect(catchallRow?.slackChannelId).toBe("C_CATCHALL");
    expect(platformOpsRow?.slackChannelId).toBe("C_PLATFORM_OPS");
  });

  test("platform-ops: linking again moves to the new channel", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_OPS_1",
      unlink: false,
      role: "platform-ops",
    });
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_OPS_2",
      unlink: false,
      role: "platform-ops",
    });

    const rows = await t.run(async (ctx) => ctx.db.query("alertChannel").collect());
    expect(rows.filter((r) => r.role === "platform-ops")).toHaveLength(1);
    expect(rows.find((r) => r.role === "platform-ops")?.slackChannelId).toBe("C_OPS_2");
  });

  test("improvement-loops links separately from platform operations", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_OPS",
      unlink: false,
      role: "platform-ops",
    });
    const linked = await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_LOOPS",
      unlink: false,
      role: "improvement-loops",
    });

    expect(linked).toMatchObject({ ok: true, role: "improvement-loops" });
    const rows = await t.run(async (ctx) => ctx.db.query("alertChannel").collect());
    expect(rows.find((row) => row.role === "platform-ops")?.slackChannelId).toBe("C_OPS");
    expect(rows.find((row) => row.role === "improvement-loops")?.slackChannelId).toBe("C_LOOPS");
  });

  test("scoped role requires an institution slug", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    const r = await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_SCOPED",
      unlink: false,
      role: "scoped",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("scoped");
  });

  test("catchall role rejects an institution slug", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        slug: "primary",
        name: "Primary School",
        kind: "school",
        emoji: "🏫",
        isPrimary: true,
        timeZone: "Pacific/Honolulu",
      }),
    );

    const r = await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_CATCHALL",
      unlink: false,
      role: "catchall",
      institutionSlug: "primary",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("catchall");
  });
});

describe("alerts.raise", () => {
  test("renders the practice climb glyph without changing warning fallback", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_ALERTS",
      unlink: false,
    });

    for (const alert of [
      {
        kind: "practice_stuck",
        title: "Practice struggle",
      },
      {
        kind: "device_low_battery",
        title: "Device battery low",
      },
    ]) {
      await t.mutation(internal.alerts.raise, {
        ...alert,
        severity: "warning",
        body: "Details",
        source: "test",
        audience: "institution",
      });
    }

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const texts = scheduled.map(
      (row) => (row.args[0] as { text: string }).text,
    );
    expect(texts).toContain("🧗 *Practice struggle*\nDetails");
    expect(texts).toContain("⚠️ *Device battery low*\nDetails");
  });

  test("records an alert row even when no channel is linked", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alerts.raise, {
      kind: "welfare",
      severity: "warning",
      title: "Welfare disclosure — Test Scholar",
      body: "Scholar mentioned feeling unsafe at home.",
      source: "observer",
      audience: "institution",
    });
    const rows = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("open");
    expect(rows[0].kind).toBe("welfare");
  });

  test("dedupKey coalesces repeats within the window", async () => {
    const t = convexTest(schema, modules);
    const common = {
      kind: "welfare",
      severity: "critical" as const,
      title: "Welfare disclosure",
      body: "...",
      source: "observer",
      audience: "institution" as const,
      dedupKey: "welfare:scholar1:session1",
    };
    await t.mutation(internal.alerts.raise, common);
    await t.mutation(internal.alerts.raise, common);
    const rows = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(rows).toHaveLength(1);
  });

  test("distinct dedupKeys each produce an alert", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.alerts.raise, {
      kind: "welfare",
      severity: "warning",
      title: "A",
      body: "...",
      source: "observer",
      audience: "institution",
      dedupKey: "welfare:a:1",
    });
    await t.mutation(internal.alerts.raise, {
      kind: "welfare",
      severity: "warning",
      title: "B",
      body: "...",
      source: "observer",
      audience: "institution",
      dedupKey: "welfare:b:1",
    });
    const rows = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(rows).toHaveLength(2);
  });

  test("chat_overwhelm dedupKey includes severity so an info alert can't suppress a later warning escalation", async () => {
    // Regression: observer.ts builds this session's dedupKey as
    // `chat_overwhelm:<scholarId>:<sessionId>:<severity>` — same rationale as
    // `parasocial_reliance`'s severity-in-key above. Without the severity
    // segment, an early "info" overwhelm alert would dedupe away a later
    // "warning" escalation raised within the 12h window for the same
    // session (the observer runs repeatedly across a session).
    const t = convexTest(schema, modules);
    const base = {
      kind: "chat_overwhelm",
      title: "Asked to stop — a scholar",
      body: "...",
      source: "observer",
      audience: "institution" as const,
    };
    await t.mutation(internal.alerts.raise, {
      ...base,
      severity: "info",
      dedupKey: "chat_overwhelm:scholar1:session1:info",
    });
    // A later escalation to "warning" for the SAME session must still post —
    // its key differs by severity, so it isn't shadowed by the info alert.
    await t.mutation(internal.alerts.raise, {
      ...base,
      severity: "warning",
      dedupKey: "chat_overwhelm:scholar1:session1:warning",
    });
    // A second "warning" for the same session within the window DOES coalesce
    // with the first warning — severity-scoped dedup still works.
    await t.mutation(internal.alerts.raise, {
      ...base,
      severity: "warning",
      dedupKey: "chat_overwhelm:scholar1:session1:warning",
    });
    const rows = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(rows.map((r) => r.severity).sort()).toEqual(["info", "warning"]);
  });

  test("dedupWindowMs widens the window past the 12h default", async () => {
    const t = convexTest(schema, modules);
    // A prior alert raised 13h ago — just outside the 12h default window.
    await t.run(async (ctx) =>
      ctx.db.insert("alerts", {
        kind: "parasocial_reliance",
        severity: "info",
        title: "Connection note",
        body: "...",
        source: "observer",
        dedupKey: "parasocial:scholar1",
        status: "open",
        createdAt: Date.now() - 13 * 60 * 60 * 1000,
      }),
    );

    // Default window (12h): the 13h-old row is stale → a new row is created.
    await t.mutation(internal.alerts.raise, {
      kind: "parasocial_reliance",
      severity: "info",
      title: "Connection note",
      body: "...",
      source: "observer",
      audience: "institution",
      dedupKey: "parasocial:scholar1",
    });
    let rows = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(rows).toHaveLength(2);

    // A 3-day window coalesces with the most recent of those rows → no new row.
    await t.mutation(internal.alerts.raise, {
      kind: "parasocial_reliance",
      severity: "info",
      title: "Connection note",
      body: "...",
      source: "observer",
      audience: "institution",
      dedupKey: "parasocial:scholar1",
      dedupWindowMs: 3 * 24 * 60 * 60 * 1000,
    });
    rows = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(rows).toHaveLength(2);
  });

  test("a low-severity parasocial info alert still posts to the linked channel", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_ALERTS",
      unlink: false,
    });
    const scholar = await seedUser(t, "scholar");
    // Per Andy's finalized routing: parasocial alerts post to #rabbithole-alerts
    // at BOTH info and warning (the calm ℹ️/⚠️ glyph, never the 🚨 siren) — not
    // in-app-only. So an info-severity alert must schedule a Slack post.
    // Scholar has no institution → falls back to the catchall channel.
    await t.mutation(internal.alerts.raise, {
      kind: "parasocial_reliance",
      severity: "info",
      title: "Connection note — Test Scholar",
      body: "Leaning on the tutor as a confidant.",
      source: "observer",
      audience: "institution",
      scholarId: scholar,
    });
    const rows = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(rows).toHaveLength(1);
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    await t.finishAllScheduledFunctions(() => {});
  });

  test("a warning-severity parasocial alert schedules a Slack post", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_ALERTS",
      unlink: false,
    });
    const scholar = await seedUser(t, "scholar");
    await t.mutation(internal.alerts.raise, {
      kind: "parasocial_reliance",
      severity: "warning",
      title: "Connection note — Test Scholar",
      body: "Sustained reliance on the tutor.",
      source: "observer",
      audience: "institution",
      scholarId: scholar,
    });
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    await t.finishAllScheduledFunctions(() => {});
  });

  test("posts to the linked channel (schedules postNow) without throwing", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_ALERTS",
      unlink: false,
    });
    const scholar = await seedUser(t, "scholar");
    await t.mutation(internal.alerts.raise, {
      kind: "welfare",
      severity: "critical",
      title: "Welfare disclosure",
      body: "line",
      source: "observer",
      audience: "institution",
      scholarId: scholar,
      deepLink: "https://example.com/teacher/scholar/x",
    });
    // postNow is scheduled; with no SLACK_BOT_TOKEN it no-ops. Just drain it.
    await t.finishAllScheduledFunctions(() => {});
    const rows = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(rows).toHaveLength(1);
  });

  test("reconciles an accepted alert root by delivery metadata without reposting", async () => {
    const t = convexTest(schema, modules);
    const alertId = await insertAlertForSlackDelivery(t);
    const realFetch = globalThis.fetch;
    const previousSlackToken = process.env.SLACK_BOT_TOKEN;
    const requests: string[] = [];
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    globalThis.fetch = (async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = String(url);
      requests.push(method);
      expect(method).toContain("conversations.history");
      expect(
        new URLSearchParams(String(init?.body)).get("oldest"),
      ).not.toBeNull();
      return new Response(
        JSON.stringify({
          ok: true,
          messages: [
            {
              ts: "1724700000.123456",
              metadata: {
                event_type: "rabbithole_alert",
                event_payload: { delivery_id: String(alertId) },
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      await t.action(internal.slackNotifications.postNow, {
        channelId: "C_ALERTS",
        text: "Needs follow-up",
        alertId,
        deliveryAttempt: 1,
      });
    } finally {
      globalThis.fetch = realFetch;
      if (previousSlackToken === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = previousSlackToken;
      }
    }

    expect(requests).toHaveLength(1);
    const alert = await t.run(async (ctx) => ctx.db.get(alertId));
    expect(alert).toMatchObject({
      slackChannelId: "C_ALERTS",
      slackMessageTs: "1724700000.123456",
    });
  });

  test("schedules a bounded retry after an ambiguous alert post failure", async () => {
    const t = convexTest(schema, modules);
    const alertId = await insertAlertForSlackDelivery(t);
    const realFetch = globalThis.fetch;
    const previousSlackToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      expect(String(url)).toContain("chat.postMessage");
      return new Response(JSON.stringify({ ok: false, error: "internal_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await t.action(internal.slackNotifications.postNow, {
        channelId: "C_ALERTS",
        text: "Needs follow-up",
        alertId,
      });
    } finally {
      globalThis.fetch = realFetch;
      if (previousSlackToken === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = previousSlackToken;
      }
    }

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.name).toBe("slackNotifications:postNow");
  });

  // ─── New routing tests ─────────────────────────────────────────────────────

  test("platform-audience alert routes to platform-ops only", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    // Link both a catchall and a platform-ops channel.
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_CATCHALL",
      unlink: false,
      role: "catchall",
    });
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_OPS",
      unlink: false,
      role: "platform-ops",
    });

    // A platform-audience alert (the cost report) → platform-ops only.
    await t.mutation(internal.alerts.raise, {
      kind: "usage_cost_report",
      severity: "info",
      title: "Weekly AI Usage",
      body: "Cost this week: $42",
      source: "usageReport",
      audience: "platform",
    });

    const rows = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(rows).toHaveLength(1);

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    // Only ONE post scheduled — to the platform-ops channel, NOT catchall.
    expect(scheduled).toHaveLength(1);
    await t.finishAllScheduledFunctions(() => {});
  });

  test("platform-audience alert does NOT post when no platform-ops channel is linked", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    // Only a catchall channel linked — no platform-ops.
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_CATCHALL",
      unlink: false,
      role: "catchall",
    });

    await t.mutation(internal.alerts.raise, {
      kind: "usage_cost_report",
      severity: "info",
      title: "Weekly AI Usage",
      body: "Cost this week: $42",
      source: "usageReport",
      audience: "platform",
    });

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    // No platform-ops channel → no post.
    expect(scheduled).toHaveLength(0);
  });

  test("institution-audience alert with institutionId routes to that scoped channel only", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    // Seed an institution and a scoped channel for it.
    const instId = await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        slug: "primary",
        name: "Primary School",
        kind: "school",
        emoji: "🏫",
        isPrimary: true,
        timeZone: "Pacific/Honolulu",
      }),
    );
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_SCOPED",
      unlink: false,
      role: "scoped",
      institutionId: instId,
    });
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_CATCHALL",
      unlink: false,
      role: "catchall",
    });
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_OPS",
      unlink: false,
      role: "platform-ops",
    });

    await t.mutation(internal.alerts.raise, {
      kind: "quality_pulse_digest",
      severity: "info",
      title: "Weekly Quality Pulse",
      body: "All good this week.",
      source: "qualityPulse",
      audience: "institution",
      institutionId: instId,
    });

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    // Exactly ONE post — C_SCOPED. Not catchall, not platform-ops.
    expect(scheduled).toHaveLength(1);
    await t.finishAllScheduledFunctions(() => {});
  });

  test("institution-audience alert with institutionId but no scoped channel falls back to catchall", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    const instId = await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        slug: "primary",
        name: "Primary School",
        kind: "school",
        emoji: "🏫",
        isPrimary: true,
        timeZone: "Pacific/Honolulu",
      }),
    );
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_CATCHALL",
      unlink: false,
      role: "catchall",
    });
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_OPS",
      unlink: false,
      role: "platform-ops",
    });

    await t.mutation(internal.alerts.raise, {
      kind: "quality_pulse_digest",
      severity: "info",
      title: "Weekly Quality Pulse",
      body: "All good this week.",
      source: "qualityPulse",
      audience: "institution",
      institutionId: instId,
    });

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    // No scoped channel for the institution → catchall. NOT platform-ops.
    expect(scheduled).toHaveLength(1);
    await t.finishAllScheduledFunctions(() => {});
  });

  test("scholar alert with institution routes to scoped channel, not catchall or platform-ops", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    const instId = await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        slug: "primary",
        name: "Primary School",
        kind: "school",
        emoji: "🏫",
        isPrimary: true,
        timeZone: "Pacific/Honolulu",
      }),
    );
    const scholar = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Test Scholar",
        username: "testscholar",
        role: "scholar" as const,
        institutionId: instId,
      }),
    );
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_SCOPED",
      unlink: false,
      role: "scoped",
      institutionId: instId,
    });
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_CATCHALL",
      unlink: false,
      role: "catchall",
    });
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_OPS",
      unlink: false,
      role: "platform-ops",
    });

    await t.mutation(internal.alerts.raise, {
      kind: "welfare",
      severity: "critical",
      title: "Welfare alert",
      body: "Scholar mentioned something concerning.",
      source: "observer",
      audience: "institution",
      scholarId: scholar,
    });

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    // Exactly ONE post to C_SCOPED. Not catchall, not platform-ops.
    expect(scheduled).toHaveLength(1);
    await t.finishAllScheduledFunctions(() => {});
  });

  test("scholar alert without scoped channel falls back to catchall", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    // The scholar HAS an institution — but no scoped channel is linked for it,
    // so the scoped lookup misses and the alert must land on the catchall.
    const instId = await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        slug: "primary",
        name: "Primary School",
        kind: "school",
        emoji: "🏫",
        isPrimary: true,
        timeZone: "Pacific/Honolulu",
      }),
    );
    const scholar = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Test Scholar",
        username: "testscholar",
        role: "scholar" as const,
        institutionId: instId,
      }),
    );
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_CATCHALL",
      unlink: false,
      role: "catchall",
    });
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: admin,
      slackChannelId: "C_OPS",
      unlink: false,
      role: "platform-ops",
    });

    await t.mutation(internal.alerts.raise, {
      kind: "welfare",
      severity: "warning",
      title: "Welfare alert",
      body: "Concerning content.",
      source: "observer",
      audience: "institution",
      scholarId: scholar,
    });

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    // Falls back to catchall. NOT platform-ops.
    expect(scheduled).toHaveLength(1);
    await t.finishAllScheduledFunctions(() => {});
  });

  test("legacy row without role field: no-institutionId row acts as catchall", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin");

    // Insert a legacy-style row (no role field).
    await t.run(async (ctx) =>
      ctx.db.insert("alertChannel", {
        slackChannelId: "C_LEGACY_CATCHALL",
        linkedBy: admin,
        linkedAt: Date.now(),
        // institutionId absent, role absent → legacy catchall
      }),
    );

    const scholar = await seedUser(t, "scholar");
    await t.mutation(internal.alerts.raise, {
      kind: "welfare",
      severity: "warning",
      title: "Welfare alert",
      body: "...",
      source: "observer",
      audience: "institution",
      scholarId: scholar,
    });

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    // Legacy row treated as catchall → scholar alert with no scoped channel falls back here.
    expect(scheduled).toHaveLength(1);
    await t.finishAllScheduledFunctions(() => {});
  });
});

describe("alerts.recentByScholar", () => {
  async function asTeacher(
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
  ) {
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 1000 * 60 * 60,
      }),
    );
    return t.withIdentity({
      subject: `${userId}|${sessionId}`,
      issuer: "https://convex.dev",
    });
  }

  test("returns only the requested kind for the scholar, newest first", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");

    await t.run(async (ctx) => {
      await ctx.db.insert("alerts", {
        kind: "parasocial_reliance",
        severity: "info",
        title: "older",
        body: "...",
        source: "observer",
        scholarId: scholar,
        status: "open",
        createdAt: 1000,
      });
      await ctx.db.insert("alerts", {
        kind: "parasocial_reliance",
        severity: "warning",
        title: "newer",
        body: "...",
        source: "observer",
        scholarId: scholar,
        status: "open",
        createdAt: 2000,
      });
      await ctx.db.insert("alerts", {
        kind: "welfare",
        severity: "critical",
        title: "welfare",
        body: "...",
        source: "observer",
        scholarId: scholar,
        status: "open",
        createdAt: 3000,
      });
    });

    const rows = await (
      await asTeacher(t, teacher)
    ).query(api.alerts.recentByScholar, {
      scholarId: scholar,
      kind: "parasocial_reliance",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("newer");
    expect(rows.every((r) => r.kind === "parasocial_reliance")).toBe(true);
  });

  test("respects the limit", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("alerts", {
          kind: "parasocial_reliance",
          severity: "info",
          title: `n${i}`,
          body: "...",
          source: "observer",
          scholarId: scholar,
          status: "open",
          createdAt: i,
        });
      }
    });
    const rows = await (
      await asTeacher(t, teacher)
    ).query(api.alerts.recentByScholar, {
      scholarId: scholar,
      kind: "parasocial_reliance",
      limit: 2,
    });
    expect(rows).toHaveLength(2);
  });

  test("a scholar (non-teacher) is rejected", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await expect(
      (
        await asTeacher(t, scholar)
      ).query(api.alerts.recentByScholar, {
        scholarId: scholar,
        kind: "parasocial_reliance",
      }),
    ).rejects.toThrow();
  });
});


describe("alerts.recordForScholar", () => {
  async function asUser(
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
  ) {
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 1000 * 60 * 60,
      }),
    );
    return t.withIdentity({
      subject: `${userId}|${sessionId}`,
      issuer: "https://convex.dev",
    });
  }

  async function seedOneOfEachKind(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    kinds: string[],
  ) {
    await t.run(async (ctx) => {
      let ts = 1000;
      for (const kind of kinds) {
        await ctx.db.insert("alerts", {
          kind,
          severity: "info",
          title: kind,
          body: `${kind} summary\n> quote\nSession: "x"`,
          source: "test",
          scholarId,
          status: "open",
          createdAt: ts++,
        });
      }
    });
  }

  test("returns the learning-record kinds, newest first", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    await seedOneOfEachKind(t, scholar, [
      "chat_stuck",
      "practice_stuck",
      "chat_overwhelm",
    ]);

    const rows = await (
      await asUser(t, teacher)
    ).query(api.alerts.recordForScholar, { scholarId: scholar });

    expect(rows.map((r) => r.kind)).toEqual([
      "chat_overwhelm",
      "practice_stuck",
      "chat_stuck",
    ]);
  });

  /**
   * The exclusions are a privacy boundary, not a display preference: welfare is
   * Slack-only by its producer's choice, and the health kinds are gated
   * elsewhere by a capability this query does not check. A future kind added to
   * the table must not silently appear here.
   */
  test("never returns welfare, health, or operations kinds", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const excluded = [
      "welfare",
      "medication_authorization_expired",
      "parent_health_record_update",
      "device_sign_out_approval",
      "device_low_battery",
      "bug_report_pipeline_failed",
      "usage_cost_report",
      "practice_weekly_digest",
      "quality_pulse_digest",
      // Already rendered as the pinned Connection note on the same surface.
      "parasocial_reliance",
      // Retired kind — its producer (the slide-image authorship classifier) was
      // deleted after a 13/13 false-positive production record. Historical prod
      // rows survive and must never surface in a child's learning record.
      "slide_image_guardrail",
      // A kind nobody has classified yet must default to hidden.
      "some_future_kind",
    ];
    await seedOneOfEachKind(t, scholar, [...excluded, "chat_overwhelm"]);

    const rows = await (
      await asUser(t, teacher)
    ).query(api.alerts.recordForScholar, { scholarId: scholar });

    expect(rows.map((r) => r.kind)).toEqual(["chat_overwhelm"]);
  });

  test("a scholar cannot read their own record", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    await seedOneOfEachKind(t, scholar, ["chat_overwhelm"]);
    await expect(
      (
        await asUser(t, scholar)
      ).query(api.alerts.recordForScholar, { scholarId: scholar }),
    ).rejects.toThrow();
  });
});
