import type {
  AppAiContext,
  AppBridgeResponsePayload,
  AppBridgeErrorCode,
  CharacterLine,
} from "../shared/appAiPolicy.ts";

export const APP_STATE_PROTOCOL: "rabbithole:app-state";
export const APP_STATE_PROTOCOL_VERSION: 1;
export const APP_STATE_WRITE_DEBOUNCE_MS: 250;
export const APP_STATE_MAX_WRITE_LATENCY_MS: 2_000;
export const APP_STATE_MAX_LOG_ENTRIES: 30;
export const APP_STATE_MAX_LOG_CHARS: 300;
export const RABBITHOLE_APP_STATE_SDK: string;
export const RABBITHOLE_APP_STATE_SDK_BYTES: number;

export interface AppStateBridgeReadyMessage {
  type: "ready";
  nonce: string;
}

export interface AppStateBridgeSharedSelectMessage {
  type: "sharedSelect";
  nonce: string;
  roomId: string;
}

export interface AppStateBridgeSharedChangeMessage {
  type: "sharedChange";
  nonce: string;
  roomId: string;
  patch: Record<string, unknown>;
}

export interface AppStateBridgeActionsMessage {
  type: "actions";
  nonce: string;
  actions: Array<{ name: string; description: string }>;
}

export interface AppStateBridgeAskTutorMessage {
  type: "askTutor";
  nonce: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface AppStateBridgeActionResultMessage {
  type: "actionResult";
  nonce: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AppStateBridgeChangeMessage {
  type: "change";
  nonce: string;
  patch?: Record<string, unknown>;
  logs?: Array<{ level: "log" | "warn" | "error"; message: string }>;
}

export type AppStateBridgeRequestMessage =
  | {
      type: "request";
      nonce: string;
      requestId: string;
      method: "character.say";
      params: { text: string; context?: AppAiContext };
    }
  | {
      type: "request";
      nonce: string;
      requestId: string;
      method: "judge";
      params: { judgeId: string; answer: string; context?: AppAiContext };
    };

/** Host→frame reply to a request (never produced by the parser). */
export type AppBridgeResponseMessage = {
  protocol: typeof APP_STATE_PROTOCOL;
  version: typeof APP_STATE_PROTOCOL_VERSION;
  nonce: string;
  type: "response";
  requestId: string;
} & (
  | { ok: true; result: unknown }
  | { ok: false; error: { code: AppBridgeErrorCode; message: string } }
);

export type AppStateBridgeMessage =
  | AppStateBridgeReadyMessage
  | AppStateBridgeSharedSelectMessage
  | AppStateBridgeSharedChangeMessage
  | AppStateBridgeActionsMessage
  | AppStateBridgeAskTutorMessage
  | AppStateBridgeActionResultMessage
  | AppStateBridgeRequestMessage
  | AppStateBridgeChangeMessage;

export function mergeAppStateDoc(
  doc: unknown,
  patches: readonly unknown[],
): Record<string, unknown>;
export function appActionRegistryWriteDecision(
  previousActions: unknown,
  nextActions: readonly unknown[],
): "defer" | "persist" | "skip";
export function appStateFlushDelay(
  oldestPendingAt: number | undefined,
  now?: number,
): number;
export function parseAppStateBridgeMessage(
  value: { type: "actions"; actions: unknown; [key: string]: unknown },
): AppStateBridgeActionsMessage | null;
export function parseAppStateBridgeMessage(
  value: unknown,
): AppStateBridgeMessage | null;
export function matchesAppStateBridgeNonce(
  message: { nonce: string },
  activeNonce: string | null,
): boolean;
export function createAppStateHostMessage(
  type: "init" | "update",
  doc: unknown,
  nonce: string,
  shared?: unknown,
  actionRequest?: unknown,
  characterLine?: CharacterLine | null,
): Record<string, unknown>;
export function appStateHostInjectionScript(
  type: "init" | "update",
  doc: unknown,
  nonce: string,
  shared?: unknown,
  actionRequest?: unknown,
  characterLine?: CharacterLine | null,
): string;
export function createAppBridgeResponseMessage(
  nonce: string,
  requestId: string,
  payload: AppBridgeResponsePayload<unknown>,
): AppBridgeResponseMessage;
export function appBridgeResponseInjectionScript(
  nonce: string,
  requestId: string,
  payload: AppBridgeResponsePayload<unknown>,
): string;
export function injectAppStateSdk(html: string): string;
