/**
 * PURE helpers for the weekly AI token-usage / cost report (no ctx, no node,
 * no Convex) — the deterministic twin of the Quality Pulse narrative. Reads
 * plain `usageEvents` rows (convex/usage.ts writes them) and produces:
 *   - a $ cost + token breakdown by SOURCE bucket (students / teachers /
 *     platform-admin / tutor / observer), INSTITUTION, and MODEL
 *   - the Slack-canvas markdown (the full report)
 *   - a short teaser (the #rabbithole-alerts message body)
 *
 * The source→bucket taxonomy lives HERE in one editable table (SOURCE_BUCKET +
 * bucketFromRole) so no call site bakes it in. The pricing rate card is also
 * here, keyed by the model ids in lib/models.ts.
 *
 * Unit-tested in convex/lib/__tests__/usageReport.test.ts.
 */
import {
  MODELS,
  GEMINI_IMAGE_MODEL,
  GEMINI_IMAGE_QUOTA_FALLBACK_MODEL,
  OPENAI_IMAGE_MODEL,
  openaiImageUsageKey,
} from "./models";

// ─── Pricing rate card ($ per 1M tokens) ────────────────────────────────────
// Verified from Anthropic's pricing page (2026-09-01). Sonnet 5's $2 / $10
// launch pricing is now the STANDARD price — the scheduled 2026-09-01 step up
// to $3 / $15 was cancelled, so the old "introductory through 2026-08-31"
// caveat is retired.
//
// Retired model ids stay in this table forever. `usageEvents` rows are
// immutable history keyed by the model id that actually served them, so
// deleting a row here silently reprices months of past spend to $0 (it lands
// in the report's "unpriced models" warning instead).
export interface ModelRate {
  label: string;
  input: number; // uncached input
  cacheWrite: number; // 5-min ephemeral cache write
  cacheWrite1h?: number; // 1-hour ephemeral cache write (2x input)
  cacheRead: number; // cache hit (read)
  output: number; // output (Fable: incl. always-on thinking)
  audioPerMinute?: number;
  charactersPerMillion?: number;
  imagePerImage?: number; // $ per generated image (non-token unit)
}

export const PRICING: Record<string, ModelRate> = {
  // Fable 5.1 matches Fable 5 on input/cache-write/output; its cache HITS are
  // 4x cheaper ($0.25 vs $1.00 — a 0.025x multiplier on base input, where
  // every other model uses 0.1x). That lands squarely on the aide, whose
  // whole system prompt + history is a cached prefix on every turn.
  [MODELS.FABLE]: { label: "Fable 5.1", input: 10, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
  // Retired 2026-09-01 (superseded by Fable 5.1) — kept so historical
  // usageEvents rows stay priced. See the table note above.
  "claude-fable-5": { label: "Fable 5", input: 10, cacheWrite: 12.5, cacheWrite1h: 20, cacheRead: 1.0, output: 50 },
  // Opus 5.5: $4 in / $20 out; 5m cache write 1.25x, cache hit $0.20 (0.05x).
  [MODELS.OPUS_5_5]: { label: "Opus 5.5", input: 4, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 },
  [MODELS.OPUS]: { label: "Opus 4.8", input: 5, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  [MODELS.SONNET]: { label: "Sonnet 5", input: 2, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
  [MODELS.SONNET_5_5]: { label: "Sonnet 5.5", input: 2, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
  [MODELS.HAIKU]: { label: "Haiku 4.5", input: 1, cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
  "whisper-1": {
    label: "Whisper",
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    audioPerMinute: 0.006,
  },
  "gpt-4o-transcribe": {
    label: "Realtime STT",
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    // OpenAI's own per-minute equivalence for gpt-4o-transcribe
    // (https://developers.openai.com/api/docs/pricing, checked 2026-08-03).
    audioPerMinute: 0.006,
  },
  "tts-1": {
    label: "TTS 1",
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    charactersPerMillion: 15,
  },
  "gpt-4o-mini-tts": {
    label: "GPT-4o mini TTS",
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    // Approximation verified 2026-08-03 against the official token rates:
    // $0.60/M text tokens + $12/M audio tokens. The speech endpoint does not
    // return token usage, so use OpenAI's published ~$0.015/audio-minute
    // estimate and 800 spoken characters/minute => $18.75/M characters.
    // https://developers.openai.com/api/docs/pricing
    charactersPerMillion: 18.75,
  },
  // Gemini image models (lib/gemini.ts → geminiGenerateImage), priced PER
  // IMAGE. Google bills image output by tokens, but publishes a per-image
  // equivalence for the default (1K/2K) resolution these call sites request —
  // use that as the per-image rate. Verified from Google's official Gemini API
  // pricing page (https://ai.google.dev/gemini-api/docs/pricing, checked
  // 2026-08-20).
  [GEMINI_IMAGE_MODEL]: {
    // Gemini 3 Pro Image ("Nano Banana Pro"). Image output $120/1M tokens;
    // a 1K–2K image = 1120 tokens = $0.134/image (4K = $0.24, not requested).
    label: "Gemini 3 Pro Image",
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    imagePerImage: 0.134,
  },
  [GEMINI_IMAGE_QUOTA_FALLBACK_MODEL]: {
    // Gemini 3.1 Flash Image ("Nano Banana 2"), the quota fallback. Image
    // output $60/1M tokens; a 1K image = 1120 tokens = $0.067/image.
    label: "Gemini 3.1 Flash Image",
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    imagePerImage: 0.067,
  },
  // The charm layer's image model (lib/openaiImage.ts), priced PER IMAGE like
  // the Gemini rows above, and keyed by QUALITY TIER as well as model — the
  // tier moves the price more than the model does. OpenAI bills tokens ($5/1M
  // text in, $30/1M image out) and publishes no per-image table, so these are
  // derived from this repo's OWN measured usage at 1024x1024, probed
  // 2026-09-15: a prompt costs ~260-330 text-input tokens (~$0.0015), and image
  // output is 196 tokens at "low" and 439 at "medium".
  [openaiImageUsageKey(OPENAI_IMAGE_MODEL, "low")]: {
    label: "GPT-Image-2.5 Flare (low)",
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    imagePerImage: 0.0074,
  },
  [openaiImageUsageKey(OPENAI_IMAGE_MODEL, "medium")]: {
    label: "GPT-Image-2.5 Flare (medium)",
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    imagePerImage: 0.0147,
  },
};

/** A human label for a model id (falls back to the raw id when unpriced). */
export function modelLabel(model: string): string {
  return PRICING[model]?.label ?? model;
}

// ─── Source → display-bucket taxonomy (edit HERE only) ───────────────────────

export type UsageBucket =
  | "tutor"
  | "observer"
  | "teachers"
  | "platform-admin"
  | "students"
  | "parents"
  | "voice"
  | "other";

/** Display order + labels for the report. */
export const BUCKET_ORDER: UsageBucket[] = [
  "students",
  "teachers",
  "platform-admin",
  "tutor",
  "observer",
  "voice",
  "parents",
  "other",
];

export const BUCKET_LABEL: Record<UsageBucket, string> = {
  tutor: "Tutor",
  observer: "Observer",
  teachers: "Teachers",
  "platform-admin": "Platform-admin",
  students: "Students",
  parents: "Parents",
  voice: "Voice",
  other: "Other / system",
};

/**
 * Sources whose bucket depends on WHO triggered them (the staff-aide surfaces
 * a teacher OR a platform-admin can drive) — bucketed by the recorded role.
 */
const ROLE_DEPENDENT = new Set<string>([
  "aide-chat",
  "meta-chat",
  "slack-aide",
  // A teacher rehearsing an activity through the tutor stream (isTestDrive).
  // Staff spend, so it stays out of the Tutor row.
  "tutor-test-drive",
]);

/**
 * Explicit source → bucket map. Sources with an intrinsic bucket regardless of
 * the triggering role. Anything not listed (and not role-dependent) falls back
 * to bucketFromRole, then "other". Keep this the single source of truth.
 */
const SOURCE_BUCKET: Record<string, UsageBucket> = {
  // Pipeline stages that operate on a scholar session but aren't a principal.
  tutor: "tutor",
  observer: "observer",
  "meta-observer": "observer",
  // Curriculum authoring / staff generation → teachers.
  "curriculum-bot": "teachers",
  "curriculum-sim": "teachers",
  "curriculum-bake": "teachers",
  "standards-mapper": "teachers",
  "criteria-gen": "teachers",
  "chat-title": "teachers",
  "class-digest": "teachers",
  "share-back": "teachers",
  "scholar-doc-proposal": "teachers",
  "scholar-document-extract": "teachers",
  "scholar-document-redact": "teachers",
  "portfolio-caption": "teachers",
  "portfolio-intake": "teachers",
  "portfolio-segments": "teachers",
  "magic-annotation": "teachers",
  // Scholar-triggered, non-tutor generation → students.
  "session-reflection": "students",
  "session-title": "students",
  "deliverable-assess": "students",
  "granule-assess": "students",
  "rubric-check": "students",
  "mastery-rederive": "students",
  understandings: "students",
  "open-map": "students",
  interpretive: "students",
  "web-activity-summary": "students",
  "reading-level": "students",
  grapheme: "students",
  "bake-paths": "students",
  // System / platform tooling.
  "quality-pulse": "platform-admin",
  // Scholar-facing image generation → tutor.
  "tutor-image": "tutor",
  // "Make a picture" in the slides editor. Deliberately NOT bucketed with
  // "tutor": a scholar spends this directly from the editor, and folding it in
  // would inflate the tutor's apparent cost with spend the tutor never made.
  "slide-illustration": "students",
  // Staff / system image generation (Gemini image model). "magic-annotation"
  // (above) also covers its image-redraw rows.
  "badge-art": "teachers",
  "theme-icon": "teachers",
  "special-delivery-image": "teachers",
  "marketing-image": "other",
  "wonder-portrait": "other",
  // OpenAI speech input/output.
  "whisper-transcription": "voice",
  "realtime-transcription": "voice",
  tts: "voice",
  // Parent-facing.
  "parent-chat": "parents",
};

/** Map a principal role string to a display bucket. */
export function bucketFromRole(role: string | null | undefined): UsageBucket {
  switch (role) {
    case "scholar":
      return "students";
    case "teacher":
    case "curriculum_designer":
    case "staff":
    case "school_admin":
      return "teachers";
    case "platform_admin":
      return "platform-admin";
    case "parent":
      return "parents";
    default:
      return "other";
  }
}

/**
 * The one place (source, role) → display bucket is decided. Role-dependent
 * staff surfaces bucket by role; everything else uses the explicit map, then
 * falls back to the role, then "other". Prefix fallbacks keep new
 * `portfolio-*` / `scholar-document-*` / `curriculum-*` sources sane.
 */
export function bucketFor(source: string, role: string | null | undefined): UsageBucket {
  if (ROLE_DEPENDENT.has(source)) return bucketFromRole(role);
  const explicit = SOURCE_BUCKET[source];
  if (explicit) return explicit;
  if (source.startsWith("curriculum-") || source.startsWith("portfolio-") || source.startsWith("scholar-document-")) {
    return "teachers";
  }
  const byRole = bucketFromRole(role);
  return byRole;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/** A plain usageEvents row (what the report query hands the pure computer). */
export interface UsageEventRow {
  source: string;
  role?: string | null;
  institutionId?: string | null;
  model: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  cacheReadTokens: number;
  outputTokens: number;
  audioSeconds?: number;
  characters?: number;
  images?: number;
  // Grouping key only — never rendered. Voice transport health is a per-SESSION
  // question ("did this kid's whole session run degraded?"), which the call
  // counts in `byModel` cannot answer. See the voice-transport block below.
  sessionId?: string | null;
  createdAt: number;
}

// ─── Voice transport health ──────────────────────────────────────────────────
//
// Scholar dictation has two transports: the OpenAI Realtime API
// (`realtime-transcription`) and a Whisper fallback (`whisper-transcription`).
// The fallback is STICKY — one transport failure downgrades every remaining
// turn in that session (hooks/useStreamingDictation.ts sets
// `streamingDisabledRef` and never clears it), so the honest unit is the
// SESSION, not the turn. The `By model` table below already shows both models'
// call counts; what it cannot show is that those calls piled into one kid's
// whole session. That per-session transport mix is the variable this section
// adds, and nothing else in the report or the app encodes it.
const VOICE_REALTIME_SOURCE = "realtime-transcription";
const VOICE_WHISPER_SOURCE = "whisper-transcription";

export interface VoiceTransportSummary {
  /** Sessions with at least one voice row of either transport. */
  sessions: number;
  /** Realtime the whole way — the healthy path. */
  realtimeOnly: number;
  /** Started on realtime, fell back to Whisper part-way. */
  fellBack: number;
  /** Only ever Whisper — realtime never established for this session. */
  neverRealtime: number;
  realtimeTurns: number;
  whisperTurns: number;
}

export interface TokenTotals {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

function zeroTotals(): TokenTotals {
  return {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  };
}

function addInto(acc: TokenTotals, row: UsageEventRow): void {
  acc.inputTokens += row.inputTokens;
  acc.cacheWriteTokens += row.cacheWriteTokens;
  acc.cacheWrite1hTokens += row.cacheWrite1hTokens ?? 0;
  acc.cacheReadTokens += row.cacheReadTokens;
  acc.outputTokens += row.outputTokens;
}

/** Dollar cost of a token breakdown for one model (0 when unpriced). */
export function costOf(
  model: string,
  t: Omit<TokenTotals, "cacheWrite1hTokens"> & {
    cacheWrite1hTokens?: number;
  },
  units?: Pick<UsageEventRow, "audioSeconds" | "characters" | "images">,
): number {
  const rate = PRICING[model];
  if (!rate) return 0;
  const tokenCost =
    (t.inputTokens * rate.input +
      t.cacheWriteTokens * rate.cacheWrite +
      // The 1h subset is already counted at the 5m rate above; add the premium.
      (t.cacheWrite1hTokens ?? 0) *
        ((rate.cacheWrite1h ?? rate.cacheWrite) - rate.cacheWrite) +
      t.cacheReadTokens * rate.cacheRead +
      t.outputTokens * rate.output) /
    1_000_000;
  const audioCost = ((units?.audioSeconds ?? 0) / 60) * (rate.audioPerMinute ?? 0);
  const characterCost =
    ((units?.characters ?? 0) / 1_000_000) * (rate.charactersPerMillion ?? 0);
  const imageCost = (units?.images ?? 0) * (rate.imagePerImage ?? 0);
  return tokenCost + audioCost + characterCost + imageCost;
}

export interface BucketRow {
  bucket: UsageBucket;
  label: string;
  cost: number;
  priorCost: number;
  deltaPct: number | null; // null when prior is 0 (no baseline)
  tokens: number; // total tokens (all four dims) this window
  calls: number;
}

export interface ModelRow {
  model: string;
  label: string;
  priced: boolean;
  cost: number;
  totals: TokenTotals;
  calls: number;
}

export interface InstitutionRow {
  institutionId: string | null;
  label: string;
  estimatedCost: number;
  totals: TokenTotals;
  calls: number;
}

export interface UsageReport {
  windowStart: number;
  windowEnd: number;
  eventCount: number;
  totalCost: number;
  priorTotalCost: number;
  totalDeltaPct: number | null;
  byBucket: BucketRow[]; // nonzero buckets, descending cost
  byInstitution: InstitutionRow[]; // nonzero institutions + unattributed, descending cost
  byModel: ModelRow[]; // nonzero models, descending cost
  unpricedModels: string[]; // models seen with no rate card entry
  totalTokens: TokenTotals;
  voice: VoiceTransportSummary; // per-session dictation transport mix
}

function pct(cur: number, prior: number): number | null {
  if (prior <= 0) return null;
  return ((cur - prior) / prior) * 100;
}

/**
 * Incremental aggregation so callers can fold arbitrarily many paginated pages
 * into a fixed-size accumulator (the weekly action pages a whole window through
 * this; tests fold a single array). Cost is summed per (bucket, model) so each
 * model's own rate applies, then rolled up to the bucket. Because `costOf` is
 * linear in tokens, folding row-by-row is numerically identical to costing the
 * aggregated totals — the one-shot array path and the paged path agree exactly.
 */
export interface UsageAccumulator {
  bucketCost: Map<UsageBucket, number>;
  bucketTokens: Map<UsageBucket, number>;
  bucketCalls: Map<UsageBucket, number>;
  modelTotals: Map<string, TokenTotals>;
  modelCost: Map<string, number>;
  modelCalls: Map<string, number>;
  institutionTotals: Map<string, TokenTotals>;
  institutionCost: Map<string, number>;
  institutionCalls: Map<string, number>;
  totalTokens: TokenTotals;
  unpriced: Set<string>;
  eventCount: number;
  /**
   * sessionId → per-transport turn counts, for voice rows only. Bounded by the
   * number of sessions that used voice in the window (a handful per week), not
   * by the row count, so it stays safe to fold a whole window through.
   */
  voiceBySession: Map<string, { realtime: number; whisper: number }>;
}

const UNATTRIBUTED_KEY = "__unattributed__";

export function createUsageAccumulator(): UsageAccumulator {
  return {
    bucketCost: new Map(),
    bucketTokens: new Map(),
    bucketCalls: new Map(),
    modelTotals: new Map(),
    modelCost: new Map(),
    modelCalls: new Map(),
    institutionTotals: new Map(),
    institutionCost: new Map(),
    institutionCalls: new Map(),
    totalTokens: zeroTotals(),
    unpriced: new Set(),
    eventCount: 0,
    voiceBySession: new Map(),
  };
}

/** Fold a batch of current-window rows into the accumulator (repeatable). */
export function accumulateUsage(acc: UsageAccumulator, rows: UsageEventRow[]): void {
  for (const row of rows) {
    const bucket = bucketFor(row.source, row.role);
    const t: TokenTotals = {
      inputTokens: row.inputTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      cacheWrite1hTokens: row.cacheWrite1hTokens ?? 0,
      cacheReadTokens: row.cacheReadTokens,
      outputTokens: row.outputTokens,
    };
    const cost = costOf(row.model, t, row);
    if (!PRICING[row.model]) acc.unpriced.add(row.model);

    acc.bucketCost.set(bucket, (acc.bucketCost.get(bucket) ?? 0) + cost);
    const tokens = t.inputTokens + t.cacheWriteTokens + t.cacheReadTokens + t.outputTokens;
    acc.bucketTokens.set(bucket, (acc.bucketTokens.get(bucket) ?? 0) + tokens);
    acc.bucketCalls.set(bucket, (acc.bucketCalls.get(bucket) ?? 0) + 1);

    let mt = acc.modelTotals.get(row.model);
    if (!mt) {
      mt = zeroTotals();
      acc.modelTotals.set(row.model, mt);
    }
    addInto(mt, row);
    acc.modelCost.set(row.model, (acc.modelCost.get(row.model) ?? 0) + cost);
    acc.modelCalls.set(row.model, (acc.modelCalls.get(row.model) ?? 0) + 1);

    const institutionKey = row.institutionId ?? UNATTRIBUTED_KEY;
    let institutionTotals = acc.institutionTotals.get(institutionKey);
    if (!institutionTotals) {
      institutionTotals = zeroTotals();
      acc.institutionTotals.set(institutionKey, institutionTotals);
    }
    addInto(institutionTotals, row);
    acc.institutionCost.set(
      institutionKey,
      (acc.institutionCost.get(institutionKey) ?? 0) + cost,
    );
    acc.institutionCalls.set(
      institutionKey,
      (acc.institutionCalls.get(institutionKey) ?? 0) + 1,
    );

    if (
      row.sessionId &&
      (row.source === VOICE_REALTIME_SOURCE || row.source === VOICE_WHISPER_SOURCE)
    ) {
      let mix = acc.voiceBySession.get(row.sessionId);
      if (!mix) {
        mix = { realtime: 0, whisper: 0 };
        acc.voiceBySession.set(row.sessionId, mix);
      }
      if (row.source === VOICE_REALTIME_SOURCE) mix.realtime += 1;
      else mix.whisper += 1;
    }

    addInto(acc.totalTokens, row);
    acc.eventCount += 1;
  }
}

/** Prior window only contributes cost + counts (for WoW deltas). */
export interface PriorAccumulator {
  bucketCost: Map<UsageBucket, number>;
  totalCost: number;
  count: number;
}

export function createPriorAccumulator(): PriorAccumulator {
  return { bucketCost: new Map(), totalCost: 0, count: 0 };
}

/** Fold a batch of prior-window rows (repeatable). */
export function accumulatePrior(acc: PriorAccumulator, rows: UsageEventRow[]): void {
  for (const row of rows) {
    const bucket = bucketFor(row.source, row.role);
    const cost = costOf(
      row.model,
      {
        inputTokens: row.inputTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        cacheWrite1hTokens: row.cacheWrite1hTokens ?? 0,
        cacheReadTokens: row.cacheReadTokens,
        outputTokens: row.outputTokens,
      },
      row,
    );
    acc.bucketCost.set(bucket, (acc.bucketCost.get(bucket) ?? 0) + cost);
    acc.totalCost += cost;
    acc.count += 1;
  }
}

export function finalizeInstitutionUsage(
  acc: UsageAccumulator,
  institutionLabels: ReadonlyMap<string, string> = new Map(),
): InstitutionRow[] {
  const rows: InstitutionRow[] = [];
  for (const [key, totals] of acc.institutionTotals) {
    const unattributed = key === UNATTRIBUTED_KEY;
    rows.push({
      institutionId: unattributed ? null : key,
      label: unattributed ? "Unattributed" : (institutionLabels.get(key) ?? key),
      estimatedCost: acc.institutionCost.get(key) ?? 0,
      totals,
      calls: acc.institutionCalls.get(key) ?? 0,
    });
  }
  rows.sort(
    (a, b) =>
      b.estimatedCost - a.estimatedCost || a.label.localeCompare(b.label),
  );
  return rows;
}

/** Roll the per-session voice mix up into the four session counts + turn totals. */
function summarizeVoiceTransport(acc: UsageAccumulator): VoiceTransportSummary {
  const summary: VoiceTransportSummary = {
    sessions: 0,
    realtimeOnly: 0,
    fellBack: 0,
    neverRealtime: 0,
    realtimeTurns: 0,
    whisperTurns: 0,
  };
  for (const mix of acc.voiceBySession.values()) {
    summary.sessions += 1;
    summary.realtimeTurns += mix.realtime;
    summary.whisperTurns += mix.whisper;
    if (mix.whisper === 0) summary.realtimeOnly += 1;
    else if (mix.realtime === 0) summary.neverRealtime += 1;
    else summary.fellBack += 1;
  }
  return summary;
}

/** Build the final report shape from folded current + prior accumulators. */
export function finalizeUsageReport(
  acc: UsageAccumulator,
  prior: PriorAccumulator,
  windowStart: number,
  windowEnd: number,
  institutionLabels: ReadonlyMap<string, string> = new Map(),
): UsageReport {
  const byBucket: BucketRow[] = [];
  for (const bucket of BUCKET_ORDER) {
    const cost = acc.bucketCost.get(bucket) ?? 0;
    const priorCost = prior.bucketCost.get(bucket) ?? 0;
    if (cost === 0 && priorCost === 0) continue;
    byBucket.push({
      bucket,
      label: BUCKET_LABEL[bucket],
      cost,
      priorCost,
      deltaPct: pct(cost, priorCost),
      tokens: acc.bucketTokens.get(bucket) ?? 0,
      calls: acc.bucketCalls.get(bucket) ?? 0,
    });
  }
  byBucket.sort((a, b) => b.cost - a.cost);

  const byModel: ModelRow[] = [];
  for (const [model, totals] of acc.modelTotals) {
    byModel.push({
      model,
      label: modelLabel(model),
      priced: !!PRICING[model],
      cost: acc.modelCost.get(model) ?? 0,
      totals,
      calls: acc.modelCalls.get(model) ?? 0,
    });
  }
  byModel.sort((a, b) => b.cost - a.cost);

  const totalCost = byModel.reduce((s, m) => s + m.cost, 0);

  return {
    windowStart,
    windowEnd,
    eventCount: acc.eventCount,
    totalCost,
    priorTotalCost: prior.totalCost,
    totalDeltaPct: pct(totalCost, prior.totalCost),
    byBucket,
    byInstitution: finalizeInstitutionUsage(acc, institutionLabels),
    byModel,
    unpricedModels: [...acc.unpriced].sort(),
    totalTokens: acc.totalTokens,
    voice: summarizeVoiceTransport(acc),
  };
}

/**
 * One-shot convenience over the fold API: aggregate a full window of events (+
 * the prior window for WoW deltas) from in-memory arrays. Pure — the caller
 * supplies the already-fetched rows. The weekly action instead pages the
 * windows through the fold API directly so it never materializes a whole window.
 */
export function computeUsageReport(args: {
  events: UsageEventRow[];
  priorEvents: UsageEventRow[];
  windowStart: number;
  windowEnd: number;
  institutionLabels?: ReadonlyMap<string, string>;
}): UsageReport {
  const acc = createUsageAccumulator();
  accumulateUsage(acc, args.events);
  const prior = createPriorAccumulator();
  accumulatePrior(prior, args.priorEvents);
  return finalizeUsageReport(
    acc,
    prior,
    args.windowStart,
    args.windowEnd,
    args.institutionLabels,
  );
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** $1,234.56 (always 2dp; $0.00 for zero). */
export function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact integer with thousands separators. */
export function int(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "1.2M" / "34.5K" / "512" — compact token counts for dense tables. */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/** "▲ 12%" / "▼ 8%" / "—" (no prior baseline) / "flat". */
export function deltaStr(deltaPct: number | null): string {
  if (deltaPct === null) return "—";
  const r = Math.round(deltaPct);
  if (r === 0) return "flat";
  return r > 0 ? `▲ ${r}%` : `▼ ${Math.abs(r)}%`;
}

function ymd(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** The short #rabbithole-alerts teaser (the alert body when no canvas link). */
export function renderUsageTeaser(r: UsageReport): string {
  if (r.eventCount === 0) {
    return `No AI usage recorded in the last 7 days (${ymd(r.windowStart)} → ${ymd(r.windowEnd)}).`;
  }
  const top = r.byBucket
    .slice(0, 3)
    .map((b) => `${b.label} ${usd(b.cost)}`)
    .join(" · ");
  const wow = deltaStr(r.totalDeltaPct);
  const wowPart = r.totalDeltaPct === null ? "" : ` (${wow} WoW)`;
  return [
    `AI spend this week: **${usd(r.totalCost)}**${wowPart} across ${int(r.eventCount)} model calls.`,
    top ? `Top: ${top}.` : "",
    voiceTeaserLine(r.voice),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * One line, only when something was actually degraded. A healthy week says
 * nothing here — the canvas still carries the full breakdown.
 */
function voiceTeaserLine(v: VoiceTransportSummary): string {
  const degraded = v.fellBack + v.neverRealtime;
  if (degraded === 0) return "";
  return `Voice: ${int(degraded)} of ${int(v.sessions)} sessions ran on the Whisper fallback (${int(v.whisperTurns)} of ${int(v.realtimeTurns + v.whisperTurns)} turns).`;
}

/** The full Slack-canvas markdown report. */
export function renderUsageReportMarkdown(r: UsageReport): string {
  const lines: string[] = [];
  lines.push(`# AI Usage & Cost — week of ${ymd(r.windowStart)}`);
  lines.push("");
  lines.push(
    `Window: **${ymd(r.windowStart)} → ${ymd(r.windowEnd)}** · ${int(r.eventCount)} model calls · **${usd(r.totalCost)}** total (${deltaStr(r.totalDeltaPct)} vs. prior 7 days, ${usd(r.priorTotalCost)}).`,
  );
  lines.push("");

  if (r.eventCount === 0) {
    lines.push("_No usage recorded this window._");
    return lines.join("\n");
  }

  // By source bucket.
  lines.push("## By source");
  lines.push("");
  lines.push("| Source | Cost | Share | WoW | Calls |");
  lines.push("| --- | ---: | ---: | :---: | ---: |");
  for (const b of r.byBucket) {
    const share = r.totalCost > 0 ? Math.round((b.cost / r.totalCost) * 100) : 0;
    lines.push(`| ${b.label} | ${usd(b.cost)} | ${share}% | ${deltaStr(b.deltaPct)} | ${int(b.calls)} |`);
  }
  lines.push(`| **Total** | **${usd(r.totalCost)}** | 100% | ${deltaStr(r.totalDeltaPct)} | ${int(r.eventCount)} |`);
  lines.push("");

  // By institution, with the same four token dimensions used by the model table.
  lines.push("## By institution");
  lines.push("");
  lines.push(
    "| Institution | Cost | Share | Input | Cache-write | Cache-read | Output | Calls |",
  );
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const institution of r.byInstitution) {
    const share =
      r.totalCost > 0
        ? Math.round((institution.estimatedCost / r.totalCost) * 100)
        : 0;
    lines.push(
      `| ${institution.label} | ${usd(institution.estimatedCost)} | ${share}% | ${compact(institution.totals.inputTokens)} | ${compact(institution.totals.cacheWriteTokens)} | ${compact(institution.totals.cacheReadTokens)} | ${compact(institution.totals.outputTokens)} | ${int(institution.calls)} |`,
    );
  }
  lines.push(
    `| **Total** | **${usd(r.totalCost)}** | 100% | ${compact(r.totalTokens.inputTokens)} | ${compact(r.totalTokens.cacheWriteTokens)} | ${compact(r.totalTokens.cacheReadTokens)} | ${compact(r.totalTokens.outputTokens)} | ${int(r.eventCount)} |`,
  );
  lines.push("");

  // By model, with the token dimensions (so cache efficiency is visible).
  lines.push("## By model");
  lines.push("");
  lines.push("| Model | Cost | Input | Cache-write | Cache-read | Output | Calls |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const m of r.byModel) {
    const label = m.priced ? m.label : `${m.label} _(unpriced)_`;
    lines.push(
      `| ${label} | ${usd(m.cost)} | ${compact(m.totals.inputTokens)} | ${compact(m.totals.cacheWriteTokens)} | ${compact(m.totals.cacheReadTokens)} | ${compact(m.totals.outputTokens)} | ${int(m.calls)} |`,
    );
  }
  lines.push(
    `| **Total** | **${usd(r.totalCost)}** | ${compact(r.totalTokens.inputTokens)} | ${compact(r.totalTokens.cacheWriteTokens)} | ${compact(r.totalTokens.cacheReadTokens)} | ${compact(r.totalTokens.outputTokens)} | ${int(r.eventCount)} |`,
  );
  lines.push("");

  // Voice transport health. Skipped entirely when nobody spoke — calm > noisy,
  // same stance as the zero-usage early return above.
  if (r.voice.sessions > 0) {
    const v = r.voice;
    const degraded = v.fellBack + v.neverRealtime;
    lines.push("## Voice input");
    lines.push("");
    lines.push(
      "| Voice sessions | Realtime throughout | Fell back mid-session | Never reached realtime | Realtime turns | Whisper turns |",
    );
    lines.push("| ---: | ---: | ---: | ---: | ---: | ---: |");
    lines.push(
      `| ${int(v.sessions)} | ${int(v.realtimeOnly)} | ${int(v.fellBack)} | ${int(v.neverRealtime)} | ${int(v.realtimeTurns)} | ${int(v.whisperTurns)} |`,
    );
    lines.push("");
    if (degraded > 0) {
      lines.push(
        `> ⚠️ ${int(degraded)} of ${int(v.sessions)} voice sessions ran on the Whisper fallback. The fallback is sticky — one transport failure downgrades every remaining turn in that session, so a single bad handshake can cost a scholar a whole session of worse transcription.`,
      );
      lines.push("");
    }
    lines.push(
      "_Voice rows are grouped by session; no session or scholar is named. A bug report filed with audio also transcribes through Whisper against its session, so it reads here as one fallback turn._",
    );
    lines.push("");
  }

  if (r.unpricedModels.length > 0) {
    lines.push(
      `> ⚠️ Unpriced models (counted in tokens, **$0** in cost — add a rate to \`PRICING\`): ${r.unpricedModels.join(", ")}.`,
    );
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "_Costs are estimates from the published token, audio-minute (Whisper), and character (TTS) rate card (see `convex/lib/usageReport.ts`)._",
  );
  return lines.join("\n");
}
