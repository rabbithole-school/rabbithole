// Pure helpers for Slack interactivity (`POST /slack/interactivity`): payload
// parsing, action_id dispatch, and the demo:ack message. No Convex or network
// imports so they are unit-testable (httpActions can't be driven by
// convex-test; see .claude/rules/rabbithole-test-strategy.md).
//
// Signature verification is NOT re-implemented here: the route calls the same
// `verifySlackSignature` as /slack/events, over the raw (form-encoded) body.

export interface SlackInteractivityUser {
  id: string;
  username?: string;
  name?: string;
  team_id?: string;
}

export interface SlackBlockAction {
  action_id: string;
  block_id?: string;
  value?: string;
  type?: string;
  action_ts?: string;
}

export interface SlackBlockActionsPayload {
  type: "block_actions";
  user: SlackInteractivityUser;
  trigger_id?: string;
  response_url?: string;
  channel?: { id: string };
  container?: { type?: string; message_ts?: string; channel_id?: string };
  message?: { ts: string; blocks?: unknown[]; text?: string };
  actions: SlackBlockAction[];
}

/** Stub shape for modals. "Add notes" will be built on this. */
export interface SlackViewSubmissionPayload {
  type: "view_submission";
  user: SlackInteractivityUser;
  trigger_id?: string;
  view: {
    id: string;
    callback_id: string;
    private_metadata?: string;
    state?: {
      values: Record<
        string,
        Record<
          string,
          {
            type?: string;
            value?: string | null;
            selected_option?: { value?: string } | null;
          }
        >
      >;
    };
  };
}

export type SlackInteractivityPayload =
  | SlackBlockActionsPayload
  | SlackViewSubmissionPayload
  | { type: "view_closed" | "shortcut" | "message_action"; user?: SlackInteractivityUser };

export type ParseResult =
  | { ok: true; payload: SlackInteractivityPayload }
  | { ok: false; error: string };

/** Parse the `application/x-www-form-urlencoded` body (`payload=<json>`). */
export function parseInteractivityBody(rawBody: string): ParseResult {
  const raw = new URLSearchParams(rawBody).get("payload");
  if (!raw) return { ok: false, error: "missing payload" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "payload is not JSON" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "payload is not an object" };
  }
  const p = parsed as { type?: unknown; user?: { id?: unknown }; actions?: unknown };
  if (typeof p.type !== "string") return { ok: false, error: "missing type" };
  if (p.type === "block_actions") {
    if (typeof p.user?.id !== "string") return { ok: false, error: "missing user" };
    if (!Array.isArray(p.actions)) return { ok: false, error: "missing actions" };
  }
  if (p.type === "view_submission" && typeof p.user?.id !== "string") {
    return { ok: false, error: "missing user" };
  }
  return { ok: true, payload: parsed as SlackInteractivityPayload };
}

/** `demo:ack` -> `demo`. The namespace a handler is registered under. */
export function actionPrefix(actionId: string): string {
  const i = actionId.indexOf(":");
  return i === -1 ? actionId : actionId.slice(0, i);
}

export type ActionPlan =
  | { kind: "noop"; reason: string }
  | {
      kind: "update";
      channel: string;
      ts: string;
      text: string;
      blocks: unknown[];
    };

export interface ActionContext {
  payload: SlackBlockActionsPayload;
  action: SlackBlockAction;
  /** Display name of the resolved RH user. */
  userName: string;
  nowMs: number;
}

type ActionHandler = (ctx: ActionContext) => ActionPlan;

/** Registry keyed by action_id prefix. Add a namespace per feature. */
export const ACTION_HANDLERS: Record<string, ActionHandler> = {
  demo: planDemoAction,
};

export function messageLocation(
  payload: SlackBlockActionsPayload,
): { channel: string; ts: string } | null {
  const channel = payload.channel?.id ?? payload.container?.channel_id;
  const ts = payload.message?.ts ?? payload.container?.message_ts;
  return channel && ts ? { channel, ts } : null;
}

/** True when a block of type `actions` in the message still has this action_id. */
export function messageStillHasAction(
  blocks: unknown[] | undefined,
  actionId: string,
): boolean {
  if (!Array.isArray(blocks)) return false;
  return blocks.some((b) => {
    const block = b as { type?: string; elements?: { action_id?: string }[] };
    return (
      block.type === "actions" &&
      Array.isArray(block.elements) &&
      block.elements.some((e) => e.action_id === actionId)
    );
  });
}

/** Dispatch one action. Unknown prefixes are a noop, never an error. */
export function planBlockAction(ctx: ActionContext): ActionPlan {
  const handler = ACTION_HANDLERS[actionPrefix(ctx.action.action_id)];
  if (!handler) return { kind: "noop", reason: `no handler for ${ctx.action.action_id}` };
  return handler(ctx);
}

// ── demo:ack ──────────────────────────────────────────────────────────

export const DEMO_ACK_ACTION_ID = "demo:ack";

/** Blocks for a message carrying the demo button. */
export function demoAckBlocks(text = "Demo: click to acknowledge.") {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      block_id: "demo_ack_actions",
      elements: [
        {
          type: "button",
          action_id: DEMO_ACK_ACTION_ID,
          text: { type: "plain_text", text: "Acknowledge" },
          style: "primary",
          value: "demo",
        },
      ],
    },
  ];
}

/**
 * Idempotency: the handled message has no button, so a second click on a stale
 * client (or a Slack retry) sees no `demo:ack` in the message and is a noop.
 */
function planDemoAction(ctx: ActionContext): ActionPlan {
  if (ctx.action.action_id !== DEMO_ACK_ACTION_ID) {
    return { kind: "noop", reason: `unknown demo action ${ctx.action.action_id}` };
  }
  const loc = messageLocation(ctx.payload);
  if (!loc) return { kind: "noop", reason: "no message location" };
  if (!messageStillHasAction(ctx.payload.message?.blocks, DEMO_ACK_ACTION_ID)) {
    return { kind: "noop", reason: "already handled" };
  }
  const when = new Date(ctx.nowMs).toISOString();
  const text = `Acknowledged by ${ctx.userName} at ${when}.`;
  return {
    kind: "update",
    ...loc,
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `:white_check_mark: ${text}` } }],
  };
}

// ── view_submission stub ──────────────────────────────────────────────

/** Flatten `view.state.values` to `{action_id: value}`. */
export function flattenViewValues(
  view: SlackViewSubmissionPayload["view"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of Object.values(view.state?.values ?? {})) {
    for (const [actionId, v] of Object.entries(block)) {
      if (typeof v.value === "string") out[actionId] = v.value;
      else if (typeof v.selected_option?.value === "string") {
        out[actionId] = v.selected_option.value;
      }
    }
  }
  return out;
}
