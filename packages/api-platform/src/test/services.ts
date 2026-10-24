import { Context, Effect, Layer } from "effect";

import { env } from "#env";
import {
  PlatformAgent,
  PlatformConfig,
  PlatformCredentials,
  PlatformDatabase,
  PlatformHttp,
  PlatformIds,
  PlatformRateLimiter,
  PlatformRuntime,
  PlatformStorage,
  platformInfrastructureLayer,
  platformRuntimeLayer,
} from "#services";
import type { PlatformDb, PlatformEffectContext } from "#services";

interface TestServices {
  database?: PlatformDb;
  ids?: ReturnType<typeof PlatformIds.of>;
  config?: typeof env;
  fetch?: typeof fetch;
  agent?: Partial<ReturnType<typeof PlatformAgent.of>>;
  runtime?: Partial<ReturnType<typeof PlatformRuntime.of>>;
  credentials?: ReturnType<typeof PlatformCredentials.of>;
  storage?: ReturnType<typeof PlatformStorage.of>;
}

/** Build real service layers; replace only the external capabilities a scenario controls. */
export const testServices = (
  options: TestServices = {}
): PlatformEffectContext => {
  const base = Effect.runSync(
    Effect.scoped(Layer.build(platformInfrastructureLayer))
  );

  const layers = Layer.mergeAll(
    Layer.succeed(PlatformIds, options.ids ?? Context.get(base, PlatformIds)),
    Layer.succeed(PlatformConfig, options.config ?? env),
    Layer.succeed(
      PlatformDatabase,
      options.database ?? Context.get(base, PlatformDatabase)
    ),
    Layer.succeed(PlatformHttp, {
      fetch: options.fetch ?? Context.get(base, PlatformHttp).fetch,
    }),
    Layer.succeed(PlatformAgent, {
      ...Context.get(base, PlatformAgent),
      ...options.agent,
    }),
    Layer.succeed(
      PlatformCredentials,
      options.credentials ?? Context.get(base, PlatformCredentials)
    ),
    Layer.succeed(
      PlatformStorage,
      options.storage ?? Context.get(base, PlatformStorage)
    ),
    // Keep the real limiter while giving each test request context its own bucket.
    Layer.succeed(PlatformRateLimiter, Context.get(base, PlatformRateLimiter))
  );

  const dependencies = Effect.runSync(Effect.scoped(Layer.build(layers)));

  const runtime = Effect.runSync(
    Effect.scoped(Layer.build(platformRuntimeLayer.pipe(Layer.provide(layers))))
  );

  return {
    "effect/context": Context.add(dependencies, PlatformRuntime, {
      ...Context.get(runtime, PlatformRuntime),
      ...options.runtime,
    }),
  };
};
