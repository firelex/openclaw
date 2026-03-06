import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";

export async function downloadMedia(params: {
  client: MatrixClient;
  core: PluginRuntime;
  mxcUrl: string;
  contentType?: string;
  sizeBytes?: number;
  maxBytes: number;
}): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
} | null> {
  if (typeof params.sizeBytes === "number" && params.sizeBytes > params.maxBytes) {
    throw new Error(
      `teamsuzie: media exceeds size limit (${params.sizeBytes} > ${params.maxBytes} bytes)`,
    );
  }

  const url = params.client.mxcToHttp(params.mxcUrl);
  if (!url) {
    throw new Error(`teamsuzie: failed to resolve mxc URL: ${params.mxcUrl}`);
  }

  const result = await params.client.downloadContent(params.mxcUrl);
  const raw = result.data ?? result;
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

  if (buffer.byteLength > params.maxBytes) {
    throw new Error(
      `teamsuzie: media exceeds size limit (${buffer.byteLength} > ${params.maxBytes} bytes, url=${params.mxcUrl})`,
    );
  }

  const headerType = result.contentType ?? params.contentType ?? undefined;
  const saved = await params.core.channel.media.saveMediaBuffer(
    buffer,
    headerType,
    "inbound",
    params.maxBytes,
  );

  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: "[media]",
  };
}
