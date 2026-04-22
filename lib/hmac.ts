import crypto from "node:crypto";

/**
 * Sign a payload for orchestrator webhooks. Orchestrator calls back into
 * /api/orchestrator/webhook with `x-swarm-signature: sha256=<hex>`, where
 * <hex> is HMAC-SHA256(secret, raw_body).
 */
export function sign(payload: string, secret: string): string {
  const h = crypto.createHmac("sha256", secret);
  h.update(payload);
  return "sha256=" + h.digest("hex");
}

/**
 * Constant-time verification to avoid leaking signature length via timing.
 */
export function verify(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = sign(payload, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
