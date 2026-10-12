import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated from "react-native-reanimated";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "expo-router";

import { AppTextInput } from "@/components/AppTextInput";
import { openMarkdownLink } from "@/components/Markdown";
import { useOpenEmbeddedWebContent } from "@/lib/externalAppHost";
import { ScholarAvatar } from "@/components/ScholarAvatar";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { useMessageAttachments } from "@/hooks/useMessageAttachments";
import { api, type Id } from "@/lib/convex";
import { chatBubbleStyles } from "@/lib/chatBubbles";
import { CHAT_COMPOSER_INPUT } from "@/lib/chatType";
import {
  attachmentsByMessage,
  isImageMime,
  REPLIES_CLOSED,
  REPLY_PLACEHOLDER,
  relativeTime,
  threadSubtitle,
  type ScholarThreadAttachment,
  type ScholarThreadDetail,
  type ScholarThreadMessage,
} from "@/lib/scholarMessages";
import { resolveUserImageUri } from "@/lib/webEmbedConfig";
import { fonts, useColors, type Colors } from "@/theme";
import { serverErrorMessage } from "../../../vendor/shared/serverErrorMessage";
import { editWindowOpen } from "../../../vendor/shared/messageEditWindow";
import { tokenizeMessageLinks } from "../../../vendor/shared/messageLinks";

type Styles = ReturnType<typeof makeStyles>;
/** A row's frame inside the transcript's content container. */
type RowFrame = { y: number; height: number };

/**
 * One scholar ↔ staff conversation (S3): the counterpart header, the quiet
 * open-door caption (server-authored — same weight as the homework "Your
 * teacher can read this" line: a fact, not a warning), bubbles (mine right,
 * theirs left with the author's name), photos inline, and a reply composer
 * with a 📎 for camera/Photos. Opening it marks it read. Web twin: the scholar
 * MessageThread.
 */
export function ThreadView({ threadId }: { threadId: Id<"parentThreads"> }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const detail = useQuery(api.scholarMessages.getThread, { threadId });
  const attachments = useQuery(api.scholarMessages.getThreadAttachments, {
    threadId,
  });
  const markRead = useMutation(api.scholarMessages.markRead);
  const scrollRef = useRef<ScrollView>(null);
  // Keyboard awareness — the session chat's pattern (app/session/[id].tsx):
  // ONE animated bottom inset from useKeyboardInset shrinks this whole pane by
  // the keyboard's height, so the composer rides above the keyboard and the
  // transcript gives up the space. Not KeyboardAvoidingView: its frame-based
  // heuristic misplaces a pane that isn't full-screen (the two-pane layout),
  // and not useAnimatedKeyboard (mismeasures on iPad landscape — see the hook).
  const { style: keyboardInsetStyle } = useKeyboardInset();
  // When the transcript's viewport shrinks (keyboard up) or its content grows,
  // keep the right thing in view: the message being edited inline if there is
  // one, else the newest message.
  const viewportHeight = useRef(0);
  const editingFrame = useRef<RowFrame | null>(null);
  const reveal = useCallback(() => {
    const frame = editingFrame.current;
    if (frame) {
      scrollRef.current?.scrollTo({
        y: Math.max(0, frame.y + frame.height - viewportHeight.current + 16),
        animated: true,
      });
    } else {
      scrollRef.current?.scrollToEnd({ animated: true });
    }
  }, []);
  const onEditFrame = useCallback(
    (frame: RowFrame | null) => {
      editingFrame.current = frame;
      if (frame) reveal();
    },
    [reveal],
  );
  // The full-screen viewer holds the ATTACHMENT, not a URL: its URL is derived
  // from the live attachment list, so a photo withdrawn/removed while it's
  // open closes the viewer instead of lingering on screen.
  const [viewerId, setViewerId] = useState<Id<"parentMessageAttachments"> | null>(null);
  const viewerUrl =
    viewerId === null
      ? null
      : (attachments?.find((a) => a._id === viewerId && !a.retracted)?.url ?? null);
  // The clock, ticked rather than read per render: relative stamps ("5m ago")
  // and the 10-minute edit window — the query returns `editableUntil` and
  // won't re-run by itself when it passes, so Edit/Withdraw hide on this tick
  // (the server refuses late edits regardless).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Mark read on open AND whenever a new message lands while it's open — but
  // only while the kid can actually SEE the transcript: the app is in the
  // foreground, this screen is focused (not buried under a pushed screen), and
  // nothing covers it (the full-screen photo viewer, or the root-level embedded
  // web/YouTube host a tapped link opens — an overlay, not a navigation, so
  // focus alone misses it). Coming back marks what
  // arrived meanwhile. Keyed on the newest message so a re-render never
  // re-sends the same mark.
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => sub.remove();
  }, []);
  const focused = useIsFocused();
  const embeddedHostOpen = useOpenEmbeddedWebContent() !== null;
  // A file attachment (a PDF) opens in the in-app browser sheet, which leaves
  // AppState "active" — so the sheet is tracked explicitly: covered while the
  // openBrowserAsync promise is pending, visible again once it resolves.
  const [browserOpen, setBrowserOpen] = useState(false);
  const openFile = useCallback((url: string) => {
    setBrowserOpen(true);
    void WebBrowser.openBrowserAsync(url)
      .catch((e: unknown) => console.warn("[messages] open file failed", e))
      .then(() => setBrowserOpen(false));
  }, []);
  const transcriptVisible =
    appActive && focused && viewerUrl === null && !embeddedHostOpen && !browserOpen;
  const newestId = detail?.messages.at(-1)?._id ?? null;
  const markedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!detail || !transcriptVisible) return;
    const key = `${threadId}:${newestId ?? ""}`;
    if (markedKey.current === key) return;
    markedKey.current = key;
    markRead({ threadId }).catch((e) =>
      console.warn("[messages] markRead failed", e),
    );
  }, [detail, newestId, threadId, markRead, transcriptVisible]);

  if (detail === undefined) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.violet} />
      </View>
    );
  }
  if (detail === null) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>This conversation isn&apos;t available.</Text>
      </View>
    );
  }

  const byMessage = attachmentsByMessage(attachments);

  return (
    <Animated.View style={[styles.flex, keyboardInsetStyle]}>
      <ThreadHeader detail={detail} styles={styles} />
      {/* The open-door line is pinned under the header, OUTSIDE the scrolling
          transcript: the transcript opens scrolled to the newest message, so
          a caption inside it would scroll away in any longer conversation. */}
      {detail.openDoorCaption ? (
        <Text style={styles.caption}>{detail.openDoorCaption}</Text>
      ) : null}
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.transcript}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onLayout={(e) => {
          viewportHeight.current = e.nativeEvent.layout.height;
          reveal();
        }}
        onContentSizeChange={reveal}
      >
        {detail.messages.map((message) => (
          <MessageRow
            key={message._id}
            message={message}
            attachments={byMessage.get(message._id) ?? []}
            now={now}
            onEditFrame={onEditFrame}
            onOpenImage={setViewerId}
            onOpenFile={openFile}
            colors={colors}
            styles={styles}
          />
        ))}
      </ScrollView>
      {detail.canReply ? (
        <Composer
          threadId={threadId}
          placeholder={REPLY_PLACEHOLDER}
          colors={colors}
          styles={styles}
        />
      ) : (
        <Text style={styles.closed}>{REPLIES_CLOSED}</Text>
      )}
      <PhotoViewer url={viewerUrl} onClose={() => setViewerId(null)} styles={styles} />
    </Animated.View>
  );
}

function ThreadHeader({
  detail,
  styles,
}: {
  detail: ScholarThreadDetail;
  styles: Styles;
}) {
  const colors = useColors();
  const mentor = detail.kind === "mentor";
  const person = mentor ? detail.staffParticipants[0] : undefined;
  const subtitle = threadSubtitle(detail);

  return (
    <View style={styles.header}>
      {mentor ? (
        <ScholarAvatar
          name={person?.name ?? detail.title}
          image={resolveUserImageUri(person?.image)}
          size={40}
        />
      ) : (
        <View style={styles.workshopTile} accessible accessibilityLabel="Workshop">
          <SymbolView
            name="wrench.and.screwdriver.fill"
            size={19}
            tintColor={colors.orange}
          />
        </View>
      )}
      <View style={styles.headerText}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {detail.title}
        </Text>
        {subtitle ? (
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function MessageRow({
  message,
  attachments,
  now,
  onEditFrame,
  onOpenImage,
  onOpenFile,
  colors,
  styles,
}: {
  message: ScholarThreadMessage;
  attachments: ScholarThreadAttachment[];
  now: number;
  /** Reports this row's frame while it's being edited inline (null when the
   *  edit ends), so the transcript keeps the field above the keyboard. */
  onEditFrame: (frame: RowFrame | null) => void;
  onOpenImage: (attachmentId: Id<"parentMessageAttachments">) => void;
  onOpenFile: (url: string) => void;
  colors: Colors;
  styles: Styles;
}) {
  const editMessage = useMutation(api.scholarMessages.editMessage);
  const retractMessage = useMutation(api.scholarMessages.retractMessage);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [saving, setSaving] = useState(false);
  const mine = message.mine;
  const stamp = relativeTime(message.createdAt, now);
  const editable = editWindowOpen(message.editableUntil, now);
  // A photo message may keep an empty caption — the server allows an empty
  // body while the message still has live attachments.
  const hasLiveAttachments = attachments.some((a) => !a.retracted);
  const canSaveDraft = draft.trim().length > 0 || hasLiveAttachments;
  const stopEditing = () => {
    setEditing(false);
    onEditFrame(null);
  };

  if (message.retracted) {
    return (
      <View style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}>
        <View style={mine ? styles.colMine : styles.colTheirs}>
          <Text style={styles.meta}>
            {mine ? "You" : message.authorName} · {stamp}
          </Text>
          <Text style={styles.tombstone}>Message withdrawn</Text>
        </View>
      </View>
    );
  }

  // Honest about what can't be undone: once a copy left Rabbithole (the
  // mentor's email, a Workshop Slack thread) it can't be recalled.
  const withdraw = () =>
    Alert.alert("Withdraw message", withdrawConfirmBody(message.copiedOutside), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Withdraw",
        style: "destructive",
        onPress: () => {
          retractMessage({ messageId: message._id }).catch((e) =>
            Alert.alert(
              "Couldn't withdraw that",
              serverErrorMessage(e, "Please try again."),
            ),
          );
        },
      },
    ]);

  const openActions = () => {
    if (!editable) return;
    Haptics.selectionAsync();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Cancel", "Edit", "Withdraw message"],
        cancelButtonIndex: 0,
        destructiveButtonIndex: 2,
      },
      (i) => {
        if (i === 1) {
          setDraft(message.body);
          setEditing(true);
        } else if (i === 2) {
          withdraw();
        }
      },
    );
  };

  const save = async () => {
    const body = draft.trim();
    if (!canSaveDraft || saving) return;
    if (body === message.body) {
      stopEditing();
      return;
    }
    setSaving(true);
    // .then/.catch rather than try/finally: React Compiler can't lower a
    // `finally` clause, and this component should stay compiled.
    await editMessage({ messageId: message._id, body }).then(
      stopEditing,
      (e: unknown) =>
        Alert.alert("Couldn't save that", serverErrorMessage(e, "Please try again.")),
    );
    setSaving(false);
  };

  const visibleAttachments = attachments.filter((a) => !a.retracted);

  return (
    <View
      style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}
      onLayout={
        editing
          ? (e) => {
              const { y, height } = e.nativeEvent.layout;
              onEditFrame({ y, height });
            }
          : undefined
      }
    >
      {mine && editable && !editing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Message actions"
          onPress={openActions}
          hitSlop={10}
          style={styles.actionsBtn}
        >
          <SymbolView name="ellipsis" size={16} tintColor={colors.charcoalSubtle} />
        </Pressable>
      ) : null}
      <View style={mine ? styles.colMine : styles.colTheirs}>
        {!mine ? <Text style={styles.author}>{message.authorName}</Text> : null}
        {editing ? (
          <View style={styles.editBox}>
            <AppTextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              autoFocus
              style={styles.editInput}
              accessibilityLabel="Edit message"
            />
            {message.copiedOutside ? (
              <Text style={styles.editHonesty}>{EDIT_COPY_HONESTY}</Text>
            ) : null}
            <View style={styles.editActions}>
              <Pressable
                accessibilityRole="button"
                onPress={stopEditing}
                hitSlop={8}
              >
                <Text style={styles.editCancel}>Cancel</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={save}
                disabled={!canSaveDraft || saving}
                hitSlop={8}
              >
                <Text style={[styles.editSave, (!canSaveDraft || saving) && { opacity: 0.4 }]}>
                  Save
                </Text>
              </Pressable>
            </View>
          </View>
        ) : message.body ? (
          <Pressable
            onLongPress={editable ? openActions : undefined}
            delayLongPress={350}
            style={[styles.bubble, mine ? styles.mine : styles.theirs]}
          >
            <Text style={[styles.bubbleText, mine && styles.textMine]} selectable>
              <LinkifiedBody body={message.body} mine={mine} styles={styles} />
            </Text>
          </Pressable>
        ) : null}
        {visibleAttachments.map((attachment) => (
          <AttachmentView
            key={attachment._id}
            attachment={attachment}
            copiedOutside={message.copiedOutside}
            removable={mine && editable && attachment.canRetract && !editing}
            onOpenImage={onOpenImage}
            onOpenFile={onOpenFile}
            colors={colors}
            styles={styles}
          />
        ))}
        <Text style={styles.meta}>
          {stamp}
          {message.editedAt !== null ? " · edited" : ""}
        </Text>
      </View>
    </View>
  );
}

function AttachmentView({
  attachment,
  copiedOutside,
  removable,
  onOpenImage,
  onOpenFile,
  colors,
  styles,
}: {
  attachment: ScholarThreadAttachment;
  /** The message already left Rabbithole (email / Slack). */
  copiedOutside: boolean;
  /** Own message, inside the edit window, and the server allows it. */
  removable: boolean;
  onOpenImage: (attachmentId: Id<"parentMessageAttachments">) => void;
  onOpenFile: (url: string) => void;
  colors: Colors;
  styles: Styles;
}) {
  const retractAttachment = useMutation(api.scholarMessages.retractAttachment);
  const url = attachment.url;

  const confirmRemove = () =>
    Alert.alert(
      "Remove attachment",
      removeAttachmentConfirmBody(attachment.fileName, copiedOutside),
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            retractAttachment({ attachmentId: attachment._id }).catch((e: unknown) =>
              Alert.alert(
                "Couldn't remove that",
                serverErrorMessage(e, "Please try again."),
              ),
            );
          },
        },
      ],
    );

  const removeButton = removable ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Remove attachment ${attachment.fileName}`}
      onPress={confirmRemove}
      hitSlop={8}
      style={styles.attachmentRemove}
    >
      <SymbolView name="xmark.circle.fill" size={22} tintColor={colors.charcoal} />
    </Pressable>
  ) : null;

  if (url && isImageMime(attachment.mimeType)) {
    return (
      <View>
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={`Photo: ${attachment.fileName}`}
          onPress={() => onOpenImage(attachment._id)}
        >
          <Image
            source={{ uri: url }}
            style={styles.photo}
            contentFit="cover"
            alt={attachment.fileName}
          />
        </Pressable>
        {removeButton}
      </View>
    );
  }
  return (
    <View style={styles.fileRow}>
      <Pressable
        accessibilityRole="link"
        disabled={!url}
        onPress={() => {
          if (url) onOpenFile(url);
        }}
        style={styles.fileChip}
      >
        <SymbolView name="paperclip" size={14} tintColor={colors.charcoalMuted} />
        <Text style={styles.fileName} numberOfLines={1}>
          {attachment.fileName}
        </Text>
      </Pressable>
      {removable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove attachment ${attachment.fileName}`}
          onPress={confirmRemove}
          hitSlop={8}
        >
          <SymbolView name="xmark.circle.fill" size={18} tintColor={colors.charcoalSubtle} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Withdraw/remove confirmation copy — the product call shared word for word
 *  with the web row (components/messaging/MessageRow.tsx). Honest on two
 *  counts: a withdrawal leaves a tombstone that staff can still read behind,
 *  and a copy that already left Rabbithole (mentor email, Slack) can't be
 *  recalled. */
const COPY_RECALL_HONESTY = "A copy already sent by email or Slack can't be recalled.";
const EDIT_COPY_HONESTY = "Copies already sent by email or Slack won't change.";

function withHonesty(line: string, copiedOutside: boolean): string {
  return copiedOutside ? `${line} ${COPY_RECALL_HONESTY}` : line;
}

function withdrawConfirmBody(copiedOutside: boolean): string {
  return withHonesty(
    "This replaces it with \u201cMessage withdrawn.\u201d Staff can still see the original.",
    copiedOutside,
  );
}

function removeAttachmentConfirmBody(fileName: string, copiedOutside: boolean): string {
  return withHonesty(
    `This removes \u201c${fileName}\u201d from the conversation. Staff can still see it.`,
    copiedOutside,
  );
}

/** A message body with its `[label](url)` links and bare http(s) URLs tappable — the web bubble's
 *  tokenizer (vendored lib/messageLinks.ts) and the tutor chat's tap path
 *  (openMarkdownLink: YouTube in the locked-down player, else outbound). */
function LinkifiedBody({
  body,
  mine,
  styles,
}: {
  body: string;
  mine: boolean;
  styles: Styles;
}) {
  return tokenizeMessageLinks(body).map((token, i) =>
    token.type !== "text" ? (
      <Text
        key={i}
        accessibilityRole="link"
        onPress={() =>
          token.type === "link"
            ? openMarkdownLink(token.url, token.label)
            : openMarkdownLink(token.value, token.value)
        }
        style={mine ? styles.linkMine : styles.link}
      >
        {token.type === "link" ? token.label : token.value}
      </Text>
    ) : (
      token.value
    ),
  );
}

function PhotoViewer({
  url,
  onClose,
  styles,
}: {
  url: string | null;
  onClose: () => void;
  styles: Styles;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={url !== null}
      animationType="fade"
      presentationStyle="overFullScreen"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.viewer}>
        {url ? (
          <Image
            source={{ uri: url }}
            style={styles.viewerImage}
            contentFit="contain"
            alt="Photo, full size"
          />
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done"
          onPress={onClose}
          hitSlop={10}
          style={[styles.viewerDone, { top: insets.top + 12 }]}
        >
          <Text style={styles.viewerDoneText}>Done</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function Composer({
  threadId,
  placeholder,
  colors,
  styles,
}: {
  threadId: Id<"parentThreads">;
  placeholder: string;
  colors: Colors;
  styles: Styles;
}) {
  const reply = useMutation(api.scholarMessages.reply);
  const files = useMessageAttachments();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const body = text.trim();
  const canSend =
    (body.length > 0 || files.attachments.length > 0) && !sending && !files.uploading;

  const openAttach = useCallback(() => {
    Haptics.selectionAsync();
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ["Cancel", "Take photo", "Choose from Photos"], cancelButtonIndex: 0 },
      (i) => {
        if (i === 1) void files.pick("camera");
        else if (i === 2) void files.pick("library");
      },
    );
  }, [files]);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setSendError("");
    // .then(ok, fail) rather than try/finally — see `save` above.
    await reply({
      threadId,
      body,
      attachmentIds: files.attachmentIds.length > 0 ? files.attachmentIds : undefined,
    }).then(
      () => {
        setText("");
        files.clearSent();
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      },
      (e: unknown) => setSendError(serverErrorMessage(e, "That didn't send. Try again.")),
    );
    setSending(false);
  };

  const error = sendError || files.error;

  return (
    <View style={styles.composer}>
      {files.attachments.length > 0 ? (
        <View style={styles.pendingRow}>
          {files.attachments.map((a) => (
            <View key={a.attachmentId} style={styles.pendingThumbWrap}>
              <Image
                source={{ uri: a.localUri }}
                style={styles.pendingThumb}
                contentFit="cover"
                alt={a.fileName}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${a.fileName}`}
                onPress={() => void files.remove(a.attachmentId)}
                hitSlop={8}
                style={styles.pendingRemove}
              >
                <SymbolView name="xmark.circle.fill" size={20} tintColor={colors.charcoal} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.inputWrap}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={files.uploading ? "Adding a photo" : "Add a photo"}
          onPress={openAttach}
          disabled={files.uploading || sending}
          hitSlop={8}
          style={styles.attachBtn}
        >
          {files.uploading ? (
            <ActivityIndicator color={colors.violet} />
          ) : (
            <SymbolView name="paperclip" size={22} tintColor={colors.violet} />
          )}
        </Pressable>
        <AppTextInput
          style={styles.input}
          value={text}
          onChangeText={(t) => {
            setText(t);
            if (sendError) setSendError("");
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.charcoalSubtle}
          multiline
          editable={!sending}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          onPress={send}
          disabled={!canSend}
          hitSlop={8}
          style={styles.sendBtn}
        >
          {sending ? (
            <ActivityIndicator color={colors.violet} style={{ margin: 8 }} />
          ) : (
            <SymbolView
              name="arrow.up.circle.fill"
              size={36}
              tintColor={canSend ? colors.violet : colors.gray300}
            />
          )}
        </Pressable>
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

function makeStyles(c: Colors) {
  const shared = chatBubbleStyles(c);
  return StyleSheet.create({
    ...shared,
    flex: { flex: 1, backgroundColor: c.bgSubtle },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.bgSubtle,
      padding: 24,
    },
    emptyText: {
      fontSize: 15,
      lineHeight: 22,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
      textAlign: "center",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.bgSubtle,
    },
    headerText: { flex: 1, minWidth: 0 },
    headerTitle: { fontSize: 17, fontFamily: fonts.bold, color: c.navy },
    headerSubtitle: {
      fontSize: 13.5,
      fontFamily: fonts.regular,
      color: c.charcoalSubtle,
      marginTop: 1,
    },
    // Workshop threads wear the Workshop's glyph (ThreadList does the same) —
    // never an "idea" label on a thread that isn't one.
    workshopTile: {
      width: 40,
      height: 40,
      borderRadius: 10,
      backgroundColor: c.orangeSubtle,
      borderWidth: 1,
      borderColor: c.orangeMuted,
      alignItems: "center",
      justifyContent: "center",
    },
    transcript: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12, gap: 4 },
    // The open-door line: the same quiet register as the reflection chat's
    // TEACHER_LINE footer (app/meta.tsx chatFooter) — a fact, not a warning.
    caption: {
      fontSize: 12.5,
      lineHeight: 18,
      fontFamily: fonts.regular,
      color: c.charcoalSubtle,
      textAlign: "center",
      paddingVertical: 6,
      paddingHorizontal: 20,
      backgroundColor: c.bgSubtle,
    },
    row: { flexDirection: "row", alignItems: "center", marginVertical: 6, gap: 6 },
    rowMine: { justifyContent: "flex-end" },
    rowTheirs: { justifyContent: "flex-start" },
    colMine: { maxWidth: "78%", alignItems: "flex-end", gap: 4 },
    colTheirs: { maxWidth: "78%", alignItems: "flex-start", gap: 4 },
    // Their turn: a white card bubble (the tutor's bare voice is for the AI —
    // a person gets a bubble), tucked bottom-left to mirror `mine`.
    theirs: {
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderBottomLeftRadius: 7,
    },
    author: {
      fontSize: 12.5,
      fontFamily: fonts.bold,
      color: c.charcoalSubtle,
      marginLeft: 4,
    },
    meta: {
      fontSize: 11.5,
      fontFamily: fonts.regular,
      color: c.charcoalSubtle,
      marginHorizontal: 4,
    },
    tombstone: {
      fontSize: 14,
      fontFamily: fonts.regular,
      fontStyle: "italic",
      color: c.charcoalSubtle,
      marginHorizontal: 4,
    },
    actionsBtn: { padding: 4 },
    editBox: {
      minWidth: 280,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.violetMuted,
      borderRadius: 18,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    editInput: {
      minHeight: 40,
      maxHeight: 160,
      color: c.fg,
      ...CHAT_COMPOSER_INPUT,
      fontFamily: fonts.regular,
    },
    editHonesty: {
      fontSize: 12.5,
      lineHeight: 18,
      fontFamily: fonts.regular,
      color: c.charcoalSubtle,
      paddingTop: 4,
    },
    editActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 18,
      paddingTop: 6,
    },
    editCancel: { fontSize: 14, fontFamily: fonts.semibold, color: c.charcoalMuted },
    editSave: { fontSize: 14, fontFamily: fonts.bold, color: c.violet },
    photo: {
      width: 240,
      height: 180,
      borderRadius: 16,
      backgroundColor: c.gray100,
    },
    fileChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      maxWidth: 260,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    link: { color: c.violet, textDecorationLine: "underline" },
    linkMine: { color: c.white, textDecorationLine: "underline" },
    attachmentRemove: {
      position: "absolute",
      top: -8,
      right: -8,
      backgroundColor: c.bg,
      borderRadius: 999,
    },
    fileRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    closed: {
      fontSize: 12.5,
      lineHeight: 18,
      fontFamily: fonts.regular,
      color: c.charcoalSubtle,
      textAlign: "center",
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    fileName: { flexShrink: 1, fontSize: 13.5, fontFamily: fonts.medium, color: c.charcoal },
    viewer: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)" },
    viewerImage: { flex: 1 },
    viewerDone: {
      position: "absolute",
      right: 20,
      backgroundColor: "rgba(255,255,255,0.18)",
      borderRadius: 999,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    viewerDoneText: { fontSize: 16, fontFamily: fonts.semibold, color: "#fff" },
    // Composer — same field treatment as the reflection chat (app/meta.tsx).
    composer: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 },
    pendingRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 8 },
    pendingThumbWrap: { width: 64, height: 64 },
    pendingThumb: { width: 64, height: 64, borderRadius: 12, backgroundColor: c.gray100 },
    pendingRemove: {
      position: "absolute",
      top: -8,
      right: -8,
      backgroundColor: c.bg,
      borderRadius: 999,
    },
    inputWrap: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 20,
      backgroundColor: c.bg,
      paddingLeft: 8,
      paddingRight: 6,
      paddingVertical: 4,
    },
    attachBtn: {
      width: 36,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
    },
    input: {
      flex: 1,
      minHeight: 40,
      maxHeight: 120,
      color: c.fg,
      ...CHAT_COMPOSER_INPUT,
      fontFamily: fonts.regular,
      paddingVertical: 9,
    },
    sendBtn: { paddingBottom: 2 },
    errorText: {
      color: c.statusRed,
      fontSize: 13,
      lineHeight: 19,
      fontFamily: fonts.semibold,
      marginTop: 6,
      marginLeft: 4,
    },
  });
}
