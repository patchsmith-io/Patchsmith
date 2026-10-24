import { ORPCError } from "@orpc/server";
import { maxDeploymentBytes } from "@patchsmith/asset-delivery";
import { validateLogoAsset } from "@patchsmith/asset-delivery/logo-validation";
import type { AppDeployment } from "@patchsmith/db/schema/apps";
import { appDeployment, appDeploymentFile } from "@patchsmith/db/schema/apps";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { z } from "zod";

import type { Context } from "#context";
import { attempt, PlatformDatabase, PlatformHttp } from "#services";

interface DeploymentLogo {
  checksum: string;
  contentLength: number;
  contentType: string;
}

const isObjectValue = <TValue>(value: TValue): value is TValue & object =>
  typeof value === "object" && value !== null;

const logoInspectionTimeoutMs = 10_000;
const bundleInspectionTimeoutMs = 10_000;

const isNotFound = (cause: unknown) => {
  if (!isObjectValue(cause)) {
    return false;
  }

  const parsed = z
    .object({
      $metadata: z.object({ httpStatusCode: z.number().optional() }).optional(),
      name: z.string().optional(),
    })
    .safeParse(cause);

  const value = parsed.success ? parsed.data : undefined;

  return (
    value?.name === "NoSuchKey" ||
    value?.name === "NotFound" ||
    value?.$metadata?.httpStatusCode === 404
  );
};

export const hexToBase64 = (hex: string): string => {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return Buffer.from(bytes).toString("base64");
};

export const hasMatchingLogo = async (
  storage: Context["storage"],
  logo: DeploymentLogo,
  objectKey: string
) => {
  try {
    const object = await storage.head({ key: objectKey });

    return (
      object.contentLength === logo.contentLength &&
      object.contentType === logo.contentType &&
      object.checksumSha256 === hexToBase64(logo.checksum)
    );
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }

    throw error;
  }
};

const inspectCompressedBundle = async (
  storage: Context["storage"],
  objectKey: string,
  remainingBytes: number,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal
) => {
  const download = await storage.createDownloadUrl({
    expiresInSeconds: 60,
    key: objectKey,
  });

  const downloadUrl = new URL(download.url);

  if (downloadUrl.protocol !== "https:") {
    throw new Error("Bundle download URL must use HTTPS.");
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, bundleInspectionTimeoutMs);

  try {
    const response = await fetch(downloadUrl, {
      redirect: "error",
      signal: AbortSignal.any([signal, controller.signal]),
    });

    if (!response.ok || !response.body) {
      throw new Error("Failed to inspect uploaded bundle.");
    }

    // Node fetch decodes R2's Content-Encoding before exposing the response body.
    // Count chunks instead of buffering an arbitrarily large inflated bundle.
    let contentLength = 0;

    for await (const value of response.body) {
      contentLength += value.byteLength;

      if (contentLength > remainingBytes) {
        throw new Error(
          `Combined deployment assets cannot exceed ${maxDeploymentBytes} bytes after decompression.`
        );
      }
    }

    if (contentLength === 0) {
      throw new Error("Failed to inspect uploaded bundle.");
    }

    return contentLength;
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
};

type DeploymentVerification = Pick<
  z.infer<typeof AppDeployment>,
  "id" | "logoDarkFileId" | "logoLightFileId"
>;

// Logo variants count toward the budget even when they share one stored file.
const fileCopies = (deployment: DeploymentVerification, fileId: string) =>
  fileId === deployment.logoDarkFileId && fileId === deployment.logoLightFileId
    ? 2
    : 1;

export const verifyDeploymentFilesEffect = (
  deployment: DeploymentVerification,
  storage: Context["storage"]
) =>
  Effect.gen(function* verifyDeploymentFiles() {
    const db = yield* PlatformDatabase;
    const { fetch } = yield* PlatformHttp;

    const files = yield* attempt(
      async () =>
        await db.query.appDeploymentFile.findMany({
          where: {
            appDeploymentId: deployment.id,
          },
        })
    );

    if (files.length === 0) {
      return yield* Effect.fail(
        new ORPCError("BAD_REQUEST", {
          message: "Deployment has no files to publish.",
        })
      );
    }

    const storedBytes = files.reduce(
      (total, file) =>
        total + file.contentLength * fileCopies(deployment, file.id),
      0
    );

    if (storedBytes > maxDeploymentBytes) {
      return yield* Effect.fail(
        new ORPCError("BAD_REQUEST", {
          message: `Combined deployment assets cannot exceed ${maxDeploymentBytes} bytes.`,
        })
      );
    }

    let deploymentBytes = 0;

    yield* attempt(
      async () =>
        await db
          .update(appDeployment)
          .set({ status: "verifying" })
          .where(eq(appDeployment.id, deployment.id))
    );

    yield* Effect.forEach(
      files,
      (file) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* verifyFile() {
            yield* attempt(async () => {
              await db
                .update(appDeploymentFile)
                .set({ status: "verifying" })
                .where(eq(appDeploymentFile.id, file.id));
            });
            yield* restore(
              attempt(async (signal) => {
                const object = await storage.head({
                  key: file.objectKey,
                });

                signal.throwIfAborted();
                const { contentLength } = object;

                if (contentLength !== file.contentLength) {
                  throw new Error(
                    "Uploaded file content length does not match deployment record."
                  );
                }

                if (object.contentType !== file.contentType) {
                  throw new Error(
                    "Uploaded file content type does not match deployment record."
                  );
                }

                if (
                  (object.contentEncoding ?? undefined) !==
                  (file.encoding === "gzip" ? "gzip" : undefined)
                ) {
                  throw new Error(
                    "Uploaded file content encoding does not match deployment record."
                  );
                }

                if (
                  !(
                    file.checksum !== undefined &&
                    file.checksum !== null &&
                    file.checksum !== ""
                  ) ||
                  object.checksumSha256 !== hexToBase64(file.checksum)
                ) {
                  throw new Error(
                    "Uploaded file checksum does not match deployment record."
                  );
                }

                const copies = fileCopies(deployment, file.id);

                const decodedBytes =
                  file.encoding === "gzip"
                    ? await inspectCompressedBundle(
                        storage,
                        file.objectKey,
                        Math.floor(
                          (maxDeploymentBytes - deploymentBytes) / copies
                        ),
                        fetch,
                        signal
                      )
                    : contentLength;

                deploymentBytes += decodedBytes * copies;

                if (deploymentBytes > maxDeploymentBytes) {
                  throw new Error(
                    `Combined deployment assets cannot exceed ${maxDeploymentBytes} bytes after decompression.`
                  );
                }

                if (file.contentType !== "application/javascript") {
                  const download = await storage.createDownloadUrl({
                    expiresInSeconds: 60,
                    key: file.objectKey,
                  });

                  const downloadUrl = new URL(download.url);

                  if (downloadUrl.protocol !== "https:") {
                    throw new Error("Logo download URL must use HTTPS.");
                  }

                  const controller = new AbortController();

                  const timeout = setTimeout(() => {
                    controller.abort();
                  }, logoInspectionTimeoutMs);

                  try {
                    const response = await fetch(downloadUrl, {
                      redirect: "error",
                      signal: AbortSignal.any([signal, controller.signal]),
                    });

                    if (!response.ok) {
                      throw new Error("Failed to inspect uploaded logo.");
                    }

                    validateLogoAsset(
                      new Uint8Array(await response.arrayBuffer()),
                      z
                        .enum(["image/png", "image/svg+xml", "image/webp"])
                        .parse(file.contentType)
                    );
                  } finally {
                    controller.abort();
                    clearTimeout(timeout);
                  }
                }
              }).pipe(
                Effect.tap(() =>
                  attempt(async () => {
                    await db
                      .update(appDeploymentFile)
                      .set({ status: "verified" })
                      .where(eq(appDeploymentFile.id, file.id));
                  })
                )
              )
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : attempt(async () => {
                      await db
                        .update(appDeploymentFile)
                        .set({ status: "failed" })
                        .where(eq(appDeploymentFile.id, file.id));
                      await db
                        .update(appDeployment)
                        .set({ status: "uploading" })
                        .where(eq(appDeployment.id, deployment.id));
                    }).pipe(Effect.orDie)
              ),
              Effect.mapError(
                (error) =>
                  new ORPCError("BAD_REQUEST", { message: error.message })
              )
            );
          })
        ),
      { concurrency: 1, discard: true }
    );

    return files;
  });
