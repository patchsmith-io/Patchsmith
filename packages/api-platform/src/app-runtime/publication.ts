import type { AppDeploymentMetadata } from "@patchsmith/api-utils/app-auth";
import { Effect } from "effect";

import { PlatformDependencyError } from "#errors";
import { attempt, PlatformConfig, PlatformHttp, runPlatform } from "#services";

/** The service credential stays in the host; warming never invokes app handlers. */
export const warmRuntimeInstallationEffect = (
  metadata: AppDeploymentMetadata,
  appShortId: string
) =>
  Effect.gen(function* warmRuntimeInstallation() {
    const env = yield* PlatformConfig;
    const { fetch } = yield* PlatformHttp;
    const token = env.APP_RUNTIME_SERVICE_TOKEN;

    if (token === undefined || token === "") {
      return;
    }

    const url = new URL(
      `/p/${metadata.projectId}/a/${appShortId}/new-deployment`,
      env.APP_RUNTIME_INTERNAL_URL ??
        `https://internal.${env.ASSET_DOMAIN ?? "tailorkit.app"}`
    );

    if (url.protocol !== "https:") {
      // oxlint-disable-next-line typescript/consistent-return -- This failure returns never; successful warm-ups return void.
      return yield* new PlatformDependencyError({
        cause: undefined,
        message: "App runtime URL requires HTTPS",
      });
    }

    const response = yield* attempt(
      async (signal) =>
        await fetch(url, {
          body: JSON.stringify(metadata),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: "POST",
          redirect: "error",
          signal,
        })
    ).pipe(
      Effect.timeoutOrElse({
        duration: 30_000,
        orElse: () =>
          Effect.fail(
            new PlatformDependencyError({
              cause: undefined,
              message: "Runtime warm-up timed out",
            })
          ),
      })
    );

    if (!response.ok) {
      // oxlint-disable-next-line typescript/consistent-return -- This failure returns never; successful warm-ups return void.
      return yield* new PlatformDependencyError({
        cause: undefined,
        message: `Runtime warm-up failed (${response.status})`,
      });
    }
  });

export const warmRuntimeInstallation = async (
  metadata: AppDeploymentMetadata,
  appShortId: string
) => {
  await runPlatform(warmRuntimeInstallationEffect(metadata, appShortId));
};
