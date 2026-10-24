import { timingSafeEqual } from "node:crypto";

import { hashSecret } from "@patchsmith/api-utils/hashing";

import { env } from "#env";

/** Bind a stream to its authorized app and thread; every reconnect still authenticates. */
export const createAgentStreamToken = (
  appId: string,
  threadId: string,
  runId: string,
  secret = env.AUTH_SECRET
) => {
  if (secret === undefined || secret === "") {
    throw new Error("AUTH_SECRET is required for agent stream tokens.");
  }

  return hashSecret(
    JSON.stringify(["patchsmith-agent-stream-v1", appId, threadId, runId]),
    secret
  );
};

export const verifyAgentStreamToken = (
  appId: string,
  threadId: string,
  runId: string,
  token: string,
  secret = env.AUTH_SECRET
) => {
  const expected = Buffer.from(
    createAgentStreamToken(appId, threadId, runId, secret)
  );

  const received = Buffer.from(token);

  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
};
