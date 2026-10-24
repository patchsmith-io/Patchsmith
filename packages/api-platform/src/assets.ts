import {
  AssetDeliveryError,
  assetHeaders,
  assetResponse,
  assetSize,
  limitAssetBody,
  nodeAssetRequest,
  serveAssetRequest,
} from "@patchsmith/asset-delivery";
import type { AssetIdentity } from "@patchsmith/asset-delivery";
import type { Storage } from "@patchsmith/storage";
import { Effect } from "effect";
import { z } from "zod";

import { PlatformHttp, runPlatform } from "#services";
import type { PlatformEffectContext } from "#services";

const isObjectValue = <TValue>(value: TValue): value is TValue & object =>
  typeof value === "object" && value !== null;

const storageFailure = (cause: unknown) => {
  if (isObjectValue(cause)) {
    const parsed = z
      .object({
        $metadata: z
          .object({ httpStatusCode: z.number().optional() })
          .optional(),
        name: z.string().optional(),
      })
      .safeParse(cause);

    const value = parsed.success ? parsed.data : undefined;

    if (
      value?.name === "NoSuchKey" ||
      value?.name === "NotFound" ||
      value?.$metadata?.httpStatusCode === 404
    ) {
      return new AssetDeliveryError(404);
    }
  }

  return new AssetDeliveryError(503);
};

const loadAsset = (
  request: Request,
  identity: AssetIdentity,
  storage: Storage,
  fetch: typeof globalThis.fetch
) =>
  Effect.gen(function* loadAssetValue() {
    const { key } = identity;

    const object = yield* Effect.tryPromise({
      catch: storageFailure,
      try: async () => await storage.head({ key }),
    });

    const contentLength = yield* assetSize(object.contentLength);

    const headers = assetHeaders({
      contentLength,
      contentType: identity.contentType,
      etag: object.etag,
    });

    // Node fetch decodes Content-Encoding automatically. The local adapter serves
    // that decoded stream; the stored length and strong ETag describe gzip bytes.
    if (object.contentEncoding === "gzip") {
      headers.delete("Content-Length");

      if (
        object.etag !== undefined &&
        object.etag !== null &&
        object.etag !== ""
      ) {
        headers.set("ETag", `W/${object.etag}`);
      }
    }

    if (request.method === "HEAD") {
      return new Response(null, { headers });
    }

    const download = yield* Effect.tryPromise({
      catch: storageFailure,
      try: async () =>
        await storage.createDownloadUrl({ expiresInSeconds: 60, key }),
    });

    const upstream = yield* Effect.tryPromise({
      catch: storageFailure,
      try: async (signal) =>
        await fetch(download.url, { redirect: "error", signal }),
    });

    if (!upstream.ok) {
      return yield* Effect.fail(
        new AssetDeliveryError(upstream.status === 404 ? 404 : 503)
      );
    }

    const body =
      object.contentEncoding === "gzip" && upstream.body
        ? limitAssetBody(upstream.body)
        : upstream.body;

    return new Response(body, { headers });
  });

export const handleAssetRequest = async (
  request: Request,
  storage: Storage | null,
  context?: Partial<PlatformEffectContext>
): Promise<Response> => {
  const program = Effect.gen(function* program() {
    const { fetch } = yield* PlatformHttp;

    return yield* assetResponse(
      Effect.gen(function* deliverAsset() {
        const identity = yield* nodeAssetRequest(request);

        if (!storage) {
          return yield* Effect.fail(new AssetDeliveryError(503));
        }

        return yield* serveAssetRequest(request, {
          identity: Effect.succeed(identity),
          load: (asset) => loadAsset(request, asset, storage, fetch),
        });
      })
    );
  });

  return await runPlatform(program, context, request.signal);
};
