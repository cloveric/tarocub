export function buildLarkCliChannelEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    LARK_CHANNEL: "1",
    ...(baseEnv.CCTB_LARK_STATE_DIR ? { CCTB_LARK_STATE_DIR: baseEnv.CCTB_LARK_STATE_DIR } : {}),
  };
}
