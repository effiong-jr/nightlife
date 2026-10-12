import "server-only";
import { createHash, randomBytes } from "node:crypto";

// Invite tokens: 32 random bytes, base64url. Only the SHA-256 hash is stored
// (matching public.invite_token_hash), so a database leak can't be used to
// accept invites. The raw token exists only in the link shown once to the manager.
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function inviteUrl(appUrl: string, token: string): string {
  return `${appUrl}/join/${token}`;
}
