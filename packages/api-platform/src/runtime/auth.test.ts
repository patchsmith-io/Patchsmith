import { APP_AUDIENCE, appTokenVerifier } from "@patchsmith/api-utils/app-auth";
import { expect, it } from "vite-plus/test";

import { env } from "#env";
import { runPlatform } from "#services";
import { testServices } from "#test/services";

import { appRuntimePublicKeys, issueAppRuntimeTokenEffect } from "./auth";

const settings = {
  ...env,
  APP_RUNTIME_SIGNING_KEY: "",
  OPENAPI_SERVER_URL: "https://platform.test/api/platform",
};

const pair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"]
);

settings.APP_RUNTIME_SIGNING_KEY = JSON.stringify({
  ...(await crypto.subtle.exportKey("jwk", pair.privateKey)),
  kid: "platform",
});

it("publishes only public keys and issues platform-bound short-lived access", async () => {
  const publicKeys = appRuntimePublicKeys(settings);
  expect(publicKeys.keys[0]).not.toHaveProperty("d");

  const identity = {
    appId: "app",
    appShortId: "app000000001",
    deploymentId: "deployment",
    installationId: "installation",
    projectId: "project",
    projectShortId: "abc123def456",
    scope: { name: "org", value: { id: "tenant" } },
    subjectId: "service-principal",
    toolUrl: "https://host.test/api/patchsmith/tools/execute",
  };

  const issuedAfter = Math.floor(Date.now() / 1000);

  const session = await runPlatform(
    issueAppRuntimeTokenEffect(identity),
    testServices({ config: settings })
  );

  const issuedBefore = Math.floor(Date.now() / 1000);

  const verify = appTokenVerifier({
    audience: APP_AUDIENCE,
    issuer: settings.OPENAPI_SERVER_URL,
    publicKeys,
  });

  expect(await verify(session.token)).toMatchObject(identity);
  expect(session.expiresAt).toBeGreaterThanOrEqual((issuedAfter + 300) * 1000);
  expect(session.expiresAt).toBeLessThanOrEqual((issuedBefore + 300) * 1000);
});

it("refuses to expose private material in retired keys", () => {
  settings.APP_RUNTIME_PREVIOUS_PUBLIC_KEYS = JSON.stringify({
    keys: [JSON.parse(settings.APP_RUNTIME_SIGNING_KEY)],
  });
  expect(() => appRuntimePublicKeys(settings)).toThrow("public ES256");
  settings.APP_RUNTIME_PREVIOUS_PUBLIC_KEYS = undefined;
});
