import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isStaffRole, type Role } from "./roles";
import type { AideEmit, AideTool } from "./aideStream";
import {
  batchUpdate,
  createDocument,
  drivePermissionCreate,
} from "./googleDocsApi";
import {
  GoogleDocsEditor,
  parseGoogleDocsEditorInput,
} from "./googleDocsEditor";
import { getValidDocsBotToken } from "./googleTokens";

const DOCS_URL = "https://docs.google.com/document/d";
const MAX_EMBEDDED_IMAGES = 4;
const MAX_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024;
const GOOGLE_DOCS_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
]);

export type GoogleDocsEmbeddableImage = {
  storageId: Id<"_storage">;
  mimeType: string;
  // The caller's resolved institution at the time this conversation made the
  // storage reference available. This prevents a shared factory caller from
  // carrying an image handle across institution-scoped Docs credentials.
  institutionId: Id<"institutions">;
};

/**
 * The shared Docs creation tool for every staff-aide transport. It resolves the
 * caller's institution at execution time so a role alone never selects a bot
 * credential from another school.
 */
export async function makeGoogleDocsTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    institutionScope?: string;
    // The transport owns this allowlist. Accepting arbitrary storage ids here
    // would let a model copy an unrelated private file into a shareable Doc.
    availableImages?: () => readonly GoogleDocsEmbeddableImage[];
  },
): Promise<AideTool[]> {
  if (!isStaffRole(opts.role)) return [];

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );
  const { callerUserId, institutionScope } = opts;

  const resolveImageUris = async (
    requestedStorageIds: unknown,
    institutionId: Id<"institutions">,
  ): Promise<{ uris: string[] } | { error: string }> => {
    if (requestedStorageIds === undefined) return { uris: [] };
    if (
      !Array.isArray(requestedStorageIds) ||
      !requestedStorageIds.every(
        (storageId) => typeof storageId === "string" && storageId.trim(),
      )
    ) {
      return {
        error:
          "image_storage_ids must be a list of approved image storage references.",
      };
    }
    const storageIds = requestedStorageIds.map((storageId) =>
      storageId.trim(),
    );
    if (storageIds.length > MAX_EMBEDDED_IMAGES) {
      return {
        error: `A Google Doc can embed at most ${MAX_EMBEDDED_IMAGES} approved images at once.`,
      };
    }
    if (new Set(storageIds).size !== storageIds.length) {
      return {
        error:
          "Each approved image may be included only once in a Google Doc.",
      };
    }

    const availableImages = new Map(
      (opts.availableImages?.() ?? []).map((image) => [
        String(image.storageId),
        image,
      ]),
    );
    const selectedImages: GoogleDocsEmbeddableImage[] = [];
    for (const storageId of storageIds) {
      const image = availableImages.get(storageId);
      if (!image) {
        return {
          error:
            "Every embedded image must be an approved image reference from this conversation. Use its visible storageRef; filenames and arbitrary storage ids are not accepted.",
        };
      }
      if (image.institutionId !== institutionId) {
        return {
          error:
            "Each embedded image must be available to the active institution for this conversation.",
        };
      }
      if (!GOOGLE_DOCS_IMAGE_MIME_TYPES.has(image.mimeType)) {
        return {
          error:
            "Google Docs can embed only approved PNG, JPEG, or GIF images.",
        };
      }
      selectedImages.push(image);
    }

    const uris: string[] = [];
    for (const image of selectedImages) {
      const blob = await ctx.storage.get(image.storageId);
      if (!blob) {
        return {
          error:
            "One approved image is no longer available in storage. Choose another visible image reference.",
        };
      }
      const mimeType = blob.type || image.mimeType;
      if (!GOOGLE_DOCS_IMAGE_MIME_TYPES.has(mimeType)) {
        return {
          error:
            "Google Docs can embed only approved PNG, JPEG, or GIF images.",
        };
      }
      if (blob.size > MAX_EMBEDDED_IMAGE_BYTES) {
        return {
          error:
            "Each embedded image must be 10 MB or smaller.",
        };
      }
      const uri = await ctx.storage.getUrl(image.storageId);
      if (!uri || uri.length > 2_000) {
        return {
          error:
            "I couldn't prepare an approved image for Google Docs. Choose another visible image reference.",
        };
      }
      uris.push(uri);
    }
    return { uris };
  };

  const resolveDocsToken = async (): Promise<
    { institutionId: Id<"institutions">; token: string } | { error: string }
  > => {
    const institution = await ctx.runQuery(
      internal.driveSyncState.resolveInstitutionForCaller,
      { userId: callerUserId, scope: institutionScope },
    );
    if (!institution) {
      return {
        error: JSON.stringify({
          error: {
            code: "INSTITUTION_NOT_RESOLVED",
            message:
              "I can't use Google Docs because no active institution is resolved for your account.",
          },
        }),
      };
    }

    const docsCredential = await ctx.runQuery(
      internal.driveSyncState.getDocsBotCredentialByInstitutionInternal,
      { institutionId: institution.institutionId },
    );
    if (!docsCredential) {
      return {
        error: JSON.stringify({
          error: {
            code: "DOCS_BOT_NOT_CONNECTED",
            message:
              "Your school's Docs bot is not connected yet. Ask a school admin to connect the bot account in Docs settings.",
          },
        }),
      };
    }

    // Document-level isolation is delegated to Google Drive ACLs: each
    // institution's bot token can open only Docs shared with that bot account.
    return {
      institutionId: institution.institutionId,
      token: await getValidDocsBotToken(ctx, institution.institutionId),
    };
  };

  const createSharedDocument = async (args: {
    institutionId: Id<"institutions">;
    token: string;
    title: string;
    initialContent: string;
    shareWithRequester: boolean;
    imageUris: string[];
    toolName: string;
  }): Promise<string> => {
    let requesterEmail: string | undefined;
    if (args.shareWithRequester) {
      const [googleAccount, requester] = await Promise.all([
        ctx.runQuery(internal.googleAccounts.getForUserInternal, {
          userId: callerUserId,
        }),
        ctx.runQuery(internal.users.getByIdInternal, {
          id: callerUserId,
        }),
      ]);
      requesterEmail = googleAccount?.email ?? requester?.email;
      if (!requesterEmail) {
        return JSON.stringify({
          error: {
            code: "REQUESTER_EMAIL_MISSING",
            message:
              "I can't create and share the document because your account has no email address. Add an email or connect Google, then ask again.",
          },
        });
      }
    }

    const document = await createDocument(args.token, args.title);
    await batchUpdate(args.token, document.documentId, [
      {
        insertText: {
          location: { index: 1 },
          text: args.initialContent,
        },
      },
    ]);
    if (args.imageUris.length > 0) {
      const imageRequests: unknown[] = [];
      let index = args.initialContent.length + 1;
      for (const uri of args.imageUris) {
        // Insert a paragraph break before every image so a campaign handoff
        // remains readable if staff edit the surrounding copy in Google Docs.
        imageRequests.push({
          insertText: { location: { index }, text: "\n" },
        });
        imageRequests.push({
          insertInlineImage: { location: { index: index + 1 }, uri },
        });
        index += 2;
      }
      await batchUpdate(args.token, document.documentId, imageRequests);
    }

    if (args.shareWithRequester) {
      await drivePermissionCreate(args.token, document.documentId, {
        type: "user",
        role: "writer",
        emailAddress: requesterEmail!,
      });
    }

    try {
      await ctx.runAction(
        internal.googleDocsEventsActions.ensureSubscription,
        {
          institutionId: args.institutionId,
          documentId: document.documentId,
          createdBy: callerUserId,
        },
      );
    } catch (error) {
      // The document is already useful and shared; surface the integration
      // failure operationally without turning a successful create into a lie.
      console.error(
        `Created Google Doc ${document.documentId}, but could not subscribe to comment events:`,
        error,
      );
    }

    const result = {
      documentId: document.documentId,
      url: `${DOCS_URL}/${document.documentId}/edit`,
      title: document.title ?? args.title,
    };
    emit({
      toolComplete: {
        name: args.toolName,
        result: `Created "${result.title}"`,
      },
    });
    return JSON.stringify(result);
  };

  const createSharedDocTool = betaTool({
    name: "create_shared_doc",
    description:
      "Create a Google Doc owned by your school's Rabbithole Docs bot. The requested plain text or markdown-lite content is inserted as plain paragraphs, and the Doc is shared with you as an editor by default. Use this when the teacher asks for a draft, handout, plan, or other Google Doc they can continue editing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string" as const,
          description: "The Google Doc title.",
        },
        initial_content: {
          type: "string" as const,
          description:
            "Initial plain text or markdown-lite content. It is inserted as plain Google Doc paragraphs.",
        },
        share_with_requester: {
          type: "boolean" as const,
          description:
            "Whether to share the finished document with the requesting staff member as a writer (default true).",
        },
        image_storage_ids: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Optional approved image storageRefs to embed. Use only a visible storageRef from an image available in this conversation; at most four PNG, JPEG, or GIF images.",
        },
      },
      required: ["title", "initial_content"] as const,
    },
    run: async (input) => {
      const title = input.title.trim();
      if (!title) return "Provide a title for the Google Doc.";
      if (!input.initial_content.trim()) {
        return "Provide non-empty initial content for the Google Doc.";
      }

      const shareWithRequester = input.share_with_requester ?? true;
      const docsAccess = await resolveDocsToken();
      if ("error" in docsAccess) return docsAccess.error;
      const images = await resolveImageUris(
        (input as { image_storage_ids?: unknown }).image_storage_ids,
        docsAccess.institutionId,
      );
      if ("error" in images) return images.error;
      return await createSharedDocument({
        institutionId: docsAccess.institutionId,
        token: docsAccess.token,
        title,
        initialContent: input.initial_content,
        shareWithRequester,
        imageUris: images.uris,
        toolName: "create_shared_doc",
      });
    },
  });

  const editor = new GoogleDocsEditor({
    create: async ({ title, fileText }) => {
      const docsAccess = await resolveDocsToken();
      if ("error" in docsAccess) return docsAccess.error;
      return await createSharedDocument({
        institutionId: docsAccess.institutionId,
        token: docsAccess.token,
        title,
        initialContent: fileText,
        shareWithRequester: true,
        imageUris: [],
        toolName: "str_replace_based_edit_tool",
      });
    },
  });
  const editSharedDocTool = {
    type: "text_editor_20250728" as const,
    name: "str_replace_based_edit_tool" as const,
    max_characters: 100_000,
    input_examples: [
      {
        command: "view",
        path: "https://docs.google.com/document/d/DOCUMENT_ID/edit",
      },
      {
        command: "str_replace",
        path: "DOCUMENT_ID",
        old_str: "Exact text from the preceding view",
        new_str: "Replacement text",
      },
    ],
    parse: parseGoogleDocsEditorInput,
    run: async (
      input: ReturnType<typeof parseGoogleDocsEditorInput>,
      context?: { toolUseBlock: { id: string } },
    ) => {
      const toolUseId = context?.toolUseBlock.id;
      if (!toolUseId) {
        return "IDEMPOTENCY_KEY_MISSING: the editor requires the tool_use id.";
      }
      const docsAccess = await resolveDocsToken();
      if ("error" in docsAccess) return docsAccess.error;

      const result = await editor.execute(docsAccess.token, input, {
        toolUseId,
      });
      if (input.command !== "create") {
        // The staff tool-activity log renders this string verbatim; the full
        // editor result (post-edit excerpt etc.) is for the model only.
        const firstLine = result.split("\n", 1)[0];
        emit({
          toolComplete: {
            name: "str_replace_based_edit_tool",
            result:
              input.command === "view"
                ? "Viewed Google Doc"
                : firstLine.length > 120
                  ? `${firstLine.slice(0, 117)}...`
                  : firstLine,
          },
        });
      }
      return result;
    },
  };

  return [createSharedDocTool, editSharedDocTool];
}
