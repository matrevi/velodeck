import crypto from "node:crypto";
import type { IceServerConfig } from "@velodeck/protocol";
import type { ServerConfig } from "./config.js";

export type TurnConfigSlice = Pick<
  ServerConfig,
  "stunUrls" | "turnUrls" | "turnSecret" | "turnUsername" | "turnPassword" | "turnTtlSeconds"
>;

const WEAK_TURN_SECRETS = new Set([
  "velodeck-change-me-turn-secret",
  "replace-with-openssl-rand-hex-32",
  "change-me",
  "changeme",
  "default",
  "secret",
  "password",
  "turn-secret",
  "turnsecret",
  "velodeck",
]);

export function isWeakTurnSecret(secret: string): boolean {
  const normalized = secret.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return WEAK_TURN_SECRETS.has(normalized);
}

/**
 * Builds WebRTC ICE server entries for a client.
 * - Always includes configured STUN URLs (if any).
 * - If TURN_URLS and TURN_SECRET are configured, generates ephemeral coturn
 *   REST HMAC-SHA1 credentials (draft-uberti-behave-turn-rest-00).
 * - Refuses to mint TURN credentials if TURN_SECRET is a known weak placeholder.
 * - Otherwise falls back to static TURN_USERNAME / TURN_PASSWORD if configured.
 */
export function buildIceServers(
  config: TurnConfigSlice,
  clientId: string,
  nowMs: number = Date.now(),
): IceServerConfig[] {
  const iceServers: IceServerConfig[] = [];

  if (config.stunUrls.length > 0) {
    iceServers.push({
      urls: [...config.stunUrls],
    });
  }

  if (config.turnUrls.length > 0) {
    if (config.turnSecret) {
      if (isWeakTurnSecret(config.turnSecret)) {
        console.warn(
          "[velodeck-server] Refusing to mint TURN credentials using a known weak placeholder TURN_SECRET.",
        );
      } else {
        const expiryEpochSec = Math.floor(nowMs / 1000) + config.turnTtlSeconds;
        const safeClientId = clientId.trim().length > 0 ? clientId.trim() : "anonymous";
        const username = `${expiryEpochSec}:${safeClientId}`;
        const credential = crypto
          .createHmac("sha1", config.turnSecret)
          .update(username, "utf8")
          .digest("base64");

        iceServers.push({
          urls: [...config.turnUrls],
          username,
          credential,
        });
      }
    } else if (config.turnUsername && config.turnPassword) {
      iceServers.push({
        urls: [...config.turnUrls],
        username: config.turnUsername,
        credential: config.turnPassword,
      });
    }
  }

  return iceServers;
}
