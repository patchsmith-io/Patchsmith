import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { contextErrorResponse, createContextEffect } from "#context";
import { platformError } from "#errors";
import { runPlatform } from "#services";
import type { PlatformCredentials, PlatformEffectContext } from "#services";
import { createPlatformFixture } from "#test/platform";
import { testServices } from "#test/services";

let fixture: Awaited<ReturnType<typeof createPlatformFixture>>;
let services: PlatformEffectContext;

const verify =
  vi.fn<ReturnType<typeof PlatformCredentials.of>["verifyProjectKey"]>();

const storage = {
  createDownloadUrl: vi.fn(),
  createUploadUrl: vi.fn(),
  delete: vi.fn(),
  head: vi.fn(),
  type: "s3" as const,
};

const request = (authorization?: string) =>
  new Request("https://platform.test/api/platform/apps/list", {
    headers: authorization === undefined ? {} : { authorization },
    method: "POST",
  });

beforeEach(async () => {
  fixture = await createPlatformFixture();
  verify.mockReset();
  verify.mockReturnValue(
    Effect.succeed({ projectId: fixture.project.id, valid: true })
  );
  services = testServices({
    credentials: { verifyProjectKey: verify },
    database: fixture.db,
    storage: { get: Effect.succeed(storage) },
  });
});

afterEach(async () => {
  await fixture.client.close();
});

it("builds context from verified project metadata and persisted organization membership", async () => {
  await expect(
    runPlatform(createContextEffect(request("Bearer host-key")), services)
  ).resolves.toMatchObject({
    organization: fixture.organization,
    project: fixture.project,
    runtimeService: false,
    storage,
  });
  expect(verify).toHaveBeenCalledWith("host-key");
});

it.each([undefined, "Bearer", "Bearer ", "Basic host-key"])(
  "rejects malformed authorization %s before consulting credentials",
  async (authorization) => {
    await expect(
      runPlatform(createContextEffect(request(authorization)), services)
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(verify).not.toHaveBeenCalled();
  }
);

it.each([{ valid: false }, { valid: true }, { projectId: "", valid: true }])(
  "rejects incomplete or invalid project credentials %j",
  async (result) => {
    verify.mockReturnValueOnce(Effect.succeed(result));
    await expect(
      runPlatform(createContextEffect(request("Bearer host-key")), services)
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  }
);

it("rejects unknown projects without exposing persistence details", async () => {
  verify.mockReturnValueOnce(
    Effect.succeed({ projectId: crypto.randomUUID(), valid: true })
  );
  await expect(
    runPlatform(createContextEffect(request("Bearer host-key")), services)
  ).rejects.toMatchObject({
    code: "UNAUTHORIZED",
    message: "Project not found",
  });
});

it("fails unavailable storage before performing authentication", async () => {
  const unavailable = testServices({
    credentials: { verifyProjectKey: verify },
    database: fixture.db,
    storage: { get: Effect.succeed(null) },
  });

  await expect(
    runPlatform(createContextEffect(request("Bearer host-key")), unavailable)
  ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(verify).not.toHaveBeenCalled();
});

it("reports verifier and database outages as unavailable rather than unauthorized", async () => {
  const unavailable = platformError(
    new Error("private dependency diagnostics")
  );

  verify.mockReturnValueOnce(Effect.fail(unavailable));

  const failed = runPlatform(
    createContextEffect(request("Bearer host-key")),
    services
  );

  await expect(failed).rejects.toBe(unavailable);
  const response = contextErrorResponse(unavailable);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private dependency diagnostics");
  vi.spyOn(fixture.db.query.project, "findFirst").mockRejectedValueOnce(
    new Error("Database unavailable")
  );
  await expect(
    runPlatform(createContextEffect(request("Bearer host-key")), services)
  ).rejects.toMatchObject({ _tag: "PlatformDependencyError" });
});
