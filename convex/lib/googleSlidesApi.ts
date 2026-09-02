const SLIDES_API_BASE_URL = "https://slides.googleapis.com/v1";

export interface GoogleSlidesErrorEnvelope {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export class GoogleSlidesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly googleError: GoogleSlidesErrorEnvelope | undefined,
  ) {
    super(message);
    this.name = "GoogleSlidesApiError";
  }
}

export class StalePresentationRevisionError extends GoogleSlidesApiError {
  constructor(status: number, googleError: GoogleSlidesErrorEnvelope | undefined) {
    super(
      "The Google Slides presentation changed since it was read. Fetch the latest revision before editing.",
      status,
      googleError,
    );
    this.name = "StalePresentationRevisionError";
  }
}

export interface GoogleSlidesTextRun {
  content?: string;
  style?: { link?: unknown; [key: string]: unknown };
}

export interface GoogleSlidesTextElement {
  textRun?: GoogleSlidesTextRun;
  paragraphMarker?: {
    bullet?: unknown;
    style?: Record<string, unknown>;
  };
  autoText?: unknown;
}

export interface GoogleSlidesPageElement {
  objectId?: string;
  shape?: {
    shapeType?: string;
    placeholder?: { type?: string; index?: number };
    text?: { textElements?: GoogleSlidesTextElement[] };
  };
  [key: string]: unknown;
}

export interface GoogleSlidesPage {
  objectId?: string;
  pageElements?: GoogleSlidesPageElement[];
  slideProperties?: {
    layoutObjectId?: string;
    notesPage?: {
      notesProperties?: { speakerNotesObjectId?: string };
      pageElements?: GoogleSlidesPageElement[];
    };
  };
}

export interface GoogleSlidesPresentation {
  presentationId?: string;
  title?: string;
  revisionId?: string;
  slides?: GoogleSlidesPage[];
  layouts?: GoogleSlidesPage[];
}

async function readGoogleError(
  response: Response,
): Promise<GoogleSlidesErrorEnvelope | undefined> {
  try {
    return (await response.json()) as GoogleSlidesErrorEnvelope;
  } catch {
    return undefined;
  }
}

async function googleSlidesFetch<T>(
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
      throw new StalePresentationRevisionError(response.status, googleError);
    }
    throw new GoogleSlidesApiError(
      googleError?.error?.message ??
        `Google Slides API request failed (${response.status})`,
      response.status,
      googleError,
    );
  }
  return (await response.json()) as T;
}

export async function getPresentation(
  token: string,
  presentationId: string,
): Promise<GoogleSlidesPresentation> {
  return await googleSlidesFetch(
    `${SLIDES_API_BASE_URL}/presentations/${encodeURIComponent(presentationId)}`,
    token,
  );
}

/**
 * Requests are intentionally opaque here. The bounded editor is the only
 * caller allowed to construct the Google Slides batch grammar.
 */
export async function batchUpdatePresentation(
  token: string,
  presentationId: string,
  requests: readonly unknown[],
  requiredRevisionId: string,
): Promise<{ writeControl?: { requiredRevisionId?: string }; replies?: unknown[] }> {
  return await googleSlidesFetch(
    `${SLIDES_API_BASE_URL}/presentations/${encodeURIComponent(presentationId)}:batchUpdate`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests,
        writeControl: { requiredRevisionId },
      }),
    },
    true,
  );
}
