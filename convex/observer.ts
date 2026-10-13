"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildObserverSystemPrompt } from "./prompts";
import { computePromptVersion } from "./lib/promptVersion";
import { MODELS } from "./lib/models";
import { cleanSeedLabel } from "./lib/seedLabel";
import { siteUrl, sessionPath, withBase } from "./lib/channels";
import { escapeSlackText } from "./lib/slackApi";
import {
  OBSERVER_TOOL,
  alertEvidenceWatermark,
  buildObserverUserMessageBlocks,
  groundAlertExcerpt,
  groundSessionSignalEvidence,
  observerTranscriptWindow,
  parseObserverResponse,
  resolveChatAlertRecency,
  resolveChatAlerts,
  resolveObservationEvidenceTime,
  scholarWordCount,
  typedScholarWordCount,
  type ObserverHistoryMessage,
  type ParsedObserverResponse,
} from "./lib/observerShared";
import { imageUrlToContentPart, type ImageContentPart } from "./lib/imageBytes";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import { SESSION_SIGNAL_TYPES } from "../shared/learningSignals";
import { resolveObserverOrigin } from "./lib/observerOrigin";

const sessionSignalTypes = new Set<string>(SESSION_SIGNAL_TYPES);
const observerInterestHows = new Set(["said", "picked", "menu"]);

/**
 * Shown under a quote that came from a DICTATED scholar turn. The words above
 * it are what speech-to-text heard, which is routinely not what a child said —
 * a teacher reading the alert must be able to tell a transcription artifact
 * from their scholar being confused.
 */
const SPOKEN_EXCERPT_NOTE =
  "(Heard through voice input — the line above is an automatic speech-to-text" +
  " transcript, not necessarily the scholar's own words.)";

/**
 * The evidence lines of an alert body, or NOTHING.
 *
 * Every observer alert may carry an `excerpt` the prompt defines as "a short
 * verbatim quote of the SCHOLAR's own words", with "no genuine quote → omit the
 * whole signal". Enforce that here rather than trusting it: an excerpt that is
 * not literally present in a real scholar turn is dropped, so a teacher can
 * never be shown invented or tutor-authored words inside quote marks attributed
 * to a child. A quote from a dictated turn is kept but labelled — see
 * SPOKEN_EXCERPT_NOTE. Summary, severity and the session deep link are
 * unaffected either way, so the alert still reaches a human with its substance.
 */
function alertExcerptLines(
  kind: string,
  // Alert objects are a pure passthrough on the parse boundary, so this is raw
  // model output — typed loosely on purpose; the guard does the narrowing.
  excerpt: unknown,
  chatHistory: ObserverHistoryMessage[],
): string[] {
  const grounded = groundAlertExcerpt(excerpt, chatHistory);
  if (!grounded) {
    if (typeof excerpt === "string" && excerpt.trim() !== "") {
      // Deliberately does not log the excerpt itself: it is unverified text
      // about a real child, and prod logs are a durable surface.
      console.error(
        `[Observer] ⚠️ Dropping ${kind} excerpt — not found verbatim in any scholar message`,
      );
    }
    return [];
  }
  const lines = [`> ${escapeSlackText(grounded.excerpt)}`];
  if (grounded.inputModality === "spoken") lines.push(SPOKEN_EXCERPT_NOTE);
  return lines;
}

// ─── Unified Observer Action ─────────────────────────────────────────

/**
 * Unified observer. Replaces both runObserverAnalysis and runDetailedAnalysis.
 * One Sonnet call produces: pulse scores, concept mastery, session signals,
 * seeds, and cross-domain connections.
 */
export const analyzeSession = internalAction({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    console.log(`[Observer] Starting analysis for project ${args.sessionId}`);

    // 0. Release the debounce window (TRA-152) before anything can early-return
    // below: the next assistant turn must open a fresh window whether or not
    // this run produces output. Also cancels a still-pending queued run when
    // this one was invoked directly (requestRecap). Non-fatal.
    try {
      await ctx.runMutation(internal.analysisHelpers.beginObserverRun, {
        sessionId: args.sessionId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Observer] beginObserverRun failed (non-fatal): ${msg}`);
    }

    // 1. Get project context
    const context = await ctx.runQuery(
      internal.sessionHelpers.getSessionContext,
      { sessionId: args.sessionId }
    );
    if (!context || context.chatHistory.length < 3) {
      console.log(`[Observer] Skipping — ${!context ? "no context" : `only ${context.chatHistory.length} messages (need 3)`}`);
      return null;
    }
    // Test-drive projects are teacher dry-runs; never write observer output
    // against them (would otherwise pollute the teacher's own dossier/mastery).
    if (context.isTestDrive) {
      console.log(`[Observer] Skipping — project is a test drive`);
      return null;
    }
    const origin = resolveObserverOrigin(context);
    const observerContext = { ...context, origin };
    const institutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: context.scholarId, principal: "scholar" },
    );
    console.log(`[Observer] Scholar: ${context.scholarName}, Project: "${context.title}", Messages: ${context.chatHistory.length}`);

    // Stamp every analyses row this run writes with the version of the tutor
    // prompt that's live in code (so the Quality Pulse can key signals to it).
    // Computed once per invocation — a pure hash, cheap, awaited here.
    const promptVersion = await computePromptVersion();

    // 2. Get scholar's current mastery observations (for supersession)
    const currentObservations = await ctx.runQuery(
      internal.masteryObservations.currentByScholar,
      { scholarId: context.scholarId }
    );

    // 3. Get active seeds
    const activeSeeds = await ctx.runQuery(internal.seeds.activeByScholar, {
      scholarId: context.scholarId,
    });
    const pendingSeeds = await ctx.runQuery(
      internal.seeds.pendingObserverByScholar,
      { scholarId: context.scholarId },
    );

    // 4. Get recent session signals
    const recentSignals = await ctx.runQuery(
      internal.sessionSignals.recentByScholar,
      { scholarId: context.scholarId, limit: 30 }
    );

    // 5. Resolve SCHOLAR-uploaded images to real Anthropic image blocks so the
    // (vision-capable) observer can SEE the kid's own work — e.g. a scratchpad
    // photo/scan of their handwritten steps — and spot misconceptions from the
    // actual work, not just its caption. Mirrors the tutor stream (http.ts):
    // resolve the storage URL, fetch + base64 via the shared
    // imageUrlToContentPart. ONLY scholar uploads (role "user", not a
    // tutor-generated illustration) become image blocks; tutor-generated
    // images stay described-as-text in the transcript. Any image that fails to
    // load simply falls back to text (buildObserverUserMessageBlocks handles it).
    const scholarImages = new Map<string, ImageContentPart>();
    // THE window the observer model reads this run — the same tail slice
    // `buildObserverTranscriptBlocks` renders (identical for a history shorter
    // than the limit, where both keep everything). Declared once and reused by
    // its three consumers — the image resolution just below (only fetch/base64
    // PNGs for turns that will actually be rendered), the alert recency gate
    // (§6.7a), and the watermark (§6.9) — so they can never drift onto
    // different views of the transcript.
    const recentHistory = observerTranscriptWindow(context.chatHistory);
    for (const m of recentHistory) {
      if (m.role !== "user" || m.generatedImage || !m.imageId) continue;
      if (scholarImages.has(m.imageId)) continue;
      const imageUrl = await ctx.runQuery(internal.files.getUrlInternal, {
        storageId: m.imageId as Id<"_storage">,
      });
      if (!imageUrl) continue;
      const part = await imageUrlToContentPart(imageUrl);
      if (part) scholarImages.set(m.imageId, part);
    }

    // 6. Call Claude Sonnet
    console.log(`[Observer] Calling observer model with context: ${currentObservations.length} existing observations, ${activeSeeds.length} active seeds, ${pendingSeeds.length} pending seeds, ${recentSignals.length} recent signals`);
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic();

    // Multimodal user message: preamble + transcript text, with scholar-upload
    // image blocks inlined at their turn (capped at the last 30 messages for cost).
    const userBlocks = buildObserverUserMessageBlocks(
      context.chatHistory,
      scholarImages,
      currentObservations,
      activeSeeds,
      recentSignals,
      observerContext,
      pendingSeeds,
    );
    const userTextChars = userBlocks.reduce(
      (n, b) => n + (b.type === "text" ? b.text.length : 0),
      0,
    );
    console.log(`[Observer] User message: ${userTextChars} chars text, ${scholarImages.size} scholar image(s)`);

    // Model is env-overridable so Opus can be A/B tested per-deployment without
    // a code change. Defaults to Sonnet (the cost/latency-sane baseline). Set
    // OBSERVER_MODEL in the Convex dashboard to MODELS.OPUS's value to opt in.
    // See evals/observer/ for the quality comparison that justifies the choice.
    const observerModel = process.env.OBSERVER_MODEL || MODELS.SONNET;
    console.log(`[Observer] Model: ${observerModel}`);

    let result: ParsedObserverResponse;
    try {
      const response = await anthropic.messages.create({
        model: observerModel,
        max_tokens: 4096,
        // Prompt-cache the static prefix: the breakpoint on the system block
        // also caches the (identical, preceding) tools array, so only the
        // per-run transcript is re-billed. Helps whenever observer runs cluster
        // within the cache TTL (active class time). Below the model's cache
        // minimum it's a harmless no-op.
        system: [
          {
            type: "text",
            text: buildObserverSystemPrompt(context.institutionProfile),
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [OBSERVER_TOOL],
        tool_choice: { type: "tool", name: "record_observations" },
        messages: [{ role: "user", content: userBlocks }],
      });

      console.log(`[Observer] ${observerModel} response, usage: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out, stop_reason: ${response.stop_reason}`);
      await recordAnthropicUsage(ctx, {
        source: "observer",
        role: ROLES.SCHOLAR,
        model: observerModel,
        usage: response.usage,
        sessionId: args.sessionId,
        institutionId,
      });

      const parsed = parseObserverResponse(response.content);
      if (!parsed) {
        // No tool_use block — nothing to act on. Persist nothing so the prior
        // good analysis stays latest.
        console.error(`[Observer] No tool_use block — persisting nothing. Content types: ${response.content.map((b) => b.type).join(", ")}, stop_reason: ${response.stop_reason}`);
        return null;
      }
      if (!parsed.pulse) {
        // Degraded pulse (missing / no usable summary). We still raise alerts
        // and write observations/signals/connections/seeds below; only the
        // pulse write is skipped (a neutral 0.5 fallback would supersede the
        // prior good analysis and skew the roster trend).
        console.error(`[Observer] Degraded pulse — skipping pulse write, keeping other output. Content types: ${response.content.map((b) => b.type).join(", ")}, stop_reason: ${response.stop_reason}`);
      }
      result = parsed;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Observer] Observer API FAILED: ${message}`);
      console.error(`[Observer] Error details:`, JSON.stringify(err, null, 2).slice(0, 1000));
      return null;
    }

    if (result.pulse) {
      console.log(`[Observer] Parsed OK — pulse: ${result.pulse.pulseScore}/5, "${result.pulse.summary}"`);
    }
    console.log(`[Observer]   ${result.observations.length} observations, ${result.sessionSignals.length} signals, ${result.crossDomainConnections.length} connections, ${result.seeds.length} seeds`);
    for (const obs of result.observations) {
      console.log(`[Observer]   📊 ${obs.conceptLabel} (${obs.domain}): ${obs.masteryLevel.toFixed(1)} Bloom's, conf ${(obs.confidenceScore * 100).toFixed(0)}%, ${obs.evidenceType}${obs.supersedesObservationId ? ` [supersedes ${obs.supersedesObservationId}]` : ""}`);
    }
    for (const seed of result.seeds) {
      console.log(`[Observer]   🌱 ${seed.suggestionType}: "${seed.topic}" (${seed.domain ?? "general"})`);
    }

    // 6.5 Welfare/safety alert — route an IMMEDIATE human alert when the
    // observer flags a possible ongoing-harm disclosure. Done BEFORE the
    // mastery/seed writes so a later write failure can never swallow it.
    // Fire-and-forget (raiseAlert never throws); deduped per scholar+session
    // so an ongoing situation re-detected each exchange alerts once, not
    // every turn. Test drives already returned above, so this never fires
    // on a teacher dry-run.
    if (result.safetyAlert) {
      const sa = result.safetyAlert;
      const deepLink = withBase(
        siteUrl(),
        sessionPath(args.sessionId, context.scholarId),
      );
      const body = [
        escapeSlackText(sa.summary),
        ...alertExcerptLines("welfare", sa.excerpt, context.chatHistory),
        sa.category ? `Category: ${escapeSlackText(sa.category)}` : null,
        `Session: "${escapeSlackText(context.title)}"`,
      ]
        .filter(Boolean)
        .join("\n");
      try {
        await ctx.runMutation(internal.alerts.raise, {
          kind: "welfare",
          severity: sa.severity,
          source: "observer",
          audience: "institution",
          title: `Welfare disclosure — ${escapeSlackText(context.scholarName ?? "a scholar")}`,
          body,
          scholarId: context.scholarId as Id<"users">,
          sessionId: args.sessionId,
          deepLink,
          dedupKey: `welfare:${context.scholarId}:${args.sessionId}`,
        });
        console.log(`[Observer] 🚨 Safety alert raised (${sa.severity}) for ${context.scholarName ?? context.scholarId}`);
      } catch (alertErr: unknown) {
        // Never let alerting break the analysis write path.
        const msg = alertErr instanceof Error ? alertErr.message : String(alertErr);
        console.error(`[Observer] Safety alert failed (non-fatal): ${msg}`);
      }
    }

    // 6.6 Social over-reliance (pro-human / anti-parasocial) — a SEPARATE,
    // LOWER-urgency producer on the same alert fabric. Rabbithole is a tool
    // meant to be outgrown; when a scholar leans on the tutor for connection
    // we want a teacher to gently notice. De-escalated vs. welfare:
    //   • severity is only info | warning (NEVER critical), so the alert
    //     renders with the calm ℹ️ / ⚠️ glyph — never the 🚨 red siren that
    //     #229 reserves for critical. It DOES post to #rabbithole-alerts (per
    //     Andy: don't be precious about the channel; reassess if it gets noisy)
    //     — info for emerging signs, warning for a sustained/strong pattern.
    //   • deduped per SCHOLAR + SEVERITY over several days (a slow pattern,
    //     not an emergency) so it never nags. Severity is part of the key on
    //     PURPOSE: an early `info` must NOT shadow a later escalating
    //     `warning` — that escalation is exactly what should re-post — while
    //     same-severity repeats still coalesce.
    // Rides the same isTestDrive early-return above, so a dry-run never writes.
    if (result.socialRelianceAlert) {
      const ra = result.socialRelianceAlert;
      const deepLink = withBase(
        siteUrl(),
        sessionPath(args.sessionId, context.scholarId),
      );
      const body = [
        escapeSlackText(ra.summary),
        ...alertExcerptLines("parasocial_reliance", ra.excerpt, context.chatHistory),
        `Session: "${escapeSlackText(context.title)}"`,
      ]
        .filter(Boolean)
        .join("\n");
      const PARASOCIAL_DEDUP_MS = 3 * 24 * 60 * 60 * 1000;
      try {
        await ctx.runMutation(internal.alerts.raise, {
          kind: "parasocial_reliance",
          severity: ra.severity,
          source: "observer",
          audience: "institution",
          title: `Connection note — ${escapeSlackText(context.scholarName ?? "a scholar")}`,
          body,
          scholarId: context.scholarId as Id<"users">,
          sessionId: args.sessionId,
          deepLink,
          dedupKey: `parasocial:${context.scholarId}:${ra.severity}`,
          dedupWindowMs: PARASOCIAL_DEDUP_MS,
        });
        console.log(`[Observer] 🫂 Connection note raised (${ra.severity}) for ${context.scholarName ?? context.scholarId}`);
      } catch (alertErr: unknown) {
        // Never let this low-urgency note break the analysis write path.
        const msg = alertErr instanceof Error ? alertErr.message : String(alertErr);
        console.error(`[Observer] Connection note failed (non-fatal): ${msg}`);
      }
    }

    // 6.7 Stuck / going in circles — a THIRD, low-urgency producer on the same
    // alert fabric. The observer flags this ONLY when a scholar is genuinely
    // spinning (no progress across several turns), NEVER for healthy productive
    // struggle — which is the whole point of the tutor. Calm ℹ️/⚠️ (never 🚨),
    // deduped per SCHOLAR + SESSION so one stuck session pings once, not every
    // exchange. Rides the same isTestDrive early-return, so a dry-run never fires.
    //
    // Precedence: NONE. `overwhelmAlert` (6.8) used to win outright, which let
    // one bad overwhelm delete an accurate stuck signal in prod. Both alerts now
    // stand on their own evidence and neither suppresses the other — the
    // reasoning, and the mandatory-quote rule that gates each of them, live in
    // `resolveChatAlerts`.
    // 6.7a Recency bound — the OTHER half of the same prod failure. A session
    // runs for days while the observer re-reads a fixed transcript window on
    // every run, so an old moment stays permanently re-readable and nothing in
    // the payload dates it. On the session above, day 8 re-read the day-3
    // moment and shipped a teacher a distress card about last week.
    //
    // The bound is "new since we last ALERTED", not "younger than N days":
    // `alertEvidenceThrough` is the newest turn the last pass that actually
    // raised a conversational alert on this session had read (§6.9), so there
    // is no threshold to calibrate (T6). An alert is dropped ONLY when its
    // quote resolves to scholar turns that were ALL already read by that
    // alerting pass. No quote, an unmatched quote, an undateable turn, or no
    // previously-alerted pass all keep the alert — the gate never suppresses
    // on a guess. Scoped to these two conversational alerts alone: welfare and
    // parasocial keep their full window (see `resolveChatAlertRecency`), and
    // every non-alert observer output below is untouched.
    //
    // Classified against `recentHistory` — the window the model ACTUALLY read —
    // not the full history. A quote can only come from what the model saw, so
    // restricting the search cannot hide a real repeat; what it does prevent is
    // an aged-out older turn the model never saw supplying the "already read"
    // proof for a quote taken from a turn inside the window. That would
    // suppress on evidence the pass never considered, which is the one
    // direction this gate promises never to err in.
    const alertRecency = resolveChatAlertRecency(
      result,
      recentHistory,
      context.alertEvidenceThrough,
    );
    const chatAlerts = resolveChatAlerts(result);
    const raiseStuck = chatAlerts.raiseStuck && alertRecency.stuck !== "stale";
    const raiseOverwhelm =
      chatAlerts.raiseOverwhelm && alertRecency.overwhelm !== "stale";
    if (result.stuckAlert && !chatAlerts.raiseStuck) {
      console.log(`[Observer] 🌀 Stuck note dropped — no scholar quote to substantiate it`);
    } else if (result.stuckAlert && !raiseStuck) {
      console.log(`[Observer] 🌀 Stuck note dropped — its quote is from a turn a previous run already read`);
    }
    if (result.overwhelmAlert && !chatAlerts.raiseOverwhelm) {
      console.log(`[Observer] 😫 Overwhelm note dropped — no scholar quote to substantiate it`);
    } else if (result.overwhelmAlert && !raiseOverwhelm) {
      console.log(`[Observer] 😫 Overwhelm note dropped — its quote is from a turn a previous run already read`);
    }
    // Whether either conversational alert actually REACHED the alert fabric
    // this pass — the condition the watermark (§6.9) records on.
    let conversationalAlertFired = false;
    if (result.stuckAlert && raiseStuck) {
      const st = result.stuckAlert;
      const deepLink = withBase(
        siteUrl(),
        sessionPath(args.sessionId, context.scholarId),
      );
      const body = [
        escapeSlackText(st.summary),
        ...alertExcerptLines("chat_stuck", st.excerpt, context.chatHistory),
        `Session: "${escapeSlackText(context.title)}"`,
      ]
        .filter(Boolean)
        .join("\n");
      try {
        await ctx.runMutation(internal.alerts.raise, {
          kind: "chat_stuck",
          severity: st.severity,
          source: "observer",
          audience: "institution",
          title: `Going in circles — ${escapeSlackText(context.scholarName ?? "a scholar")}`,
          body,
          scholarId: context.scholarId as Id<"users">,
          sessionId: args.sessionId,
          deepLink,
          dedupKey: `chat_stuck:${context.scholarId}:${args.sessionId}`,
        });
        conversationalAlertFired = true;
        console.log(`[Observer] 🌀 Stuck note raised (${st.severity}) for ${context.scholarName ?? context.scholarId}`);
      } catch (alertErr: unknown) {
        // Never let this low-urgency note break the analysis write path.
        const msg = alertErr instanceof Error ? alertErr.message : String(alertErr);
        console.error(`[Observer] Stuck note failed (non-fatal): ${msg}`);
      }
    }

    // 6.8 Overwhelm / asked to stop — a FOURTH producer on the same fabric, and
    // the affective twin of 6.7: `chat_stuck` is the WORK going nowhere, this is
    // the SCHOLAR wanting out. It deliberately fires even when the tutor
    // de-escalated and the session recovered — the case 6.7 omits by design
    // (it requires the difficulty to be unresolved at the end of the
    // transcript), which is exactly why a recovered wall is invisible without
    // it. Calm 😫 rather than a severity glyph: asking to stop is a feeling, not
    // a failure. Deduped per SCHOLAR + SESSION. Rides the same isTestDrive
    // early-return, so a dry-run never fires.
    if (result.overwhelmAlert && raiseOverwhelm) {
      const ov = result.overwhelmAlert;
      const deepLink = withBase(
        siteUrl(),
        sessionPath(args.sessionId, context.scholarId),
      );
      const body = [
        escapeSlackText(ov.summary),
        ...alertExcerptLines("chat_overwhelm", ov.excerpt, context.chatHistory),
        `Session: "${escapeSlackText(context.title)}"`,
      ]
        .filter(Boolean)
        .join("\n");
      try {
        await ctx.runMutation(internal.alerts.raise, {
          kind: "chat_overwhelm",
          severity: ov.severity,
          source: "observer",
          audience: "institution",
          title: `Asked to stop — ${escapeSlackText(context.scholarName ?? "a scholar")}`,
          body,
          scholarId: context.scholarId as Id<"users">,
          sessionId: args.sessionId,
          deepLink,
          // Severity is part of the key (same rationale as `parasocial_reliance`
          // above): an early `info` must not shadow a later escalation to
          // `warning` for the same session within the dedup window — the
          // observer runs repeatedly across a session (see
          // sessionHelpers.finalizeStream), and the escalation is exactly what
          // should re-post.
          dedupKey: `chat_overwhelm:${context.scholarId}:${args.sessionId}:${ov.severity}`,
        });
        conversationalAlertFired = true;
        console.log(`[Observer] 😫 Overwhelm note raised (${ov.severity}) for ${context.scholarName ?? context.scholarId}`);
      } catch (alertErr: unknown) {
        // Never let this low-urgency note break the analysis write path.
        const msg = alertErr instanceof Error ? alertErr.message : String(alertErr);
        console.error(`[Observer] Overwhelm note failed (non-fatal): ${msg}`);
      }
    }

    // 6.9 Advance the alerting watermark — ONLY on a pass that actually raised
    // a conversational alert. The gate's job is "don't re-alert on evidence
    // that predates your last raised alert for this session", and marking on
    // every pass would quietly convert "read" into "implicitly cleared": the
    // observer runs after essentially every exchange, so an every-pass mark
    // leaves only the newest turn or two ever counting as fresh, and a spiral
    // that becomes legible in retrospect — where the model rightly quotes the
    // earlier, most representative turn — would be suppressed even though no
    // alert was ever raised about it. Under fire-only marking a session that
    // never alerted has no watermark and the gate is inert (exactly the
    // pre-gate behavior); the prod incident is still caught (the day-3 stuck
    // alert set the mark, so the day-8 re-read is stale); and a severity
    // escalation must cite new evidence to re-post, which is correct.
    //
    // "Fired" means the `alerts.raise` mutation succeeded — a raise that threw
    // reached no teacher, and marking on it would suppress the retry. Monotonic
    // and non-fatal: a failure here can only widen the next run's window.
    //
    // Taken from `recentHistory` for the same reason §6.7a classifies against
    // it: the mark must describe what this pass CONSIDERED, and the pass
    // considered the model's window. (Today the two agree — history is ordered
    // ascending by `_creationTime`, so the newest turn is always inside the
    // tail slice — but that is a property of the query, not of this call site,
    // and a mark computed off a turn the pass never read would over-suppress
    // every later run.)
    const watermark = conversationalAlertFired
      ? alertEvidenceWatermark(recentHistory)
      : null;
    if (watermark !== null) {
      try {
        await ctx.runMutation(internal.analysisHelpers.recordAlertEvidenceThrough, {
          sessionId: args.sessionId,
          through: watermark,
        });
      } catch (markErr: unknown) {
        const msg = markErr instanceof Error ? markErr.message : String(markErr);
        console.error(`[Observer] Alert watermark update failed (non-fatal): ${msg}`);
      }
    }

    // 7–11. Write all results to DB
    try {
      // 7. Pulse — skipped when degraded (null): a neutral 0.5 fallback would
      // supersede the prior good analysis and skew the roster trend. Every
      // other observer output below is still written.
      if (result.pulse) {
        console.log(`[Observer] Writing pulse...`);
        await ctx.runMutation(internal.analysisHelpers.saveAnalysis, {
          sessionId: args.sessionId,
          engagementScore: result.pulse.engagementScore,
          complexityLevel: result.pulse.complexityLevel,
          onTaskScore: result.pulse.onTaskScore,
          topics: result.pulse.topics,
          learningIndicators: result.pulse.learningIndicators,
          concernFlags: result.pulse.concernFlags,
          summary: result.pulse.summary,
          pulseScore: result.pulse.pulseScore,
          promptVersion,
          // Talk judgment (TRA-515): the grade of the language used, spoken turns
          // included, counted over the window the model actually read.
          // saveAnalysis drops it below the word floor or if it isn't a grade.
          ...(result.talkLevel
            ? {
                talkLevel: result.talkLevel,
                scholarWords: scholarWordCount(recentHistory),
              }
            : {}),
        });
        console.log(`[Observer] Pulse written OK`);
      }

      // 8. Mastery observations (collect IDs for standards mapper)
      const newObservationIds: Id<"masteryObservations">[] = [];
      for (let i = 0; i < result.observations.length; i++) {
        const obs = result.observations[i];
        // Date the observation by the scholar turn that evidences it, not by
        // this run (TRA-101): the same turn is re-derived on many runs across a
        // multi-day session, and a `now()` stamp on each restamps week-old
        // evidence as new. Falls back to now when nothing grounds — no
        // threshold, no guess. Resolved against `recentHistory`, the window the
        // model actually read.
        const evidenceAt = resolveObservationEvidenceTime(obs, recentHistory);
        console.log(`[Observer] Writing observation ${i + 1}/${result.observations.length}: ${obs.conceptLabel}${evidenceAt !== null ? ` (evidence ${new Date(evidenceAt).toISOString()})` : " (evidence undated → now)"}`);
        const obsId = await ctx.runMutation(internal.masteryObservations.record, {
          scholarId: context.scholarId,
          conceptLabel: obs.conceptLabel,
          domain: obs.domain,
          sessionId: args.sessionId,
          transcriptExcerpt: obs.transcriptExcerpt || "",
          masteryLevel: obs.masteryLevel,
          confidenceScore: obs.confidenceScore,
          evidenceSummary: obs.evidenceSummary,
          evidenceType: obs.evidenceType || "direct_demonstration",
          attemptContext: obs.attemptContext || "conversation",
          studentInitiated: obs.studentInitiated ?? false,
          standardNotations: obs.standardNotations ?? undefined,
          supersedesObservationId: obs.supersedesObservationId ?? undefined,
          observedAt: evidenceAt ?? undefined,
          // Automaticity — only if the observer rated it (it omits for most);
          // a valid reading is 1–3, anything else is dropped.
          fluencyLevel:
            obs.fluencyLevel && obs.fluencyLevel >= 1 && obs.fluencyLevel <= 3
              ? obs.fluencyLevel
              : undefined,
          pcmDimension: obs.pcmDimension ?? undefined,
        });
        newObservationIds.push(obsId);
      }

      // 9. Session signals
      let writtenSignals = 0;
      for (const signal of result.sessionSignals) {
        if (!sessionSignalTypes.has(signal.signalType)) {
          console.warn(
            `[Observer] ⚠️ Skipping signal with unknown signalType "${signal.signalType}"`,
          );
          continue;
        }
        const groundedEvidence = groundSessionSignalEvidence(
          signal,
          context.chatHistory,
        );
        if (!groundedEvidence) {
          console.error(
            `[Observer] ⚠️ Skipping signal "${signal.signalType}": sourceMessageId does not identify a non-empty scholar message`,
          );
          continue;
        }
        await ctx.runMutation(internal.sessionSignals.record, {
          scholarId: context.scholarId,
          sessionId: args.sessionId,
          signalType: signal.signalType,
          description: signal.description,
          intensity: signal.intensity,
          transcriptExcerpt: groundedEvidence.transcriptExcerpt,
          pcmDimension: signal.pcmDimension ?? undefined,
        });
        writtenSignals++;
      }
      console.log(`[Observer] ${writtenSignals}/${result.sessionSignals.length} signals written`);

      // 10. Cross-domain connections
      for (const conn of result.crossDomainConnections) {
        await ctx.runMutation(internal.crossDomainConnections.record, {
          scholarId: context.scholarId,
          sessionId: args.sessionId,
          domains: conn.domains,
          conceptLabels: conn.conceptLabels,
          description: conn.description,
          studentInitiated: conn.studentInitiated ?? false,
          transcriptExcerpt: conn.transcriptExcerpt ?? undefined,
          pcmDimension: conn.pcmDimension ?? undefined,
        });
      }

      // 11. Seeds
      for (const seed of result.seeds) {
        await ctx.runMutation(internal.seeds.record, {
          scholarId: context.scholarId,
          sessionId: args.sessionId,
          topic: cleanSeedLabel(seed.topic),
          domain: seed.domain ?? undefined,
          suggestionType: seed.suggestionType || "frontier",
          rationale: seed.rationale || "",
          scholarInvitation: seed.invitation ?? undefined,
          approachHint: seed.approachHint ?? undefined,
          connectionTo: seed.connectionTo ?? undefined,
          currentBloomsLevel: seed.currentBloomsLevel ?? undefined,
          targetBloomsLevel: seed.targetBloomsLevel ?? undefined,
          refreshesSeedId: seed.refreshesSeedId ?? undefined,
        });
      }
      console.log(`[Observer] ${result.seeds.length} seeds written`);

      const incomingInterests = [];
      for (const interest of result.interests) {
        if (
          typeof interest.label !== "string" ||
          interest.label.trim() === "" ||
          typeof interest.how !== "string" ||
          !observerInterestHows.has(interest.how)
        ) {
          console.warn(
            "[Observer] ⚠️ Skipping malformed interest row from model output",
          );
          continue;
        }
        const proposedWords = interest.words?.trim();
        const groundedEvidence = groundSessionSignalEvidence(
          {
            sourceMessageId: interest.sourceMessageId,
            transcriptExcerpt: proposedWords,
          },
          context.chatHistory,
        );
        if (!groundedEvidence) {
          console.error(
            `[Observer] ⚠️ Skipping interest "${interest.label}": sourceMessageId does not identify a non-empty scholar message`,
          );
          continue;
        }
        const words =
          proposedWords &&
          proposedWords.length <= 200 &&
          groundedEvidence.transcriptExcerpt === proposedWords
            ? proposedWords
            : undefined;
        // The Origin line is computed from the session doc and is
        // authoritative: in an assigned session a "picked" row is the model
        // talking itself into ownership, so it lands as "menu" (engagement).
        const how =
          interest.how === "picked" && origin.kind === "assigned"
            ? ("menu" as const)
            : (interest.how as "said" | "picked" | "menu");
        incomingInterests.push({
          label: interest.label.trim(),
          how,
          ...(words ? { words } : {}),
        });
      }
      if (incomingInterests.length > 0) {
        await ctx.runMutation(internal.dossier.mergeObserverInterests, {
          scholarId: context.scholarId,
          sessionId: args.sessionId,
          at: Date.now(),
          incoming: incomingInterests,
        });
      }
      console.log(
        `[Observer] ${incomingInterests.length}/${result.interests.length} interests written`,
      );

      // 11.5 Granule attributions — evidence rows against the unit's
      // EQs/EUs. Keys are validated against the unit's actual granule
      // list (the model occasionally invents one); unknown keys are
      // dropped loudly. Phase comes from the activity's conversation
      // recipe so baseline/exit rows power the pre/post comparison.
      const attributions = result.granuleAttributions ?? [];
      if (attributions.length > 0 && context.unitId) {
        const validKeys = new Set((context.granules ?? []).map((g) => g.key));
        // Link misconception-blocked granules to the misconception
        // observation written above (matched by exact conceptLabel).
        const misconceptionIdByLabel = new Map<string, Id<"masteryObservations">>();
        result.observations.forEach((obs, i) => {
          if (obs.evidenceType === "misconception_signal") {
            misconceptionIdByLabel.set(obs.conceptLabel, newObservationIds[i]);
          }
        });
        const phase =
          context.activityRecipe === "baseline"
            ? ("baseline" as const)
            : context.activityRecipe === "exitTicket"
              ? ("exit" as const)
              : undefined;
        let written = 0;
        for (const attr of attributions) {
          if (!validKeys.has(attr.granuleKey)) {
            console.error(`[Observer] ⚠️ Dropping attribution with unknown granuleKey "${attr.granuleKey}"`);
            continue;
          }
          await ctx.runMutation(internal.granuleEvidence.record, {
            scholarId: context.scholarId,
            unitId: context.unitId,
            granuleKey: attr.granuleKey,
            assignmentId: context.assignmentId ?? undefined,
            sessionId: args.sessionId,
            outcome: attr.outcome,
            transcriptExcerpt: attr.transcriptExcerpt || "",
            evidenceSummary: attr.evidenceSummary || "",
            bloomLevel: attr.bloomLevel ?? undefined,
            misconceptionObservationId: attr.relatedConceptLabel
              ? misconceptionIdByLabel.get(attr.relatedConceptLabel)
              : undefined,
            phase,
          });
          written++;
        }
        console.log(`[Observer] ${written} granule attributions written${phase ? ` (phase: ${phase})` : ""}`);
      }

      // 12. Writing-derived grade-level estimate — INFO-ONLY (TRA-513).
      //
      // Shown under the Write row of the scholar profile; nothing promotes it
      // into the talk level. It may only be drawn from what the scholar TYPED:
      // dictated turns arrive as fluent, punctuated adult prose and would grade
      // the speech-to-text engine, not the child. So the typed word count comes
      // from the same `isTypedScholarText` filter the teacher-run estimator and
      // the Flesch-Kincaid trend use, over the window the model actually read;
      // `setReadingLevelSuggestion` refuses a sample under the floor and
      // validates the model's grade before storing it. Its freshness guard keeps
      // this hot path (after every tutor session) from thrashing the user doc.
      if (result.inferredReadingLevel) {
        const typedWords = typedScholarWordCount(recentHistory);
        const outcome = await ctx.runMutation(
          internal.scholars.setReadingLevelSuggestion,
          {
            scholarId: context.scholarId,
            suggestion: result.inferredReadingLevel,
            typedWords,
          },
        );
        if (outcome !== "skipped") {
          console.log(
            `[Observer] 📝 Writing-derived level estimate ${result.inferredReadingLevel} (${typedWords} typed words) → ${outcome}`,
          );
        }
      }

      // 13. Standards mapping (second pass — maps observations to curriculum standards)
      if (newObservationIds.length > 0) {
        try {
          await ctx.runAction(internal.standardsMapper.mapToStandards, {
            scholarId: context.scholarId,
            observationIds: newObservationIds,
          });
        } catch (mapErr: unknown) {
          // Non-fatal: standards mapping is supplementary
          const msg = mapErr instanceof Error ? mapErr.message : String(mapErr);
          console.error(`[Observer] Standards mapping failed (non-fatal): ${msg}`);
        }
      }
    } catch (writeErr: unknown) {
      const message = writeErr instanceof Error ? writeErr.message : String(writeErr);
      console.error(`[Observer] WRITE FAILED: ${message}`);
      console.error(`[Observer] Write error details:`, JSON.stringify(writeErr, null, 2).slice(0, 1000));
      throw writeErr;
    }

    // 14. Cold-start: once a brand-new scholar has harvested enough interest
    // signal (from the getting-to-know-you quest or any early session), chart
    // their FIRST interpretive sky so the star map lands populated, not blank.
    // Fire-once + floor-gated inside; non-fatal (the analysis already succeeded).
    try {
      await ctx.runMutation(internal.interpretiveHelpers.maybeChartFirstSky, {
        scholarId: context.scholarId,
      });
    } catch (chartErr: unknown) {
      const msg = chartErr instanceof Error ? chartErr.message : String(chartErr);
      console.error(`[Observer] Cold-start sky check failed (non-fatal): ${msg}`);
    }

    console.log(`[Observer] ✅ Done — all writes complete for project ${args.sessionId}`);
    return result;
  },
});
