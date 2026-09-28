import type { LarkChannelLike } from "./types.js";

interface LarkRawImageClient {
  im?: {
    v1?: {
      image?: {
        create?: (req: { data: { image_type: string; image: Buffer } }) =>
          Promise<{ image_key?: string; data?: { image_key?: string } }>;
      };
    };
  };
}

/** Upload an image through the SDK raw client and return its Feishu image_key. */
export async function uploadLarkImageKey(
  channel: LarkChannelLike,
  body: Buffer,
): Promise<string | undefined> {
  const image = (channel as { rawClient?: LarkRawImageClient }).rawClient?.im?.v1?.image;
  if (!image || typeof image.create !== "function") {
    return undefined;
  }
  const res = await image.create({ data: { image_type: "message", image: body } });
  return res?.image_key ?? res?.data?.image_key ?? undefined;
}
