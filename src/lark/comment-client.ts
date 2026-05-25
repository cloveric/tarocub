import {
  Client,
  type LarkChannelOptions,
} from "@larksuiteoapi/node-sdk";

export type LarkCommentFileType = "doc" | "docx" | "sheet" | "file" | "slides" | "bitable";

export interface LarkCommentReplyContext {
  replyId?: string;
  userId?: string;
  text: string;
  docsLinks: string[];
}

export interface LarkCommentContext {
  quote?: string;
  replies: LarkCommentReplyContext[];
}

export interface LarkCommentClientLike {
  getCommentContext(input: {
    fileToken: string;
    fileType: LarkCommentFileType;
    commentId: string;
  }): Promise<LarkCommentContext>;
  createReply(input: {
    fileToken: string;
    fileType: LarkCommentFileType;
    commentId: string;
    text: string;
  }): Promise<void>;
}

type LarkCommentElement = {
  type?: string;
  text_run?: { text?: string };
  docs_link?: { url?: string };
  person?: { user_id?: string };
};

type LarkCommentReplyApiItem = {
  reply_id?: string;
  user_id?: string;
  content?: {
    elements?: LarkCommentElement[];
  };
};

type LarkCommentApiItem = {
  comment_id?: string;
  quote?: string;
  reply_list?: {
    replies?: LarkCommentReplyApiItem[];
  };
};

type LarkDriveCommentApiClient = {
  drive: {
    v1: {
      fileComment: {
        get(payload: {
          params: {
            file_type: LarkCommentFileType;
            user_id_type: "open_id";
            need_reaction: boolean;
          };
          path: {
            file_token: string;
            comment_id: string;
          };
        }): Promise<{ code?: number; msg?: string; data?: LarkCommentApiItem }>;
        list(payload: {
          params: {
            file_type: LarkCommentFileType;
            user_id_type: "open_id";
            need_reaction: boolean;
            page_size: number;
          };
          path: {
            file_token: string;
          };
        }): Promise<{ code?: number; msg?: string; data?: { items?: LarkCommentApiItem[] } }>;
      };
      fileCommentReply: {
        create(payload: {
          data: {
            content: {
              elements: Array<{
                type: "text_run";
                text_run: { text: string };
              }>;
            };
          };
          params: {
            file_type: LarkCommentFileType;
            user_id_type: "open_id";
          };
          path: {
            file_token: string;
            comment_id: string;
          };
        }): Promise<{ code?: number; msg?: string }>;
      };
    };
  };
};

const silentLarkSdkLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

export function createLarkCommentClient(config: {
  appId: string;
  appSecret: string;
  domain?: LarkChannelOptions["domain"];
}): LarkCommentClientLike {
  const client = new Client({
    appId: config.appId,
    appSecret: config.appSecret,
    ...(config.domain !== undefined ? { domain: config.domain } : {}),
    logger: silentLarkSdkLogger,
  }) as unknown as LarkDriveCommentApiClient;

  return {
    async getCommentContext(input) {
      const basePayload = {
        params: {
          file_type: input.fileType,
          user_id_type: "open_id" as const,
          need_reaction: false,
        },
        path: {
          file_token: input.fileToken,
          comment_id: input.commentId,
        },
      };

      const getResult = await client.drive.v1.fileComment.get(basePayload).catch(() => null);
      if (getResult?.code === 0 && getResult.data) {
        return normalizeLarkCommentContext(getResult.data);
      }

      const listResult = await client.drive.v1.fileComment.list({
        params: {
          file_type: input.fileType,
          user_id_type: "open_id",
          need_reaction: false,
          page_size: 50,
        },
        path: {
          file_token: input.fileToken,
        },
      });
      if (listResult.code !== 0) {
        throw new Error(`Lark comment list failed: ${listResult.code ?? "unknown"} ${listResult.msg ?? ""}`.trim());
      }
      const comment = listResult.data?.items?.find((item) => item.comment_id === input.commentId);
      if (!comment) {
        throw new Error(`Lark comment not found: ${input.commentId}`);
      }
      return normalizeLarkCommentContext(comment);
    },

    async createReply(input) {
      const result = await client.drive.v1.fileCommentReply.create({
        data: {
          content: {
            elements: [{
              type: "text_run",
              text_run: {
                text: input.text,
              },
            }],
          },
        },
        params: {
          file_type: input.fileType,
          user_id_type: "open_id",
        },
        path: {
          file_token: input.fileToken,
          comment_id: input.commentId,
        },
      });
      if (result.code !== 0) {
        throw new Error(`Lark comment reply failed: ${result.code ?? "unknown"} ${result.msg ?? ""}`.trim());
      }
    },
  };
}

function normalizeLarkCommentContext(comment: LarkCommentApiItem): LarkCommentContext {
  return {
    ...(comment.quote ? { quote: comment.quote } : {}),
    replies: (comment.reply_list?.replies ?? []).map((reply) => {
      const content = flattenLarkCommentElements(reply.content?.elements ?? []);
      return {
        ...(reply.reply_id ? { replyId: reply.reply_id } : {}),
        ...(reply.user_id ? { userId: reply.user_id } : {}),
        text: content.text,
        docsLinks: content.docsLinks,
      };
    }),
  };
}

function flattenLarkCommentElements(elements: LarkCommentElement[]): { text: string; docsLinks: string[] } {
  const parts: string[] = [];
  const docsLinks: string[] = [];
  for (const element of elements) {
    if (element.type === "text_run" && element.text_run?.text) {
      parts.push(element.text_run.text);
      continue;
    }
    if (element.type === "docs_link" && element.docs_link?.url) {
      docsLinks.push(element.docs_link.url);
      parts.push(element.docs_link.url);
      continue;
    }
    if (element.type === "person" && element.person?.user_id) {
      parts.push(`@${element.person.user_id}`);
    }
  }
  return {
    text: parts.join("").trim(),
    docsLinks,
  };
}
