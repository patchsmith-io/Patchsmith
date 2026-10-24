import { expect, it } from "vite-plus/test";

import { runtimeProjectAccess } from "./access";

const secret = "trusted-runtime-secret-at-least-32-characters";

const request = (
  path = "/api/platform/apps/app/runtime",
  method = "POST",
  token = secret,
  projectId: string | null = "project"
) => {
  const headers = new Headers({ authorization: `Bearer ${token}` });

  if (projectId !== null) {
    headers.set("x-patchsmith-project-id", projectId);
  }

  return new Request(`https://platform.test${path}`, { headers, method });
};

it("allows the trusted service to resolve multiple projects only through metadata", async () => {
  expect(await runtimeProjectAccess(request(), secret)).toBe("project");
  expect(
    await runtimeProjectAccess(
      request(undefined, undefined, undefined, "other"),
      secret
    )
  ).toBe("other");
});

it.each([
  undefined,
  "",
  "short",
  "different-runtime-secret-at-least-32-characters",
])(
  "rejects absent or invalid configured service credentials",
  async (configured) => {
    expect(await runtimeProjectAccess(request(), configured)).toBeNull();
  }
);

it.each([
  ["/api/platform/apps/app/runtime", "GET"],
  ["/api/platform/deployments", "POST"],
  ["/api/platform/apps/app/server", "POST"],
  ["/api/platform/apps/app/runtime/other", "POST"],
  ["/api/platform/apps/app%2fruntime/runtime", "POST"],
])(
  "does not grant the runtime credential access to %s (%s)",
  async (path, method) => {
    await expect(
      runtimeProjectAccess(request(path, method), secret)
    ).rejects.toThrow("restricted");
  }
);

it("requires a bounded project ID and rejects oversized tokens", async () => {
  await expect(
    runtimeProjectAccess(request(undefined, undefined, undefined, null), secret)
  ).rejects.toThrow("project required");
  await expect(
    runtimeProjectAccess(
      request(undefined, undefined, undefined, "x".repeat(257)),
      secret
    )
  ).rejects.toThrow("project required");
  expect(
    await runtimeProjectAccess(
      request(undefined, undefined, "x".repeat(8192)),
      secret
    )
  ).toBeNull();
});
