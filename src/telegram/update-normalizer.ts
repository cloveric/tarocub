import { getTelegramConversationKey } from "./conversation-key.js";

export interface NormalizedTelegramAttachment {
  fileId: string;
  fileName?: string;
  kind: "audio" | "document" | "photo" | "video" | "voice";
}

export interface NormalizedTelegramMessage {
  chatId: number;
  userId: number;
  chatType: string;
  messageThreadId?: number;
  conversationKey?: string;
  text: string;
  callbackQueryId?: string;
  replyContext?: {
    messageId: number;
    text: string;
    photoFileId?: string;
    documentFileId?: string;
    documentFileName?: string;
    audioAttachment?: NormalizedTelegramAttachment;
  };
  attachments: NormalizedTelegramAttachment[];
}

function normalizeCallbackCommand(data: string): string | null {
  const approval = data.match(/^approval:([A-Za-z0-9_-]+):(once|session|deny)$/i);
  if (approval) {
    return `/approval ${approval[1]} ${approval[2]!.toLowerCase()}`;
  }

  const rawContinueData = data.startsWith("continue-archive:")
    ? data.slice("continue-archive:".length).trim()
    : null;
  if (
    rawContinueData &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawContinueData)
  ) {
    return `/continue --upload ${rawContinueData}`;
  }

  return null;
}

function isExternalTelegramChatType(value: unknown): value is string {
  return value === "private" || value === "group" || value === "supergroup" || value === "channel";
}

function normalizeCallbackQuery(callbackQuery: any, text: string): NormalizedTelegramMessage | null {
  const message = callbackQuery.message;
  const chatId = message?.chat?.id;
  const userId = callbackQuery?.from?.id;
  const chatType = message?.chat?.type;

  if (typeof chatId !== "number" || typeof userId !== "number" || !isExternalTelegramChatType(chatType)) {
    return null;
  }

  const messageThreadId = typeof message?.message_thread_id === "number" ? message.message_thread_id : undefined;
  return {
    chatId,
    userId,
    chatType,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    conversationKey: getTelegramConversationKey(chatId, messageThreadId),
    text,
    callbackQueryId: typeof callbackQuery.id === "string" ? callbackQuery.id : undefined,
    attachments: [],
  };
}

function normalizeReplyContext(message: any): NormalizedTelegramMessage["replyContext"] {
  const reply = message?.reply_to_message;
  const messageId = reply?.message_id;
  if (typeof messageId !== "number") {
    return undefined;
  }

  const replyText =
    typeof reply?.text === "string"
      ? reply.text
      : typeof reply?.caption === "string"
        ? reply.caption
        : "";

  let photoFileId: string | undefined;
  if (Array.isArray(reply?.photo) && reply.photo.length > 0) {
    const largest = reply.photo[reply.photo.length - 1];
    if (typeof largest?.file_id === "string") {
      photoFileId = largest.file_id;
    }
  }

  const audioAttachment = normalizeAudioAttachment(reply)[0]
    ?? normalizeVoiceAttachment(reply)[0]
    ?? normalizeVideoAttachment(reply)[0]
    ?? normalizeVideoNoteAttachment(reply)[0]
    ?? (isAudioDocument(reply) || isVideoDocument(reply) ? normalizeDocumentAttachment(reply)[0] : undefined);

  let documentFileId: string | undefined;
  let documentFileName: string | undefined;
  if (!audioAttachment && typeof reply?.document?.file_id === "string") {
    documentFileId = reply.document.file_id;
    documentFileName = typeof reply.document.file_name === "string" ? reply.document.file_name : undefined;
  }

  return {
    messageId,
    text: replyText,
    ...(photoFileId !== undefined ? { photoFileId } : {}),
    ...(documentFileId !== undefined ? { documentFileId } : {}),
    ...(documentFileName !== undefined ? { documentFileName } : {}),
    ...(audioAttachment !== undefined ? { audioAttachment } : {}),
  };
}

const AUDIO_FILE_NAME_PATTERN = /\.(aac|aiff?|flac|m4a|m4b|mp3|oga|ogg|opus|wav|webm)$/i;
const VIDEO_FILE_NAME_PATTERN = /\.(avi|m4v|mkv|mov|mp4|webm)$/i;

function isAudioDocument(message: any): boolean {
  const mimeType = typeof message?.document?.mime_type === "string" ? message.document.mime_type : "";
  const normalizedMimeType = mimeType.toLowerCase();
  const fileName = typeof message?.document?.file_name === "string" ? message.document.file_name : "";
  return normalizedMimeType.startsWith("audio/")
    || (!normalizedMimeType.startsWith("video/") && AUDIO_FILE_NAME_PATTERN.test(fileName));
}

function isVideoDocument(message: any): boolean {
  const mimeType = typeof message?.document?.mime_type === "string" ? message.document.mime_type : "";
  const normalizedMimeType = mimeType.toLowerCase();
  const fileName = typeof message?.document?.file_name === "string" ? message.document.file_name : "";
  return normalizedMimeType.startsWith("video/")
    || (!normalizedMimeType.startsWith("audio/") && VIDEO_FILE_NAME_PATTERN.test(fileName));
}

function normalizeDocumentAttachment(message: any): NormalizedTelegramAttachment[] {
  const fileId = message?.document?.file_id;
  if (typeof fileId !== "string" || fileId.length === 0) {
    return [];
  }
  if (isAudioDocument(message)) {
    return [
      {
        fileId,
        fileName: typeof message.document.file_name === "string" ? message.document.file_name : undefined,
        kind: "audio",
      },
    ];
  }
  if (isVideoDocument(message)) {
    return [
      {
        fileId,
        fileName: typeof message.document.file_name === "string" ? message.document.file_name : undefined,
        kind: "video",
      },
    ];
  }

  return [
    {
      fileId,
      fileName: typeof message.document.file_name === "string" ? message.document.file_name : undefined,
      kind: "document",
    },
  ];
}

function normalizeAudioAttachment(message: any): NormalizedTelegramAttachment[] {
  const fileId = message?.audio?.file_id;
  if (typeof fileId !== "string" || fileId.length === 0) {
    return [];
  }

  return [
    {
      fileId,
      fileName: typeof message.audio.file_name === "string" ? message.audio.file_name : undefined,
      kind: "audio",
    },
  ];
}

function normalizePhotoAttachment(message: any): NormalizedTelegramAttachment[] {
  if (!Array.isArray(message?.photo) || message.photo.length === 0) {
    return [];
  }

  const candidate = message.photo[message.photo.length - 1];
  if (typeof candidate?.file_id !== "string" || candidate.file_id.length === 0) {
    return [];
  }

  return [
    {
      fileId: candidate.file_id,
      kind: "photo",
    },
  ];
}

function normalizeVideoAttachment(message: any): NormalizedTelegramAttachment[] {
  const fileId = message?.video?.file_id;
  if (typeof fileId !== "string" || fileId.length === 0) {
    return [];
  }

  return [
    {
      fileId,
      fileName: typeof message.video.file_name === "string" ? message.video.file_name : undefined,
      kind: "video",
    },
  ];
}

function normalizeVideoNoteAttachment(message: any): NormalizedTelegramAttachment[] {
  const fileId = message?.video_note?.file_id;
  if (typeof fileId !== "string" || fileId.length === 0) {
    return [];
  }

  return [
    {
      fileId,
      kind: "video",
    },
  ];
}

function normalizeVoiceAttachment(message: any): NormalizedTelegramAttachment[] {
  const fileId = message?.voice?.file_id;
  if (typeof fileId !== "string" || fileId.length === 0) {
    return [];
  }

  return [
    {
      fileId,
      kind: "voice",
    },
  ];
}

export function normalizeUpdate(update: any): NormalizedTelegramMessage | null {
  const callbackQuery = update?.callback_query;
  if (typeof callbackQuery?.data === "string") {
    const callbackCommand = normalizeCallbackCommand(callbackQuery.data);
    if (callbackCommand) {
      return normalizeCallbackQuery(callbackQuery, callbackCommand);
    }
  }

  const message = update?.message;
  const chatId = message?.chat?.id;
  const userId = message?.from?.id;
  const chatType = message?.chat?.type;

  if (typeof chatId !== "number" || typeof userId !== "number" || !isExternalTelegramChatType(chatType)) {
    return null;
  }

  const messageThreadId = typeof message?.message_thread_id === "number" ? message.message_thread_id : undefined;
  return {
    chatId,
    userId,
    chatType,
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    conversationKey: getTelegramConversationKey(chatId, messageThreadId),
    text:
      typeof message.text === "string"
        ? message.text
        : typeof message.caption === "string"
          ? message.caption
          : "",
    replyContext: normalizeReplyContext(message),
    attachments: [
      ...normalizeAudioAttachment(message),
      ...normalizeDocumentAttachment(message),
      ...normalizePhotoAttachment(message),
      ...normalizeVideoAttachment(message),
      ...normalizeVideoNoteAttachment(message),
      ...normalizeVoiceAttachment(message),
    ],
  };
}
