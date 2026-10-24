import { createPrivateKey, createPublicKey } from "node:crypto";

import type { AppTokenIdentity } from "@patchsmith/api-utils/app-auth";
import {
  APP_AUDIENCE,
  appRuntimeIssuer,
  issueAppTokenEffect,
  parseAppPublicKeys,
} from "@patchsmith/api-utils/app-auth";
import { Effect } from "effect";
import { z } from "zod";

import { env } from "#env";
import { PlatformConfig, platformError, runPlatform } from "#services";

const signingKey = (config: typeof env) => {
  if (
    !(
      config.APP_RUNTIME_SIGNING_KEY !== undefined &&
      config.APP_RUNTIME_SIGNING_KEY !== null &&
      config.APP_RUNTIME_SIGNING_KEY !== ""
    )
  ) {
    throw new Error(
      "APP_RUNTIME_SIGNING_KEY is required for app runtime tokens"
    );
  }

  const parsed = z
    .object({
      crv: z.literal("P-256"),
      d: z.string().min(1),
      kid: z.string().min(1),
      kty: z.literal("EC"),
      x: z.string().min(1),
      y: z.string().min(1),
    })
    .loose()
    .safeParse(JSON.parse(config.APP_RUNTIME_SIGNING_KEY));

  if (!parsed.success) {
    throw new Error("Configure an ES256 private JWK with a kid");
  }

  const key = parsed.data;

  return key;
};

const publicKeys = (config: typeof env) => {
  const key = signingKey(config);

  const publicKey = createPublicKey(
    createPrivateKey({ format: "jwk", key })
  ).export({
    format: "jwk",
  });

  // Publish retired public keys for at least six minutes after rotation (token + cache lifetime).
  let previous;

  try {
    previous = parseAppPublicKeys(
      JSON.parse(config.APP_RUNTIME_PREVIOUS_PUBLIC_KEYS ?? '{"keys":[]}')
    );
  } catch {
    throw new Error("Previous signing keys must be public ES256 keys");
  }

  return {
    keys: [
      { ...publicKey, alg: "ES256", kid: key.kid, use: "sig" },
      ...previous.keys,
    ],
  };
};

export const appRuntimePublicKeysEffect = Effect.gen(
  function* appRuntimePublicKeys() {
    const config = yield* PlatformConfig;

    return yield* Effect.try({
      catch: platformError,
      try: () => publicKeys(config),
    });
  }
);

// Synchronous adapter for the public keys HTTP endpoint.
export const appRuntimePublicKeys = (config = env) => publicKeys(config);

export const issueAppRuntimeTokenEffect = (identity: AppTokenIdentity) =>
  Effect.gen(function* issueAppRuntimeToken() {
    const config = yield* PlatformConfig;

    const key = yield* Effect.try({
      catch: platformError,
      try: () => signingKey(config),
    });

    const issuer = yield* Effect.try({
      catch: platformError,
      try: () =>
        appRuntimeIssuer(
          config.OPENAPI_SERVER_URL ?? "https://patchsmith.io/api/platform"
        ),
    });

    return yield* issueAppTokenEffect(
      { audience: APP_AUDIENCE, issuer, keyId: key.kid, privateKey: key },
      identity
    ).pipe(Effect.mapError(platformError));
  });

export const issueAppRuntimeToken = async (identity: AppTokenIdentity) =>
  await runPlatform(issueAppRuntimeTokenEffect(identity));
