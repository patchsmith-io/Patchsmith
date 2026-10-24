import type { RouterClient } from "@orpc/server";

import type { deploymentRouter } from "#routes/deployments";

import { lazyOpenAPIRouter } from "./lazy-router";

type DeploymentRouter = typeof deploymentRouter;

type DeploymentOperation = Exclude<keyof DeploymentRouter, "runtime">;

const lazyDeploymentOperation = <TOperation extends DeploymentOperation>(
  operation: TOperation
) =>
  lazyOpenAPIRouter("/deployments", async () => {
    const { deploymentRouter } = await import("#routes/deployments");

    return { default: deploymentRouter[operation] };
  });

export const platformRouter = {
  appAgent: lazyOpenAPIRouter("/app-agent", async () => {
    const { appAgentRouter } = await import("#routes/app-agent");

    return { default: appAgentRouter };
  }),
  apps: lazyOpenAPIRouter("/apps", async () => {
    const { appRouter } = await import("#routes/apps");

    return { default: appRouter };
  }),
  cliAuth: lazyOpenAPIRouter("/cli-auth", async () => {
    const { cliAuthRouter } = await import("#routes/cli-auth");

    return { default: cliAuthRouter };
  }),
  deployments: {
    create: lazyDeploymentOperation("create"),
    get: lazyDeploymentOperation("get"),
    list: lazyDeploymentOperation("list"),
    publish: lazyDeploymentOperation("publish"),
    runtime: lazyOpenAPIRouter("/apps", async () => {
      const { getRuntimeBundle } = await import("#routes/app-runtime");

      return { default: getRuntimeBundle };
    }),
  },
};

export type PlatformRouter = typeof platformRouter;

export type PlatformRouterClient = RouterClient<PlatformRouter>;
