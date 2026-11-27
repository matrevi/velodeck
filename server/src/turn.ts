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

function orderTurnUrls(urls: readonly string[]): string[] {
  const rank = (url: string): number => {
    const lower = url.toLowerCase();
    if (lower.includes("transport=udp")) return 0;
    if (lower.startsWith("turn:") && !lower.includes("transport=tcp")) return 1;
    if (lower.includes("transport=tcp")) return 2;
    if (lower.startsWith("turns:")) return 3;
    return 4;
  };
  return [...urls]
    .map((url, idx) => ({ url, idx, rank: rank(url) }))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
    .map((item) => item.url);
}

function deriveColocatedStunUrls(orderedTurnUrls: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawUrl of orderedTurnUrls) {
    const trimmed = rawUrl.trim();
    const match = /^turns?:([^?#/]+)(?:\?.*)?$/i.exec(trimmed);
    const hostPort = match?.[1]?.trim();
    if (!hostPort || /\s/.test(hostPort)) {
      continue;
    }
    const stunUrl = `stun:${hostPort}`;
    const key = stunUrl.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(stunUrl);
    }
  }
  return result;
}

/**
 * Builds WebRTC ICE server entries for a client.
 * - Prepends co-located STUN URLs derived from configured TURN_URLS (e.g. our own coturn)
 *   ahead of third-party public STUN_URLS (deduplicated) for faster, consistent NAT srflx mapping.
 * - Emits each TURN URL as its own ordered entry (UDP first, then TCP/TLS)
 *   for deterministic cross-browser relay priority.
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
  const orderedTurnUrls =
    config.turnUrls.length > 0 ? orderTurnUrls(config.turnUrls) : [];

  const mergedStunUrls: string[] = [];
  const seenStun = new Set<string>();
  const addStunUrl = (url: string): void => {
    const trimmed = url.trim();
    if (trimmed.length === 0) return;
    const key = trimmed.toLowerCase();
    if (!seenStun.has(key)) {
      seenStun.add(key);
      mergedStunUrls.push(trimmed);
    }
  };

  for (const colocated of deriveColocatedStunUrls(orderedTurnUrls)) {
    addStunUrl(colocated);
  }
  for (const stunUrl of config.stunUrls) {
    addStunUrl(stunUrl);
  }

  if (mergedStunUrls.length > 0) {
    iceServers.push({
      urls: mergedStunUrls,
    });
  }

  if (orderedTurnUrls.length > 0) {
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

        for (const url of orderedTurnUrls) {
          iceServers.push({
            urls: [url],
            username,
            credential,
          });
        }
      }
    } else if (config.turnUsername && config.turnPassword) {
      for (const url of orderedTurnUrls) {
        iceServers.push({
          urls: [url],
          username: config.turnUsername,
          credential: config.turnPassword,
        });
      }
    }
  }

  return iceServers;
}
