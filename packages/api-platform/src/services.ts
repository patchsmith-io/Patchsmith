/* oxlint-disable max-classes-per-file -- These related Effect service keys share the platform composition root. */
import { runPromise } from "@orpc/experimental-effect";
import type { WithEffectContext } from "@orpc/experimental-effect";
import type { appAgent } from "@patchsmith/agent-fx/workflows";
import type {
  AppTokenIdentity,
  AppDeploymentMetadata,
} from "@patchsmith/api-utils/app-auth";
import { createRateLimiter } from "@patchsmith/api-utils/rate-limiting";
import { db } from "@patchsmith/db";
import type { relations } from "@patchsmith/db/relations";
import { createShortId } from "@patchsmith/db/short-id";
import type { Storage } from "@patchsmith/storage";
import type { UIMessageChunk } from "ai";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core/async";
import { Context, Effect, Layer } from "effect";

import { env } from "#env";
import { platformError } from "#errors";
import type { PlatformFailure } from "#errors";

export { platformError } from "#errors";

export const attempt = <A>(
  operation: (signal: AbortSignal) => PromiseLike<A>
) => Effect.tryPromise({ catch: platformError, try: operation });

export type PlatformDb = PgAsyncDatabase<PgQueryResultHKT, typeof relations>;

export class PlatformDatabase extends Context.Service<
  PlatformDatabase,
  PlatformDb
>()("api-platform/Database") {}

export class PlatformIds extends Context.Service<
  PlatformIds,
  { readonly shortId: Effect.Effect<string> }
>()("api-platform/Ids") {}

export class PlatformConfig extends Context.Service<
  PlatformConfig,
  typeof env
>()("api-platform/Config") {}

export class PlatformHttp extends Context.Service<
  PlatformHttp,
  { readonly fetch: typeof fetch }
>()("api-platform/Http") {}

export class PlatformStorage extends Context.Service<
  PlatformStorage,
  { readonly get: Effect.Effect<Storage | null, PlatformFailure> }
>()("api-platform/Storage") {}

export class PlatformCredentials extends Context.Service<
  PlatformCredentials,
  {
    readonly verifyProjectKey: (
      key: string
    ) => Effect.Effect<{ valid: boolean; projectId?: string }, PlatformFailure>;
  }
>()("api-platform/Credentials") {}

export interface AgentRun {
  readonly runId: string;
  readonly returnValue: Promise<{ finishReason: string }>;
  readonly cancel: (options: { cancelReason: string }) => Promise<void>;
  readonly getReadable: (options?: {
    startIndex?: number;
  }) => ReadableStream<UIMessageChunk>;
}

export type AgentInput = Parameters<typeof appAgent>[0];

export interface AgentStartOptions {
  attributes?: Record<string, string>;
}

export class PlatformAgent extends Context.Service<
  PlatformAgent,
  {
    readonly resolveThread: (
      appId: string,
      threadId?: string
    ) => Effect.Effect<string, PlatformFailure>;
    readonly start: (
      input: AgentInput,
      options?: AgentStartOptions
    ) => Effect.Effect<AgentRun, PlatformFailure>;
    readonly getRun: (
      runId: string
    ) => Effect.Effect<AgentRun, PlatformFailure>;
    readonly cancel: (
      appId: string,
      runId: string
    ) => Effect.Effect<void, PlatformFailure>;
  }
>()("api-platform/Agent") {}

export class PlatformRuntime extends Context.Service<
  PlatformRuntime,
  {
    readonly issueToken: (
      identity: AppTokenIdentity
    ) => Effect.Effect<{ expiresAt: number; token: string }, PlatformFailure>;
    readonly enqueueWarmup: (
      metadata: AppDeploymentMetadata
    ) => Effect.Effect<void, PlatformFailure>;
    readonly warmDeployment: (
      projectId: string,
      appId: string
    ) => Effect.Effect<void, PlatformFailure>;
  }
>()("api-platform/Runtime") {}

export class PlatformRateLimiter extends Context.Service<
  PlatformRateLimiter,
  ReturnType<typeof createRateLimiter>
>()("api-platform/RateLimiter") {}

export type PlatformServices =
  | PlatformDatabase
  | PlatformConfig
  | PlatformHttp
  | PlatformIds
  | PlatformStorage
  | PlatformCredentials
  | PlatformAgent
  | PlatformRuntime
  | PlatformRateLimiter;

export type PlatformEffectContext = WithEffectContext<PlatformServices>;

const agentLive = Layer.succeed(PlatformAgent, {
  cancel: (appId, runId) =>
    attempt(async () => {
      const { cancelAppAgent } = await import("@patchsmith/agent-fx/workflows");
      await cancelAppAgent(appId, runId);
    }),
  getRun: (runId) =>
    attempt(async () => {
      const { getRun } = await import("workflow/api");

      return getRun<Awaited<ReturnType<typeof appAgent>>>(runId);
    }),
  resolveThread: (appId, threadId) =>
    attempt(async () => {
      const { resolveAppAgentThread } =
        await import("@patchsmith/agent/threads");

      return await resolveAppAgentThread(appId, threadId);
    }),
  start: (input, options) =>
    attempt(async () => {
      const [{ appAgent: workflow }, { start }] = await Promise.all([
        import("@patchsmith/agent-fx/workflows"),
        import("workflow/api"),
      ]);

      return await start(workflow, [input], options);
    }),
});

export const platformRuntimeLayer = Layer.effect(
  PlatformRuntime,
  Effect.gen(function* runtimeServices() {
    const config = yield* PlatformConfig;
    const database = yield* PlatformDatabase;
    const http = yield* PlatformHttp;

    const dependencies = Context.make(PlatformConfig, config).pipe(
      Context.add(PlatformDatabase, database),
      Context.add(PlatformHttp, http)
    );

    return PlatformRuntime.of({
      enqueueWarmup: (metadata: AppDeploymentMetadata) =>
        Effect.gen(function* enqueueWarmup() {
          if (config.APP_RUNTIME_SERVICE_TOKEN === undefined) {
            return;
          }

          yield* attempt(async () => {
            const [{ start }, { warmAppDeployment }] = await Promise.all([
              import("workflow/api"),
              import("#app-runtime/deployment-workflow"),
            ]);

            await start(warmAppDeployment, [
              {
                appId: metadata.appId,
                deploymentId: metadata.deploymentId,
                projectId: metadata.projectId,
              },
            ]);
          });
        }),
      issueToken: (identity: AppTokenIdentity) =>
        Effect.gen(function* issueToken() {
          const { issueAppRuntimeTokenEffect } = yield* attempt(
            async () => await import("#app-runtime/auth")
          );

          return yield* issueAppRuntimeTokenEffect(identity).pipe(
            Effect.provide(dependencies)
          );
        }),
      warmDeployment: (projectId: string, appId: string) =>
        Effect.gen(function* warmDeployment() {
          const { warmRuntimeDeploymentEffect } = yield* attempt(
            async () => await import("#app-runtime/deployment-steps")
          );

          yield* warmRuntimeDeploymentEffect(projectId, appId).pipe(
            Effect.provide(dependencies)
          );
        }),
    });
  })
);

/** SDKs with import-time setup are loaded only when their service is used. */
export const platformInfrastructureLayer = Layer.mergeAll(
  Layer.succeed(PlatformDatabase, db),
  Layer.succeed(PlatformIds, { shortId: Effect.sync(createShortId) }),
  Layer.succeed(PlatformConfig, env),
  Layer.succeed(PlatformHttp, {
    fetch: async (input, init) => await globalThis.fetch(input, init),
  }),
  Layer.succeed(PlatformStorage, {
    get: attempt(async () => {
      const { getStorage } = await import("@patchsmith/storage");

      return getStorage();
    }),
  }),
  Layer.succeed(PlatformCredentials, {
    verifyProjectKey: (key) =>
      attempt(async () => {
        const [{ auth }, { z }] = await Promise.all([
          import("@patchsmith/auth"),
          import("zod"),
        ]);

        const result = await auth.api.verifyApiKey({
          body: { configId: "project-host", key },
        });

        return {
          projectId: z
            .object({ projectId: z.string().min(1) })
            .safeParse(result.key?.metadata).data?.projectId,
          valid: result.valid,
        };
      }),
  }),
  agentLive,
  Layer.sync(PlatformRateLimiter, () =>
    createRateLimiter({ maxRequests: 100, window: 1000 })
  )
);

export const platformLayer = platformRuntimeLayer.pipe(
  Layer.provideMerge(platformInfrastructureLayer)
);

let liveContext: Promise<Context.Context<PlatformServices>> | undefined;

export const buildPlatformContext = async () => {
  liveContext ??= runPromise(Effect.scoped(Layer.build(platformLayer)));

  try {
    return await liveContext;
  } catch (error) {
    liveContext = undefined;
    throw error;
  }
};

export const runPlatform = async <A, E>(
  effect: Effect.Effect<A, E, PlatformServices>,
  context?: Partial<PlatformEffectContext>,
  signal?: AbortSignal
): Promise<A> => {
  const services =
    context?.["effect/context"] ?? (await buildPlatformContext());

  return await runPromise(Effect.provide(effect, services), { signal });
};
