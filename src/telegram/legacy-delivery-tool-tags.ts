import { executeTelegramTool } from "../tools/telegram-tool-executor.js";
import type { TelegramToolContext } from "../tools/telegram-tool-types.js";
import { extractDeliveryTagMatches, stripDeliveryTags } from "./delivery-tags.js";
import {
  isLikelyCopiedPlaceholderFilePath,
  isStaticPlaceholderFilePath,
} from "./file-paths.js";

interface ProcessLegacyDeliveryTagsInput {
  text: string;
  context: TelegramToolContext;
  includeMessageInDelivery?: boolean;
  allowedTags?: readonly string[];
  ignoredPaths?: readonly string[];
}

function actionableDeliveryTags(
  text: string,
  options?: Pick<ProcessLegacyDeliveryTagsInput, "allowedTags" | "ignoredPaths">,
) {
  const allowedTags = options?.allowedTags ? new Set(options.allowedTags) : undefined;
  const ignoredPaths = options?.ignoredPaths ? new Set(options.ignoredPaths) : undefined;
  return extractDeliveryTagMatches(text).filter((match) => (
    (!allowedTags || allowedTags.has(match.tag)) &&
    !ignoredPaths?.has(match.path) &&
    !isStaticPlaceholderFilePath(match.path) &&
    !isLikelyCopiedPlaceholderFilePath(match.path)
  ));
}

export async function processLegacyDeliveryTagsAsTools(input: ProcessLegacyDeliveryTagsInput): Promise<string> {
  const matches = actionableDeliveryTags(input.text, input);
  const allowedTags = input.allowedTags ? new Set(input.allowedTags) : undefined;
  const ignoredPaths = input.ignoredPaths ? new Set(input.ignoredPaths) : undefined;
  const ignoredMatches = extractDeliveryTagMatches(input.text).filter((match) => (
    (!allowedTags || allowedTags.has(match.tag)) &&
    ignoredPaths?.has(match.path)
  ));
  if (matches.length === 0) {
    if (ignoredMatches.length === 0) {
      return input.text;
    }
    const ignoredTags = new Set(ignoredMatches.map((match) => match.tag));
    return stripDeliveryTags(input.text, (match) => ignoredTags.has(match.tag)).trim();
  }

  const matchedTags = new Set([
    ...matches.map((match) => match.tag),
    ...ignoredMatches.map((match) => match.tag),
  ]);
  const cleanedText = stripDeliveryTags(input.text, (match) => matchedTags.has(match.tag));
  const images = matches.filter((match) => match.preferPhoto).map((match) => match.path);
  const files = matches.filter((match) => !match.preferPhoto).map((match) => match.path);
  const result = await executeTelegramTool({
    name: "send.batch",
    payload: {
      ...(input.includeMessageInDelivery && cleanedText.trim() ? { message: cleanedText.trim() } : {}),
      images,
      files,
    },
    context: input.context,
  });

  if (input.includeMessageInDelivery) {
    return result.message;
  }
  return [
    cleanedText,
    result.message,
  ].filter((part) => part.trim()).join("\n\n");
}
