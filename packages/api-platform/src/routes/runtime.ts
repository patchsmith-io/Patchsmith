import { handlerGen, middlewareGen } from "@orpc/experimental-effect";
import { openapi } from "@orpc/openapi";
import { ORPCError } from "@orpc/server";
import type { AppDeploymentMetadata } from "@patchsmith/api-utils/app-auth";
import {
  APP_PUBLIC_KEYS_CACHE_SECONDS,
  appDeploymentMetadata,
} from "@patchsmith/api-utils/app-auth";
import type { App, AppDeployment } from "@patchsmith/db/schema/apps";
import { Effect } from "effect";
import { z } from "zod";

import { appSelectorSchema } from "#app-selector";
import type { Context } from "#context";
import { env as platformEnv } from "#env";
import { o, protectedRouter, requireAppInScopes } from "#procedures";
import { appRuntimePublicKeys } from "#runtime/auth";
import { scopeSchema, scopesSchema } from "#scope";
import {
  attempt,
  PlatformDatabase,
  PlatformConfig,
  PlatformRuntime,
  runPlatform,
} from "#services";

export const appRuntimeKeysResponse = (
  config = platformEnv
): ReturnType<typeof Response.json> => {
  try {
    return Response.json(appRuntimePublicKeys(config), {
      headers: {
        "cache-control": `public, max-age=${APP_PUBLIC_KEYS_CACHE_SECONDS}`,
      },
    });
  } catch {
    return new Response("Signing keys unavailable", {
      headers: { "cache-control": "no-store" },
      status: 503,
    });
  }
};

/** Public routes must be dispatched before constructing the authenticated platform context. */
export const handlePublicRuntimeRequest = (
  request: Request,
  config = platformEnv
): Response | undefined => {
  if (
    request.method !== "GET" ||
    new URL(request.url).pathname !== "/api/platform/runtime/keys"
  ) {
    return undefined;
  }

  return appRuntimeKeysResponse(config);
};

export const runtimeViewerSchema = z.object({
  subjectId: z.string().min(1).max(256),
  toolUrl: z.url().refine((value) => {
    const url = new URL(value);

    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  }, "Tool URL requires HTTPS"),
});

export const runtimeSessionSchema = z.object({
  expiresAt: z.number(),
  identity: z.object({
    appId: z.string(),
    appShortId: z.string(),
    deploymentId: z.string(),
    expiresAt: z.number(),
    hook: z.string().optional(),
    installationId: z.string(),
    projectId: z.string(),
    projectShortId: z.string(),
    scope: scopeSchema,
    subjectId: z.string().min(1).max(256),
    toolUrl: z.url(),
  }),
  token: z.string(),
  url: z.url(),
});

interface RuntimeHookGrant {
  hook?: string;
}

type RuntimeApp = Pick<z.infer<typeof App>, "id" | "shortId" | "scope"> & {
  currentDeployment: Pick<z.infer<typeof AppDeployment>, "id" | "hooks"> | null;
};

/** Reuse the already authorized discovery row instead of looking up each app again. */
export const createRuntimeSessionEffect = (
  context: Pick<Context, "project">,
  app: RuntimeApp,
  input: z.infer<typeof runtimeViewerSchema> & RuntimeHookGrant
) =>
  Effect.gen(function* createRuntimeSession() {
    const env = yield* PlatformConfig;

    const deployment = app.currentDeployment;

    if (!deployment) {
      return yield* Effect.fail(
        new ORPCError("NOT_FOUND", {
          message: "App has no published deployment.",
        })
      );
    }

    if (input.hook !== undefined && !deployment.hooks.includes(input.hook)) {
      return yield* Effect.fail(
        new ORPCError("NOT_FOUND", {
          message: "App deployment does not implement this hook.",
        })
      );
    }

    const runtime = new URL(
      env.APP_RUNTIME_URL ??
        `https://${context.project.shortId}.${env.ASSET_DOMAIN ?? "tailorkit.app"}`
    );

    const localRuntime =
      runtime.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(runtime.hostname);

    if (
      runtime.username ||
      runtime.password ||
      runtime.search ||
      runtime.hash ||
      (runtime.protocol !== "https:" && !localRuntime)
    ) {
      return yield* Effect.fail(
        new ORPCError("SERVICE_UNAVAILABLE", {
          message: "Invalid app runtime configuration.",
        })
      );
    }

    const projectPath = localRuntime ? `/p/${context.project.shortId}` : "";
    const url = new URL(`${projectPath}/a/${app.shortId}/rpc`, runtime);

    // Each app belongs to one installation scope. Resolve identity from the authorized
    // database record, never from browser input or the ordering of the viewer's scopes.
    const hookGrant: RuntimeHookGrant = {};

    if (input.hook !== undefined) {
      hookGrant.hook = input.hook;
    }

    const identity = {
      ...hookGrant,
      appId: app.id,
      appShortId: app.shortId,
      deploymentId: deployment.id,
      installationId: app.id,
      projectId: context.project.id,
      projectShortId: context.project.shortId,
      scope: app.scope,
      subjectId: input.subjectId,
      toolUrl: input.toolUrl,
    };

    const runtimeService = yield* PlatformRuntime;
    const session = yield* runtimeService.issueToken(identity);

    return {
      ...session,
      identity: { ...identity, expiresAt: session.expiresAt },
      url: url.href,
    };
  });

// Hosts authenticate with their project key and assert membership using verified scopes.
export const runtimeSession = protectedRouter
  .meta(openapi({ method: "POST", path: "/apps/runtime/session" }))
  .input(
    z.object({
      body: runtimeViewerSchema
        .extend({
          app: appSelectorSchema,
          hook: z
            .string()
            .min(1)
            .max(255)
            .regex(
              /^[a-zA-Z][a-zA-Z0-9_]{0,63}(?:\.[a-zA-Z][a-zA-Z0-9_]{0,63})*$/u
            )
            .optional(),
          scopes: scopesSchema,
        })
        .strict(),
    })
  )
  .output(z.object({ body: runtimeSessionSchema }))
  .use(requireAppInScopes.adaptInput(({ body }) => body))
  .handler(
    handlerGen(function* runtimeSession({ context, input }) {
      return {
        body: yield* createRuntimeSessionEffect(
          context,
          context.app,
          input.body
        ),
      };
    })
  );

// Trusted runtime metadata: return the authorized private R2 key without minting a download URL.
export const getRuntimeBundle = protectedRouter
  .meta(openapi({ method: "POST", path: "/apps/{appId}/runtime" }))
  .input(
    z.object({ body: z.object({}), params: z.object({ appId: z.string() }) })
  )
  .output(z.object({ body: appDeploymentMetadata }))
  .use(
    o
      .middleware(
        middlewareGen(function* getRuntimeBundle(
          { context, next },
          input: { appId: string }
        ) {
          const db = yield* PlatformDatabase;

          if (!(context.runtimeService === true)) {
            return yield* Effect.fail(new ORPCError("FORBIDDEN"));
          }

          const app = yield* attempt(
            async () =>
              await db.query.app.findFirst({
                where: { id: input.appId, projectId: context.project.id },
                with: {
                  currentDeployment: {
                    where: { status: "published" },
                    with: { app: { columns: { shortId: true } } },
                  },
                },
              })
          );

          if (!app) {
            return yield* Effect.fail(new ORPCError("NOT_FOUND"));
          }

          // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- oRPC preserves downstream procedure failures.
          return yield* next({ context: { ...context, app } });
        })
      )
      .adaptInput(({ params }) => ({ appId: params.appId }))
  )
  .handler(
    handlerGen(function* getRuntimeBundle({ context }) {
      const db = yield* PlatformDatabase;

      const deployment = context.app.currentDeployment;

      if (!deployment) {
        return yield* Effect.fail(new ORPCError("NOT_FOUND"));
      }

      const assetAppId = deployment.app?.shortId ?? context.app.shortId;
      const key = `projects/${context.project.shortId}/apps/${assetAppId}/deployments/${deployment.shortId}/server/server.js`;

      const file = yield* attempt(
        async () =>
          await db.query.appDeploymentFile.findFirst({
            where: {
              appDeploymentId: deployment.id,
              objectKey: key,
              status: "verified",
            },
          })
      );

      if (
        !(
          file?.checksum !== undefined &&
          file?.checksum !== null &&
          file?.checksum !== ""
        )
      ) {
        return yield* Effect.fail(new ORPCError("NOT_FOUND"));
      }

      return {
        body: {
          appId: context.app.id,
          checksum: file.checksum,
          contentEncoding: file.encoding === "gzip" ? "gzip" : undefined,
          contentLength: file.contentLength,
          deploymentId: deployment.id,
          objectKey: file.objectKey,
          projectId: context.project.id,
        },
      };
    })
  );

/** Enqueue independently retryable warm-up steps after deployment selection. */
export const publishRuntimeMetadataEffect = (metadata: AppDeploymentMetadata) =>
  Effect.gen(function* publishRuntimeMetadata() {
    const runtime = yield* PlatformRuntime;
    yield* runtime
      .enqueueWarmup(metadata)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not enqueue app deployment warm-up", error)
        )
      );
  });

export const publishRuntimeMetadata = async (
  metadata: AppDeploymentMetadata,
  _appShortId: string,
  context?: Context
) => {
  await runPlatform(publishRuntimeMetadataEffect(metadata), context);
};

export const createRuntimeSession = async (
  context: Pick<Context, "project" | "effect/context">,
  app: RuntimeApp,
  input: z.infer<typeof runtimeViewerSchema> & RuntimeHookGrant
) =>
  await runPlatform(createRuntimeSessionEffect(context, app, input), context);
