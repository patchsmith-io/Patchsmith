import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { call } from "@orpc/server";
import {
  issueAgentToken,
  verifyAgentToken,
} from "@patchsmith/api-utils/agent-token";
import { hashSecret } from "@patchsmith/api-utils/hashing";
import { app as appTable } from "@patchsmith/db/schema/apps";
import { cliToken } from "@patchsmith/db/schema/cli-auth";
import { describe, expect, it } from "vite-plus/test";

import { canonicalizeScope } from "#scope";
import {
  appTestFixture,
  projectId,
  otherProjectId,
  productionScope,
  stagingScope,
} from "#test/apps";

import { appAgentRouter } from "./app-agent";
import { appRouter } from "./apps";

describe("platform apps-agent", () => {
  const fixture = appTestFixture();
  const { createContext, testState } = fixture;

  it.each([{ createdByAgent: true }, { scope: stagingScope }])(
    "rejects caller-supplied agent creation fields %j",
    async (untrustedFields) => {
      const handler = new OpenAPIHandler({ appAgent: appAgentRouter });

      const result = await handler.handle(
        new Request("https://platform.test/api/platform/app-agent/apps", {
          body: JSON.stringify({
            ...untrustedFields,
            deployToken: "cli-token",
            description: null,
            name: "Forged AI app",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        { context: createContext(), prefix: "/api/platform" }
      );

      expect(result.response?.status).toBe(400);
      expect(await fixture.db.select().from(appTable)).toEqual([]);
    }
  );

  it.each(["cli", "agent"] as const)(
    "derives AI provenance and scope from an authenticated %s creation flow",
    async (credential) => {
      const secret = testState.env.AUTH_SECRET;

      const [source] = await fixture.db
        .insert(cliToken)
        .values({
          expiresAt: new Date(Date.now() + 3_600_000),
          projectId,
          ...canonicalizeScope(productionScope),
          tokenHash: hashSecret("cli-token", secret),
        })
        .returning();

      if (!source) {
        throw new Error("Expected CLI credential.");
      }

      const context = createContext();
      let deployToken = "cli-token";

      if (credential === "agent") {
        deployToken = await issueAgentToken(
          {
            appId: "initiating-app",
            cliTokenId: source.id,
            projectId,
            scope: productionScope,
          },
          secret,
          "https://platform.test/api/platform"
        );
        context.agentToken = {
          ...(await verifyAgentToken(
            deployToken,
            secret,
            "https://platform.test/api/platform"
          )),
          token: deployToken,
        };

        const manual = await call(
          appRouter.create,
          {
            body: {
              description: null,
              name: "Manual app",
              scope: productionScope,
            },
          },
          { context }
        );

        expect(manual.body.createdByAgent).toBe(false);
      }

      const created = await call(
        appAgentRouter.create,
        {
          body: { deployToken, description: null, name: "AI app" },
        },
        { context }
      );

      expect(created.body.createdByAgent).toBe(true);
      expect(created.body.scope).toEqual(productionScope);

      const found = await call(
        appRouter.get,
        {
          body: { app: { id: created.body.id }, scopes: [productionScope] },
        },
        { context }
      );

      expect(found.body.createdByAgent).toBe(true);

      const listed = await call(
        appRouter.list,
        {
          body: { scopes: [productionScope] },
        },
        { context }
      );

      expect(listed.body.items).toContainEqual(
        expect.objectContaining({ createdByAgent: true, id: created.body.id })
      );
    }
  );

  it.each(["missing", "expired", "revoked", "foreign-project"])(
    "rejects %s CLI credentials before creating an agent app",
    async (credential) => {
      await fixture.db.insert(cliToken).values({
        expiresAt: new Date(
          Date.now() + (credential === "expired" ? -1000 : 3_600_000)
        ),
        projectId:
          credential === "foreign-project" ? otherProjectId : projectId,
        revokedAt: credential === "revoked" ? new Date() : null,
        ...canonicalizeScope(productionScope),
        tokenHash: hashSecret("cli-token", testState.env.AUTH_SECRET),
      });
      await expect(
        call(
          appAgentRouter.create,
          {
            body: {
              deployToken:
                credential === "missing" ? "missing-token" : "cli-token",
              description: null,
              name: "AI app",
            },
          },
          { context: createContext() }
        )
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(await fixture.db.select().from(appTable)).toEqual([]);
    }
  );
});
