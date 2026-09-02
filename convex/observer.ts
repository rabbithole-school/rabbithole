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
  OBSERVER_TRANSCRIPT_LIMIT,
  buildObserverUserMessageBlocks,
  groundSessionSignalEvidence,
  parseObserverResponse,
  type ParsedObserverResponse,
} from "./lib/observerShared";
import { imageUrlToContentPart, type ImageContentPart } from "./lib/imageBytes";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";

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
    // Only resolve images for the messages the transcript builder will actually
    // render (its last-OBSERVER_TRANSCRIPT_LIMIT window) — otherwise every
    // per-turn observer run re-fetches + base64-encodes PNGs that have aged out.
    const scholarImages = new Map<string, ImageContentPart>();
    const recentHistory = context.chatHistory.slice(-OBSERVER_TRANSCRIPT_LIMIT);
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
      context,
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
        sa.excerpt ? `> ${escapeSlackText(sa.excerpt)}` : null,
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
        ra.excerpt ? `> ${escapeSlackText(ra.excerpt)}` : null,
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
    // Precedence: `overwhelmAlert` (6.8) wins. The prompt asks the model to emit
    // at most one, but a model that emits both would otherwise ping a teacher
    // twice about one moment, so the tie is also broken here in code.
    if (result.stuckAlert && !result.overwhelmAlert) {
      const st = result.stuckAlert;
      const deepLink = withBase(
        siteUrl(),
        sessionPath(args.sessionId, context.scholarId),
      );
      const body = [
        escapeSlackText(st.summary),
        st.excerpt ? `> ${escapeSlackText(st.excerpt)}` : null,
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
    if (result.overwhelmAlert) {
      const ov = result.overwhelmAlert;
      const deepLink = withBase(
        siteUrl(),
        sessionPath(args.sessionId, context.scholarId),
      );
      const body = [
        escapeSlackText(ov.summary),
        ov.excerpt ? `> ${escapeSlackText(ov.excerpt)}` : null,
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
          // sessionHelpers.ts:1372-1375), and the escalation is exactly what
          // should re-post.
          dedupKey: `chat_overwhelm:${context.scholarId}:${args.sessionId}:${ov.severity}`,
        });
        console.log(`[Observer] 😫 Overwhelm note raised (${ov.severity}) for ${context.scholarName ?? context.scholarId}`);
      } catch (alertErr: unknown) {
        // Never let this low-urgency note break the analysis write path.
        const msg = alertErr instanceof Error ? alertErr.message : String(alertErr);
        console.error(`[Observer] Overwhelm note failed (non-fatal): ${msg}`);
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
        });
        console.log(`[Observer] Pulse written OK`);
      }

      // 8. Mastery observations (collect IDs for standards mapper)
      const newObservationIds: Id<"masteryObservations">[] = [];
      for (let i = 0; i < result.observations.length; i++) {
        const obs = result.observations[i];
        console.log(`[Observer] Writing observation ${i + 1}/${result.observations.length}: ${obs.conceptLabel}`);
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

      // 12. Writing-derived grade-level estimate.
      //
      // This used to write ONLY when the inferred value differed from the
      // confirmed level, which made agreement invisible: once later evidence
      // caught up with the teacher's setting, nothing was recorded, so a
      // weeks-old disagreement kept sitting on the profile looking current.
      //
      // The estimate is now always handed to `setReadingLevelSuggestion`, which
      // stores a disagreement, CLEARS a superseded one on agreement, and stamps
      // when the estimate was computed. That mutation carries its own freshness
      // guard, so this hot path (it runs after every tutor session) does not
      // thrash the scholar's user doc — an unchanged value inside the guard
      // window is a no-op.
      if (result.inferredReadingLevel) {
        const outcome = await ctx.runMutation(
          internal.scholars.setReadingLevelSuggestion,
          {
            scholarId: context.scholarId,
            suggestion: result.inferredReadingLevel,
          },
        );
        if (outcome !== "skipped") {
          console.log(
            `[Observer] 📝 Writing-derived level estimate ${result.inferredReadingLevel} → ${outcome}`,
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
