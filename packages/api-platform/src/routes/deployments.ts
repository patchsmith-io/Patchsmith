import { handlerGen, middlewareGen } from "@orpc/experimental-effect";
import { openapi } from "@orpc/openapi";
import { ORPCError } from "@orpc/server";
import { maxDeploymentBytes } from "@patchsmith/asset-delivery";
import {
  logoContentTypes,
  maxLogoBytes,
  validateLogoAsset,
} from "@patchsmith/asset-delivery/logo-validation";
import {
  app,
  AppDeployment,
  appDeployment,
  AppDeploymentFile,
  appDeploymentFile,
} from "@patchsmith/db/schema/apps";
import type { Scope } from "@patchsmith/db/schema/scope";
import { setSpanAttributes } from "@patchsmith/observability";
import { and, eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { z } from "zod";

import { appSelectorSchema } from "#app-selector";
import type { Context } from "#context";
import { paginatedOutput, paginationQuery } from "#pagination";
import { o, cliRouter, requireApp, requireAppInScopes } from "#procedures";
import {
  canonicalizeScope,
  canonicalizeScopes,
  scopeMatches,
  scopeSchema,
  scopesSchema,
} from "#scope";
import {
  attempt,
  PlatformDatabase,
  PlatformHttp,
  PlatformIds,
} from "#services";

import { getRuntimeBundle, publishRuntimeMetadataEffect } from "./runtime";

const isObjectValue = <TValue>(value: TValue): value is TValue & object =>
  typeof value === "object" && value !== null;

const uploadUrlExpiresInSeconds = 15 * 60;

const logoInspectionTimeoutMs = 10_000;

const bundleInspectionTimeoutMs = 10_000;

const logoExtensionByContentType = {
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
} as const;

const logoContentType = z.enum(logoContentTypes);

const deploymentFileMetadataFields = {
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/iu)
    .transform((checksum) => checksum.toLowerCase()),
};

const createDeploymentAssetInput = z.object({
  ...deploymentFileMetadataFields,
  contentLength: z.number().int().min(1),
  contentType: z.literal("application/javascript"),
  encoding: z.enum(["utf-8", "gzip"]),
  objectKey: z.literal("client.js"),
});

const createDeploymentServerInput = createDeploymentAssetInput.extend({
  contentLength: z.number().int().min(1).max(maxDeploymentBytes),
  objectKey: z.literal("server.js"),
});

const createDeploymentLogoInput = z.object({
  ...deploymentFileMetadataFields,
  contentLength: z.number().int().min(1).max(maxLogoBytes),
  contentType: logoContentType,
});

const createDeploymentInput = z
  .object({
    app: appSelectorSchema,
    assets: z.tuple([createDeploymentAssetInput]),
    hooks: AppDeployment.shape.hooks.optional(),
    logos: z
      .object({
        dark: createDeploymentLogoInput.optional(),
        light: createDeploymentLogoInput.optional(),
      })
      .optional(),
    scope: scopeSchema,
    server: createDeploymentServerInput.optional(),
    views: AppDeployment.shape.views.optional(),
  })
  .refine(
    ({ hooks, server }) => (hooks?.length ?? 0) === 0 || server !== undefined,
    {
      message: "Hooks require a server bundle.",
    }
  )
  .refine(
    ({ assets, server, logos }) =>
      assets.reduce((total, asset) => total + asset.contentLength, 0) +
        (server?.contentLength ?? 0) +
        (logos?.dark?.contentLength ?? 0) +
        (logos?.light?.contentLength ?? 0) <=
      maxDeploymentBytes,
    {
      message: `Combined deployment assets cannot exceed ${maxDeploymentBytes} bytes.`,
    }
  );

const deploymentAssetUpload = z.object({
  file: AppDeploymentFile,
  headers: z.record(z.string(), z.string()).optional(),
  uploadUrl: z.url(),
});

const deploymentLogoUpload = deploymentAssetUpload.extend({
  file: AppDeploymentFile.extend({ contentType: logoContentType }),
  uploadUrl: z.url().optional(),
});

const deploymentLogoUploads = z.object({
  dark: deploymentLogoUpload.optional(),
  light: deploymentLogoUpload.optional(),
});

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

const hexToBase64 = (hex: string): string => {
  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return Buffer.from(bytes).toString("base64");
};

const hasMatchingLogo = async (
  storage: Context["storage"],
  logo: z.output<typeof createDeploymentLogoInput>,
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

export const mapReturnedFilesByAssetPath = <TFile extends { id: string }>(
  assets: readonly { asset: { objectKey: string }; fileId: string }[],
  files: readonly TFile[]
) => {
  const fileById = new Map(files.map((file) => [file.id, file]));

  return new Map(
    assets.map(({ asset, fileId }) => {
      const file = fileById.get(fileId);

      if (!file) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Failed to resolve deployment asset.",
        });
      }

      return [asset.objectKey, file] as const;
    })
  );
};

const requireDeployment = o.middleware(
  middlewareGen(function* requireDeployment(
    { next, context },
    input: { deploymentId: string; scope?: Scope; scopes?: Scope[] }
  ) {
    const db = yield* PlatformDatabase;

    setSpanAttributes({
      "patchsmith.middleware": "require_deployment",
      "patchsmith.package": "api-platform",
      "patchsmith.resource_type": "deployment",
    });

    const deploymentWithApp = yield* attempt(
      async () =>
        await db.query.appDeployment.findFirst({
          where: {
            id: input.deploymentId,
          },
          with: {
            app: true,
          },
        })
    );

    const deploymentApp = deploymentWithApp?.app;

    const requestedScopes = yield* Effect.try({
      catch: () =>
        new ORPCError("BAD_REQUEST", { message: "Invalid deployment scope." }),
      try: () =>
        input.scope
          ? [canonicalizeScope(input.scope).scope]
          : canonicalizeScopes(input.scopes).map(({ scope }) => scope),
    });

    const storedScope = yield* Effect.sync(() => {
      if (!deploymentApp) {
        return null;
      }

      try {
        const canonicalScope = canonicalizeScope(deploymentApp.scope);

        if (canonicalScope.scopeKey !== deploymentApp.scopeKey) {
          throw new TypeError(
            "Deployment app scope key does not match its stored scope."
          );
        }

        return canonicalScope;
      } catch (error) {
        console.warn("Deployment app has an invalid stored scope.", {
          appId: deploymentApp.id,
          deploymentId: input.deploymentId,
          error,
        });

        return null;
      }
    });

    const scopeMatchesApp =
      storedScope !== null &&
      requestedScopes.some((scope) => scopeMatches(storedScope.scope, scope));

    if (
      !deploymentWithApp ||
      !deploymentApp ||
      deploymentApp.projectId !== context.project.id ||
      !scopeMatchesApp
    ) {
      return yield* Effect.fail(
        new ORPCError("NOT_FOUND", { message: "Deployment not found." })
      );
    }

    const { app: _app, ...deployment } = deploymentWithApp;
    void _app;

    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- oRPC preserves downstream procedure failures.
    return yield* next({
      context: { ...context, app: deploymentApp, deployment },
    });
  })
);

const listAppDeployments = cliRouter
  .meta(
    openapi({
      method: "POST",
      path: "/deployments/list",
    })
  )
  .input(
    z.object({
      body: paginationQuery.extend({
        app: appSelectorSchema,
        scopes: scopesSchema,
      }),
    })
  )
  .output(paginatedOutput(AppDeployment))
  .use(requireAppInScopes.adaptInput(({ body }) => body))
  .handler(
    handlerGen(function* listAppDeployments({ context, input }) {
      const db = yield* PlatformDatabase;

      const { page, pageSize } = input.body;

      const deployments = yield* attempt(
        async () =>
          await db.query.appDeployment.findMany({
            limit: pageSize + 1,
            offset: (page - 1) * pageSize,
            orderBy: {
              createdAt: "desc",
            },
            where: {
              appId: context.app.id,
            },
          })
      );

      return {
        body: {
          items: deployments.slice(0, pageSize),
          pagination: {
            hasMore: deployments.length > pageSize,
            page,
            pageSize,
          },
        },
      };
    })
  );

const getAppDeployment = cliRouter
  .meta(
    openapi({
      method: "POST",
      path: "/deployments/{deploymentId}/lookup",
    })
  )
  .input(
    z.object({
      body: z.object({ scopes: scopesSchema }),
      params: z.object({ deploymentId: z.string() }),
    })
  )
  .output(z.object({ body: AppDeployment }))
  .use(
    requireDeployment.adaptInput(
      ({ params: { deploymentId }, body: { scopes } }) => ({
        deploymentId,
        scopes,
      })
    )
  )
  .handler(({ context }) => ({ body: context.deployment }));

const createAppDeployment = cliRouter
  .meta(
    openapi({
      method: "POST",
      path: "/deployments",
    })
  )
  .input(
    z.object({
      body: createDeploymentInput,
    })
  )
  .output(
    z.object({
      body: z.object({
        assets: z.array(deploymentAssetUpload),
        deployment: AppDeployment,
        logos: deploymentLogoUploads.optional(),
        server: deploymentAssetUpload.optional(),
      }),
    })
  )
  .use(requireApp.adaptInput(({ body }) => body))
  .handler(
    handlerGen(function* createAppDeployment({ context, input }) {
      const db = yield* PlatformDatabase;

      const deploymentId = crypto.randomUUID();
      const ids = yield* PlatformIds;
      const deploymentShortId = yield* ids.shortId;

      const requestedLogos = Object.entries(input.body.logos ?? {}).map(
        ([variant, logo]) => ({
          asset: {
            ...logo,
            encoding: null,
            objectKey: `logos/${logo.checksum}.${logoExtensionByContentType[logo.contentType]}`,
          },
          variant,
        })
      );

      const uniqueLogoAssets = [
        ...new Map(
          requestedLogos.map(({ asset }) => [asset.objectKey, asset])
        ).values(),
      ];

      const requestedAssets = [
        ...input.body.assets.map((asset) => ({
          asset,
          kind: "client" as const,
        })),
        ...(input.body.server
          ? [{ asset: input.body.server, kind: "server" as const }]
          : []),
        ...uniqueLogoAssets.map((asset) => ({ asset, kind: "logo" as const })),
      ];

      const assets = yield* Effect.forEach(
        requestedAssets,
        ({ asset, kind }) =>
          attempt(async () => {
            const fileId = crypto.randomUUID();
            const appBaseKey = `projects/${context.project.shortId}/apps/${context.app.shortId}`;

            const objectKey =
              kind === "logo"
                ? `${appBaseKey}/${asset.objectKey}`
                : `${appBaseKey}/deployments/${deploymentShortId}/${kind}/${asset.objectKey}`;

            const shouldReuse =
              kind === "logo" &&
              (await hasMatchingLogo(context.storage, asset, objectKey));

            const uploadUrl = shouldReuse
              ? undefined
              : await context.storage.createUploadUrl({
                  checksumSha256: hexToBase64(asset.checksum),
                  contentEncoding:
                    asset.encoding === "gzip" ? "gzip" : undefined,
                  contentType: asset.contentType,
                  expiresInSeconds: uploadUrlExpiresInSeconds,
                  key: objectKey,
                  metadata:
                    kind === "logo"
                      ? { appId: context.app.id, checksum: asset.checksum }
                      : {
                          appDeploymentId: deploymentId,
                          appId: context.app.id,
                          fileId,
                        },
                });

            return { asset, fileId, objectKey, uploadUrl };
          }),
        { concurrency: "unbounded" }
      );

      const created = yield* attempt(
        async () =>
          await db.transaction(async (tx) => {
            const [deployment] = await tx
              .insert(appDeployment)
              .values({
                appId: context.app.id,
                hooks: input.body.hooks ?? [],
                id: deploymentId,
                shortId: deploymentShortId,
                status: "uploading",
                views: input.body.views ?? [],
              })
              .returning();

            if (!deployment) {
              throw new ORPCError("BAD_REQUEST", {
                message: "Failed to create deployment.",
              });
            }

            const files = await tx
              .insert(appDeploymentFile)
              .values(
                assets.map(({ asset, fileId, objectKey }) => ({
                  appDeploymentId: deployment.id,
                  checksum: asset.checksum,
                  contentLength: asset.contentLength,
                  contentType: asset.contentType,
                  encoding: asset.encoding,
                  id: fileId,
                  objectKey,
                }))
              )
              .returning();

            if (files.length !== assets.length) {
              throw new ORPCError("BAD_REQUEST", {
                message: "Failed to create deployment asset.",
              });
            }

            const fileByAssetPath = mapReturnedFilesByAssetPath(assets, files);

            const logoDarkPath = requestedLogos.find(
              ({ variant }) => variant === "dark"
            )?.asset.objectKey;

            const logoLightPath = requestedLogos.find(
              ({ variant }) => variant === "light"
            )?.asset.objectKey;

            const [updatedDeployment] = await tx
              .update(appDeployment)
              .set({
                clientEntryFileId: fileByAssetPath.get("client.js")?.id,
                logoDarkFileId:
                  logoDarkPath !== undefined &&
                  logoDarkPath !== null &&
                  logoDarkPath !== ""
                    ? fileByAssetPath.get(logoDarkPath)?.id
                    : undefined,
                logoDarkPath,
                logoLightFileId:
                  logoLightPath !== undefined &&
                  logoLightPath !== null &&
                  logoLightPath !== ""
                    ? fileByAssetPath.get(logoLightPath)?.id
                    : undefined,
                logoLightPath,
              })
              .where(eq(appDeployment.id, deployment.id))
              .returning();

            if (!updatedDeployment) {
              throw new ORPCError("BAD_REQUEST", {
                message: "Failed to update deployment asset.",
              });
            }

            return {
              createdDeployment: updatedDeployment,
              createdFiles: files,
            };
          })
      );

      const { createdDeployment, createdFiles } = created;

      const createdFileById = new Map(
        createdFiles.map((file) => [file.id, file])
      );

      const uploadedAssetByName = new Map(
        assets.map(({ asset, fileId, uploadUrl }) => {
          const file = createdFileById.get(fileId);

          if (!file) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Failed to resolve deployment asset.",
            });
          }

          return [
            asset.objectKey,
            {
              file,
              headers: uploadUrl?.headers,
              uploadUrl: uploadUrl?.uploadUrl,
            },
          ] as const;
        })
      );

      const uploadedAssets = input.body.assets.map((asset) => {
        const upload = uploadedAssetByName.get(asset.objectKey);

        if (
          !(
            upload?.uploadUrl !== undefined &&
            upload?.uploadUrl !== null &&
            upload?.uploadUrl !== ""
          )
        ) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Failed to resolve deployment asset.",
          });
        }

        return { ...upload, uploadUrl: upload.uploadUrl };
      });

      const serverUpload = input.body.server
        ? uploadedAssetByName.get("server.js")
        : undefined;

      if (
        input.body.server &&
        !(
          serverUpload?.uploadUrl !== undefined &&
          serverUpload?.uploadUrl !== null &&
          serverUpload?.uploadUrl !== ""
        )
      ) {
        return yield* Effect.fail(
          new ORPCError("BAD_REQUEST", {
            message: "Failed to create server upload URL.",
          })
        );
      }

      const uploadedLogos = Object.fromEntries(
        requestedLogos.map(({ asset, variant }) => {
          const upload = uploadedAssetByName.get(asset.objectKey);

          if (!upload) {
            throw new ORPCError("BAD_REQUEST", {
              message: "Failed to resolve deployment asset.",
            });
          }

          return [variant, upload];
        })
      );

      interface DeploymentUploads {
        server?: typeof serverUpload & { uploadUrl: string };
        logos?: typeof uploadedLogos;
      }

      const optionalUploads: DeploymentUploads = {};

      if (
        serverUpload?.uploadUrl !== undefined &&
        serverUpload?.uploadUrl !== null &&
        serverUpload?.uploadUrl !== ""
      ) {
        optionalUploads.server = {
          ...serverUpload,
          uploadUrl: serverUpload.uploadUrl,
        };
      }

      if (Object.keys(uploadedLogos).length > 0) {
        optionalUploads.logos = uploadedLogos;
      }

      return {
        body: {
          ...optionalUploads,
          assets: uploadedAssets,
          deployment: createdDeployment,
        },
      };
    })
  );

const publishAppDeployment = cliRouter
  .meta(
    openapi({
      method: "POST",
      path: "/deployments/{deploymentId}",
    })
  )
  .input(
    z.object({
      body: z.object({
        rollout: z.boolean().optional().default(true),
        scope: scopeSchema,
      }),
      params: z.object({ deploymentId: z.string() }),
    })
  )
  .output(z.object({ body: AppDeployment }))
  .use(
    requireDeployment.adaptInput(
      ({ body: { scope }, params: { deploymentId } }) => ({
        deploymentId,
        scope,
      })
    )
  )
  .handler(
    handlerGen(function* publishAppDeployment({ context, input }) {
      const db = yield* PlatformDatabase;
      const { fetch } = yield* PlatformHttp;

      const { deployment } = context;

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

      // Logo variants count toward the budget even when they share one stored file.
      const fileCopies = (fileId: string) =>
        fileId === deployment.logoDarkFileId &&
        fileId === deployment.logoLightFileId
          ? 2
          : 1;

      const storedBytes = files.reduce(
        (total, file) => total + file.contentLength * fileCopies(file.id),
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
                  const object = await context.storage.head({
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

                  const copies = fileCopies(file.id);

                  const decodedBytes =
                    file.encoding === "gzip"
                      ? await inspectCompressedBundle(
                          context.storage,
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
                    const download = await context.storage.createDownloadUrl({
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

      const [publishedDeployment] = yield* attempt(
        async () =>
          await db
            .update(appDeployment)
            .set({ status: "published" })
            .where(eq(appDeployment.id, deployment.id))
            .returning()
      );

      if (!publishedDeployment) {
        return yield* Effect.fail(
          new ORPCError("BAD_REQUEST", {
            message: "Failed to publish deployment.",
          })
        );
      }

      if (input.body.rollout) {
        yield* attempt(
          async () =>
            await db
              .update(app)
              .set({ currentDeploymentId: publishedDeployment.id })
              .where(
                and(
                  eq(app.id, context.app.id),
                  eq(app.projectId, context.project.id)
                )
              )
        );

        const { selectRuntimeDeployment } = yield* attempt(
          async () => await import("#runtime/deployment-steps")
        );

        const selected = yield* attempt(
          async () =>
            await selectRuntimeDeployment(
              {
                appId: context.app.id,
                deploymentId: publishedDeployment.id,
                projectId: context.project.id,
              },
              db
            )
        );

        const server = files.find((file) =>
          file.objectKey.endsWith("/server/server.js")
        );

        if (
          selected &&
          server?.checksum !== undefined &&
          server?.checksum !== null &&
          server?.checksum !== ""
        ) {
          yield* publishRuntimeMetadataEffect({
            appId: context.app.id,
            checksum: server.checksum,
            contentEncoding: server.encoding === "gzip" ? "gzip" : undefined,
            contentLength: server.contentLength,
            deploymentId: publishedDeployment.id,
            objectKey: server.objectKey,
            projectId: context.project.id,
          });
        }
      }

      return { body: publishedDeployment };
    })
  );

export const deploymentRouter = o.router({
  create: createAppDeployment,
  get: getAppDeployment,
  list: listAppDeployments,
  publish: publishAppDeployment,
  runtime: getRuntimeBundle,
});
