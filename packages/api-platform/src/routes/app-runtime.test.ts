import { generateKeyPairSync } from "node:crypto";

import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call } from "@orpc/server";
import {
  app,
  appDeployment,
  appDeploymentFile,
} from "@patchsmith/db/schema/apps";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { appRuntimePublicKeys } from "#app-runtime/auth";
import { warmRuntimeInstallationEffect } from "#app-runtime/publication";
import type { Context } from "#context";
import { env } from "#env";
import { attempt, runPlatform } from "#services";
import { createPlatformFixture } from "#test/platform";
import { testServices } from "#test/services";

import { getRuntimeBundle, handlePublicRuntimeRequest } from "./app-runtime";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

const config = {
  ...env,
  APP_RUNTIME_INTERNAL_URL: "https://internal.tailorkit.app",
  APP_RUNTIME_SERVICE_TOKEN: "x".repeat(32),
  APP_RUNTIME_SIGNING_KEY: JSON.stringify({
    ...privateKey.export({ format: "jwk" }),
    kid: "platform",
  }),
};

let fixture: Awaited<ReturnType<typeof createPlatformFixture>>;
let context: Context;
const fetcher = vi.fn<typeof fetch>();

beforeEach(async () => {
  fixture = await createPlatformFixture();
  fetcher.mockReset();
  context = {
    ...testServices({ config, database: fixture.db, fetch: fetcher }),
    organization: fixture.organization,
    project: fixture.project,
    runtimeService: true,
    storage: {
      createDownloadUrl: vi.fn(),
      createUploadUrl: vi.fn(),
      delete: vi.fn(),
      head: vi.fn(),
      type: "s3",
    },
  };
});

afterEach(async () => {
  await fixture.client.close();
});

it("serves real public signing keys without an authenticated context", async () => {
  const response = handlePublicRuntimeRequest(
    new Request("https://platform.test/api/platform/runtime/keys"),
    config
  );

  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("public, max-age=60");
  await expect(response?.json()).resolves.toEqual(appRuntimePublicKeys(config));
});

it.each([
  ["GET", "/api/platform/apps/app/runtime/session"],
  ["POST", "/api/platform/runtime/keys"],
])("leaves %s %s to the authenticated router", (method, path) => {
  expect(
    handlePublicRuntimeRequest(
      new Request(`https://platform.test${path}`, { method }),
      config
    )
  ).toBeUndefined();
});

it("returns non-cacheable errors without exposing signing configuration", async () => {
  const response = handlePublicRuntimeRequest(
    new Request("https://platform.test/api/platform/runtime/keys"),
    { ...config, APP_RUNTIME_SIGNING_KEY: "Private configuration details" }
  );

  expect(response?.status).toBe(503);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.text()).toBe("Signing keys unavailable");
});

const metadata = {
  appId: "app",
  checksum: "a".repeat(64),
  contentLength: 10,
  deploymentId: "v2",
  objectKey: "private/server.js",
  projectId: "project",
};

it("posts runtime metadata with host-owned credentials through the injected transport", async () => {
  fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await runPlatform(
    warmRuntimeInstallationEffect(metadata, "app000000001"),
    context
  );
  expect(fetcher).toHaveBeenCalledWith(
    new URL(
      "https://internal.tailorkit.app/p/project/a/app000000001/new-deployment"
    ),
    expect.objectContaining({
      body: JSON.stringify(metadata),
      headers: {
        authorization: `Bearer ${config.APP_RUNTIME_SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
    })
  );
  fetcher.mockRejectedValueOnce(new Error("Network unavailable"));
  await expect(
    runPlatform(
      warmRuntimeInstallationEffect(metadata, "app000000001"),
      context
    )
  ).rejects.toMatchObject({
    _tag: "PlatformDependencyError",
    message: "Network unavailable",
  });
});

it.each([404, 503])("fails a runtime warm-up on HTTP %s", async (status) => {
  fetcher.mockResolvedValueOnce(new Response(null, { status }));
  await expect(
    runPlatform(
      warmRuntimeInstallationEffect(metadata, "app000000001"),
      context
    )
  ).rejects.toThrow(`Runtime warm-up failed (${status})`);
});

it("skips unconfigured warming and rejects insecure internal URLs before fetching", async () => {
  await runPlatform(
    warmRuntimeInstallationEffect(metadata, "app"),
    testServices({
      config: { ...config, APP_RUNTIME_SERVICE_TOKEN: undefined },
      fetch: fetcher,
    })
  );
  expect(fetcher).not.toHaveBeenCalled();
  await expect(
    runPlatform(
      warmRuntimeInstallationEffect(metadata, "app"),
      testServices({
        config: { ...config, APP_RUNTIME_INTERNAL_URL: "http://internal.test" },
        fetch: fetcher,
      })
    )
  ).rejects.toThrow("requires HTTPS");
  expect(fetcher).not.toHaveBeenCalled();
});

it("returns only verified metadata for the authenticated project over the real HTTP route", async () => {
  const [deployment] = await fixture.db
    .insert(appDeployment)
    .values({ appId: fixture.app.id, status: "published" })
    .returning();

  if (!deployment) {
    throw new Error("Missing deployment");
  }

  const key = `projects/${fixture.project.shortId}/apps/${fixture.app.shortId}/deployments/${deployment.shortId}/server/server.js`;

  const [file] = await fixture.db
    .insert(appDeploymentFile)
    .values({
      appDeploymentId: deployment.id,
      checksum: metadata.checksum,
      contentLength: 123,
      contentType: "application/javascript",
      encoding: "utf-8",
      objectKey: key,
      status: "verified",
    })
    .returning();

  if (!file) {
    throw new Error("Missing server file");
  }

  await fixture.db
    .update(app)
    .set({ currentDeploymentId: deployment.id })
    .where(eq(app.id, fixture.app.id));
  const handler = new OpenAPIHandler({ runtime: getRuntimeBundle });

  const { matched, response } = await handler.handle(
    new Request(
      `https://platform.test/api/platform/apps/${fixture.app.id}/runtime`,
      {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    ),
    { context, prefix: "/api/platform" }
  );

  expect(matched).toBe(true);
  expect(response?.status).toBe(200);
  await expect(response?.json()).resolves.toEqual({
    appId: fixture.app.id,
    checksum: metadata.checksum,
    contentLength: 123,
    deploymentId: deployment.id,
    objectKey: key,
    projectId: fixture.project.id,
  });
  await fixture.db
    .update(appDeploymentFile)
    .set({ status: "uploading" })
    .where(eq(appDeploymentFile.id, file.id));
  await expect(
    call(
      getRuntimeBundle,
      { body: {}, params: { appId: fixture.app.id } },
      { context }
    )
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    call(
      getRuntimeBundle,
      { body: {}, params: { appId: fixture.app.id } },
      { context: { ...context, runtimeService: false } }
    )
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("interrupts and aborts a timed-out warm-up using Effect's test clock", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  fetcher.mockImplementation(async (_input, init) => {
    const signal = init?.signal;

    if (!signal) {
      throw new Error("Missing cancellation signal");
    }

    started.resolve(signal);

    const response = Promise.withResolvers<Response>();
    signal.addEventListener(
      "abort",
      () => {
        response.reject(new Error("Aborted"));
      },
      { once: true }
    );

    return await response.promise;
  });
  await runPlatform(
    Effect.gen(function* timeoutWarmup() {
      const fiber = yield* Effect.forkChild(
        warmRuntimeInstallationEffect(metadata, "app")
      );

      const signal = yield* attempt(async () => await started.promise);
      yield* TestClock.adjust(30_000);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);

      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "PlatformDependencyError",
          message: "Runtime warm-up timed out",
        });
      }

      expect(signal.aborted).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
    context
  );
});
