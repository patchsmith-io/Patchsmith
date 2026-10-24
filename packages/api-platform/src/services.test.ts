import { call } from "@orpc/server";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { Context } from "#context";
import { appRouter } from "#routes/apps";
import { createPlatformFixture } from "#test/platform";
import { testServices } from "#test/services";

let fixture: Awaited<ReturnType<typeof createPlatformFixture>>;

beforeEach(async () => {
  fixture = await createPlatformFixture();
});

afterEach(async () => {
  await fixture.client.close();
});

const context = (shortId: ReturnType<typeof Effect.sync<string>>): Context => ({
  ...testServices({ database: fixture.db, ids: { shortId } }),
  organization: fixture.organization,
  project: fixture.project,
  storage: {
    createDownloadUrl: vi.fn(),
    createUploadUrl: vi.fn(),
    delete: vi.fn(),
    head: vi.fn(),
    type: "s3",
  },
});

const input = () => ({
  body: { description: null, name: "New app", scope: fixture.scope.scope },
});

it("retries colliding short IDs with the injected generator", async () => {
  let attempts = 0;

  const shortId = Effect.sync(() => {
    attempts += 1;

    return attempts === 1 ? fixture.app.shortId : "newpublic001";
  });

  const result = await call(appRouter.create, input(), {
    context: context(shortId),
  });

  expect(result.body.shortId).toBe("newpublic001");
  expect(attempts).toBe(2);
});

it("stops after five collisions without inserting an app", async () => {
  const generate = vi.fn(() => fixture.app.shortId);
  await expect(
    call(appRouter.create, input(), { context: context(Effect.sync(generate)) })
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Failed to create app id.",
  });
  expect(generate).toHaveBeenCalledTimes(5);
  expect(await fixture.db.query.app.findMany()).toHaveLength(1);
});

it("keeps overlapping requests' service contexts isolated", async () => {
  const first = context(Effect.succeed("firstapp0001"));
  const second = context(Effect.succeed("secondapp001"));

  const [left, right] = await Promise.all([
    call(appRouter.create, input(), { context: first }),
    call(appRouter.create, input(), { context: second }),
  ]);

  expect([left.body.shortId, right.body.shortId]).toEqual([
    "firstapp0001",
    "secondapp001",
  ]);
});
