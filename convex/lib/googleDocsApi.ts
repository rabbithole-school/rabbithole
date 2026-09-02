import { GOOGLE_DOCS_EVENT_TYPES } from "./googleDocsEventsConstants";
import type { GoogleDocsDocument } from "./googleDocsText";

const DOCS_API_BASE_URL = "https://docs.googleapis.com/v1";
const DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3";
const WORKSPACE_EVENTS_API_BASE_URL = "https://workspaceevents.googleapis.com/v1";

export interface GoogleErrorEnvelope {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{
      domain?: string;
      reason?: string;
      message?: string;
    }>;
  };
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly googleError: GoogleErrorEnvelope | undefined,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export class StaleRevisionError extends GoogleApiError {
  constructor(status: number, googleError: GoogleErrorEnvelope | undefined) {
    super(
      "The Google Doc changed since it was read. Fetch the latest revision before editing.",
      status,
      googleError,
    );
    this.name = "StaleRevisionError";
  }
}

export interface GoogleDocument extends GoogleDocsDocument {
  documentId: string;
  title?: string;
  revisionId?: string;
}

export interface DriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  webViewLink?: string;
  parents?: string[];
}

export interface DrivePermission {
  id: string;
  type: string;
  role: string;
  emailAddress?: string;
  domain?: string;
}

export interface DriveComment {
  id: string;
  content?: string;
  quotedFileContent?: {
    mimeType?: string;
    value?: string;
  };
  author?: {
    displayName?: string;
    emailAddress?: string;
    me?: boolean;
  };
  createdTime?: string;
  resolved?: boolean;
  deleted?: boolean;
  replies?: DriveReply[];
}

export interface DriveReply {
  id: string;
  content?: string;
  author?: {
    displayName?: string;
    emailAddress?: string;
    me?: boolean;
  };
  createdTime?: string;
  deleted?: boolean;
}

export interface WorkspaceEventsSubscription {
  name: string;
  targetResource?: string;
  eventTypes?: string[];
  expireTime: string;
}

type DrivePermissionCreate =
  | {
      type: "user" | "group";
      role: string;
      emailAddress: string;
      domain?: never;
    }
  | {
      type: "domain";
      role: string;
      domain: string;
      emailAddress?: never;
    };

async function readGoogleError(response: Response): Promise<GoogleErrorEnvelope | undefined> {
  try {
    return (await response.json()) as GoogleErrorEnvelope;
  } catch {
    return undefined;
  }
}

async function googleFetch<T>(
  url: string,
  token: string,
  init: RequestInit = {},
  staleRevisionIsExpected = false,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const googleError = await readGoogleError(response);
    if (
      staleRevisionIsExpected &&
      response.status === 400 &&
      googleError?.error?.status === "FAILED_PRECONDITION"
    ) {
      throw new StaleRevisionError(response.status, googleError);
    }
    throw new GoogleApiError(
      googleError?.error?.message ?? `Google API request failed (${response.status})`,
      response.status,
      googleError,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function requiredEventsEnv(name: "GOOGLE_EVENTS_PROJECT" | "GOOGLE_EVENTS_TOPIC") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function workspaceEventsHeaders(project: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Goog-User-Project": project,
  };
}

function workspaceEventsTopic(project: string, topic: string): string {
  return topic.startsWith("projects/")
    ? topic
    : `projects/${project}/topics/${topic}`;
}

export type WorkspaceOperation = {
  name?: string;
  done?: boolean;
  error?: { message?: string };
  response?:
    | WorkspaceEventsSubscription
    | { subscription?: WorkspaceEventsSubscription };
};

export async function awaitWorkspaceOperation(
  token: string,
  project: string,
  operation: WorkspaceOperation,
  options: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {},
): Promise<WorkspaceOperation> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  let current = operation;
  const deadline = now() + timeoutMs;
  while (!current.done && current.name && now() < deadline) {
    await sleep(pollIntervalMs);
    current = await googleFetch(
      `${WORKSPACE_EVENTS_API_BASE_URL}/${current.name}`,
      token,
      { headers: workspaceEventsHeaders(project) },
    );
  }
  if (!current.done) {
    throw new Error(
      `Workspace Events operation did not finish within ${timeoutMs} milliseconds`,
    );
  }
  if (current.error) {
    throw new Error(
      current.error.message ?? "Workspace Events operation completed with an error",
    );
  }
  return current;
}

export async function getDocument(
  token: string,
  documentId: string,
  options: { includeTabsContent: boolean },
): Promise<GoogleDocument> {
  const query = new URLSearchParams({
    includeTabsContent: String(options.includeTabsContent),
  });
  return await googleFetch(
    `${DOCS_API_BASE_URL}/documents/${encodeURIComponent(documentId)}?${query}`,
    token,
  );
}

export async function createDocument(
  token: string,
  title: string,
): Promise<GoogleDocument> {
  return await googleFetch(`${DOCS_API_BASE_URL}/documents`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function batchUpdate(
  token: string,
  documentId: string,
  requests: unknown[],
  options: { requiredRevisionId?: string } = {},
): Promise<{ writeControl?: { requiredRevisionId?: string }; replies?: unknown[] }> {
  return await googleFetch(
    `${DOCS_API_BASE_URL}/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests,
        ...(options.requiredRevisionId
          ? { writeControl: { requiredRevisionId: options.requiredRevisionId } }
          : {}),
      }),
    },
    !!options.requiredRevisionId,
  );
}

export async function driveCreateFile(
  token: string,
  args: { name: string; mimeType: string; parentFolderId: string },
): Promise<DriveFile> {
  const query = new URLSearchParams({
    fields: "id,name,mimeType,webViewLink,parents",
    supportsAllDrives: "true",
  });
  return await googleFetch(`${DRIVE_API_BASE_URL}/files?${query}`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: args.name,
      mimeType: args.mimeType,
      parents: [args.parentFolderId],
    }),
  });
}

export async function drivePermissionCreate(
  token: string,
  fileId: string,
  permission: DrivePermissionCreate,
): Promise<DrivePermission> {
  const query = new URLSearchParams({
    fields: "id,type,role,emailAddress,domain",
    supportsAllDrives: "true",
  });
  return await googleFetch(
    `${DRIVE_API_BASE_URL}/files/${encodeURIComponent(fileId)}/permissions?${query}`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(permission),
    },
  );
}

export async function driveCommentsList(
  token: string,
  fileId: string,
): Promise<DriveComment[]> {
  const comments: DriveComment[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      fields:
        "nextPageToken,comments(id,content,quotedFileContent,author(displayName,emailAddress,me),createdTime,resolved,deleted,replies(id,content,author(displayName,emailAddress,me),createdTime,deleted))",
      includeDeleted: "false",
      pageSize: "100",
      supportsAllDrives: "true",
      ...(pageToken ? { pageToken } : {}),
    });
    const page = await googleFetch<{
      comments?: DriveComment[];
      nextPageToken?: string;
    }>(
      `${DRIVE_API_BASE_URL}/files/${encodeURIComponent(fileId)}/comments?${query}`,
      token,
    );
    comments.push(...(page.comments ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return comments;
}

export async function driveCommentGet(
  token: string,
  fileId: string,
  commentId: string,
): Promise<DriveComment> {
  const query = new URLSearchParams({
    fields:
      "id,content,quotedFileContent,author(displayName,emailAddress,me),createdTime,resolved,deleted,replies(id,content,author(displayName,emailAddress,me),createdTime,deleted)",
    includeDeleted: "false",
    supportsAllDrives: "true",
  });
  return await googleFetch(
    `${DRIVE_API_BASE_URL}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}?${query}`,
    token,
  );
}

export async function driveCommentReplyCreate(
  token: string,
  fileId: string,
  commentId: string,
  content: string,
): Promise<DriveReply> {
  const query = new URLSearchParams({
    fields: "id,content,createdTime",
    supportsAllDrives: "true",
  });
  return await googleFetch(
    `${DRIVE_API_BASE_URL}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}/replies?${query}`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}

export async function workspaceEventsSubscriptionCreate(
  token: string,
  documentId: string,
  ttlSeconds = 14_400,
): Promise<WorkspaceEventsSubscription> {
  if (ttlSeconds < 3_600 || ttlSeconds > 14_400) {
    throw new Error("Workspace Events resource-data TTL must be 3600-14400 seconds");
  }
  const project = requiredEventsEnv("GOOGLE_EVENTS_PROJECT");
  const topic = requiredEventsEnv("GOOGLE_EVENTS_TOPIC");
  const operation = await googleFetch<WorkspaceOperation>(
    `${WORKSPACE_EVENTS_API_BASE_URL}/subscriptions`,
    token,
    {
      method: "POST",
      headers: workspaceEventsHeaders(project),
      body: JSON.stringify({
        targetResource: `//drive.googleapis.com/files/${documentId}`,
        eventTypes: [...GOOGLE_DOCS_EVENT_TYPES],
        notificationEndpoint: {
          pubsubTopic: workspaceEventsTopic(project, topic),
        },
        payloadOptions: { includeResource: true },
        ttl: `${ttlSeconds}s`,
      }),
    },
  );
  const completed = await awaitWorkspaceOperation(token, project, operation);
  const response = completed.response;
  let subscription: WorkspaceEventsSubscription | undefined;
  if (response && "subscription" in response) {
    subscription = response.subscription;
  } else if (response && "name" in response) {
    subscription = response;
  }
  if (!subscription?.name || !subscription.expireTime) {
    throw new Error("Workspace Events create completed without a subscription");
  }
  return subscription;
}

export async function workspaceEventsSubscriptionUpdate(
  token: string,
  subscriptionName: string,
  ttlSeconds = 14_400,
): Promise<WorkspaceEventsSubscription> {
  if (!subscriptionName.startsWith("subscriptions/")) {
    throw new Error("Invalid Workspace Events subscription name");
  }
  if (ttlSeconds < 3_600 || ttlSeconds > 14_400) {
    throw new Error("Workspace Events resource-data TTL must be 3600-14400 seconds");
  }
  const project = requiredEventsEnv("GOOGLE_EVENTS_PROJECT");
  const query = new URLSearchParams({
    updateMask: "eventTypes,ttl",
  });
  const operation = await googleFetch<WorkspaceOperation>(
    `${WORKSPACE_EVENTS_API_BASE_URL}/${subscriptionName}?${query}`,
    token,
    {
      method: "PATCH",
      headers: workspaceEventsHeaders(project),
      body: JSON.stringify({
        eventTypes: [...GOOGLE_DOCS_EVENT_TYPES],
        ttl: `${ttlSeconds}s`,
      }),
    },
  );
  const completed = await awaitWorkspaceOperation(token, project, operation);
  const response = completed.response;
  let subscription: WorkspaceEventsSubscription | undefined;
  if (response && "subscription" in response) {
    subscription = response.subscription;
  } else if (response && "name" in response) {
    subscription = response;
  }
  if (!subscription?.name || !subscription.expireTime) {
    throw new Error("Workspace Events update completed without a subscription");
  }
  return subscription;
}

export async function workspaceEventsSubscriptionDelete(
  token: string,
  subscriptionName: string,
): Promise<void> {
  if (!subscriptionName.startsWith("subscriptions/")) {
    throw new Error("Invalid Workspace Events subscription name");
  }
  const project = requiredEventsEnv("GOOGLE_EVENTS_PROJECT");
  await googleFetch(
    `${WORKSPACE_EVENTS_API_BASE_URL}/${subscriptionName}?allowMissing=true`,
    token,
    {
      method: "DELETE",
      headers: workspaceEventsHeaders(project),
    },
  );
}
