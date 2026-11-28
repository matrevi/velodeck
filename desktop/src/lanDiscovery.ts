import dgram from "node:dgram";
import os from "node:os";

export const LAN_DISCOVERY_PORT = 21119;
export const WOL_UDP_PORT = 9;

export interface LocalNetworkInfo {
  lanIp: string;
  macAddresses: string[];
  broadcastAddresses: string[];
}

export interface LanPeerInfo {
  deviceId: string;
  name: string;
  osPlatform: string;
  lanIp: string;
  macAddresses: string[];
  controlCode: string;
  seenAt: number;
}

export interface LanHostAnnouncement {
  deviceId: string;
  name: string;
  osPlatform: string;
  controlCode: string;
}

export interface LanDiscoveryServiceOptions {
  port?: number;
  getAnnouncement: () => LanHostAnnouncement | null;
}

const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAC_STRICT_REGEX =
  /^([0-9a-fA-F]{2})([:-])([0-9a-fA-F]{2})(?:\2([0-9a-fA-F]{2})){4}$/;
const ZERO_MAC = "00:00:00:00:00:00";
const MAX_MAC_ADDRESSES = 16;
const MAX_UDP_PACKET_BYTES = 4096;
const VIRTUAL_INTERFACE_PREFIXES = [
  "utun",
  "docker",
  "br-",
  "veth",
  "vmnet",
  "vboxnet",
  "tailscale",
  "wg",
  "lo",
  "virbr",
  "tun",
  "tap",
  "awdl",
  "llw",
  "bridge",
  "vethernet",
];

function isVirtualInterfaceName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return VIRTUAL_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const match = IPV4_REGEX.exec(ip.trim());
  if (!match) return null;
  for (let i = 1; i <= 4; i += 1) {
    const rawOctet = match[i]!;
    if (rawOctet.length > 1 && rawOctet.startsWith("0")) {
      return null;
    }
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if (
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    !Number.isInteger(c) ||
    !Number.isInteger(d) ||
    a < 0 ||
    a > 255 ||
    b < 0 ||
    b > 255 ||
    c < 0 ||
    c > 255 ||
    d < 0 ||
    d > 255
  ) {
    return null;
  }
  return [a, b, c, d];
}

export function isValidIpv4(ip: string): boolean {
  return parseIpv4Octets(ip) !== null;
}

export function isRfc1918Ipv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function isAllowedWolBroadcastIp(ip: string): boolean {
  if (typeof ip !== "string") return false;
  const clean = ip.trim();
  if (clean === "255.255.255.255") return true;
  return isRfc1918Ipv4(clean);
}

export function isPrivateOrCgnatIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // RFC 6598 CGNAT / Tailscale overlay range (100.64.0.0/10)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function normalizeMacAddress(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!MAC_STRICT_REGEX.test(trimmed)) return null;
  const normalized = trimmed.replace(/-/g, ":").toUpperCase();
  if (normalized === ZERO_MAC) return null;
  return normalized;
}

function computeBroadcastAddress(ip: string, netmask: string): string | null {
  const ipOctets = parseIpv4Octets(ip);
  const maskOctets = parseIpv4Octets(netmask);
  if (!ipOctets || !maskOctets) return null;
  const b0 = (ipOctets[0] | (~maskOctets[0] & 0xff)) & 0xff;
  const b1 = (ipOctets[1] | (~maskOctets[1] & 0xff)) & 0xff;
  const b2 = (ipOctets[2] | (~maskOctets[2] & 0xff)) & 0xff;
  const b3 = (ipOctets[3] | (~maskOctets[3] & 0xff)) & 0xff;
  return `${b0}.${b1}.${b2}.${b3}`;
}

/**
 * Validates a MAC address (`XX:XX:XX:XX:XX:XX` or `XX-XX-XX-XX-XX-XX`) and builds
 * the exact 102-byte Wake-on-LAN magic packet (`6x 0xFF` + `16x 6-byte MAC`).
 * Throws an Error if the MAC address is invalid.
 */
export function buildWolMagicPacket(macAddress: string): Buffer {
  const normalized = normalizeMacAddress(macAddress);
  if (!normalized) {
    throw new Error(`Invalid MAC address: ${String(macAddress)}`);
  }

  const macBytes = Buffer.from(
    normalized.split(":").map((hex) => parseInt(hex, 16)),
  );
  if (macBytes.length !== 6) {
    throw new Error(`Invalid MAC address byte length: ${normalized}`);
  }

  const packet = Buffer.alloc(102);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i += 1) {
    macBytes.copy(packet, 6 + i * 6);
  }
  return packet;
}

/**
 * Inspects local network interfaces (or a provided mock map for testing) and extracts:
 * - `lanIp`: preferred RFC1918 (or CGNAT) IPv4 address
 * - `macAddresses`: deduplicated uppercase MACs excluding `00:00:00:00:00:00`
 * - `broadcastAddresses`: deduplicated subnet broadcast addresses
 */
export function collectLocalNetworkInfo(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LocalNetworkInfo {
  const physicalRfc1918Ips: string[] = [];
  const virtualRfc1918Ips: string[] = [];
  const physicalCgnatIps: string[] = [];
  const virtualCgnatIps: string[] = [];
  const macSet = new Set<string>();
  const broadcastSet = new Set<string>();

  for (const [ifaceName, entries] of Object.entries(interfaces)) {
    if (!Array.isArray(entries)) continue;
    const isVirtual = isVirtualInterfaceName(ifaceName);
    for (const entry of entries) {
      if (!entry || entry.internal) continue;
      const fam = entry.family as string | number;
      if (fam !== "IPv4" && fam !== 4) continue;

      const ip = typeof entry.address === "string" ? entry.address.trim() : "";
      if (!isPrivateOrCgnatIpv4(ip)) continue;

      if (isRfc1918Ipv4(ip)) {
        const bucket = isVirtual ? virtualRfc1918Ips : physicalRfc1918Ips;
        if (!bucket.includes(ip)) bucket.push(ip);
      } else {
        const bucket = isVirtual ? virtualCgnatIps : physicalCgnatIps;
        if (!bucket.includes(ip)) bucket.push(ip);
      }

      if (typeof entry.mac === "string") {
        const mac = normalizeMacAddress(entry.mac);
        if (mac && macSet.size < MAX_MAC_ADDRESSES) {
          macSet.add(mac);
        }
      }

      if (typeof entry.netmask === "string") {
        const broadcast = computeBroadcastAddress(ip, entry.netmask);
        if (broadcast && broadcast !== ip) {
          broadcastSet.add(broadcast);
        }
      }
    }
  }

  return {
    lanIp:
      physicalRfc1918Ips[0] ??
      virtualRfc1918Ips[0] ??
      physicalCgnatIps[0] ??
      virtualCgnatIps[0] ??
      "",
    macAddresses: Array.from(macSet),
    broadcastAddresses: Array.from(broadcastSet),
  };
}

function sendUdpPacket(
  socket: dgram.Socket,
  payload: Buffer,
  port: number,
  address: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      socket.send(payload, 0, payload.length, port, address, (err) => {
        resolve(!err);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Broadcasts a 102-byte Wake-on-LAN magic packet over UDP port 9.
 * Uses `broadcastIp` if provided and valid; otherwise sends to all local subnet
 * broadcast addresses plus `255.255.255.255`.
 */
export async function sendWakeOnLan(
  macAddress: string,
  broadcastIp?: string,
): Promise<{ ok: boolean; error?: string }> {
  let packet: Buffer;
  try {
    packet = buildWolMagicPacket(macAddress);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "无效的 MAC 地址",
    };
  }

  const targets: string[] = [];
  if (typeof broadcastIp === "string" && broadcastIp.trim().length > 0) {
    const cleanIp = broadcastIp.trim();
    if (!isAllowedWolBroadcastIp(cleanIp)) {
      return {
        ok: false,
        error: `无效的局域网广播 IP 地址（仅允许 255.255.255.255 或私有 IPv4）: ${cleanIp}`,
      };
    }
    targets.push(cleanIp);
  } else {
    const net = collectLocalNetworkInfo();
    const set = new Set<string>(net.broadcastAddresses);
    set.add("255.255.255.255");
    targets.push(...set);
  }

  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error): void => {
        socket.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        socket.removeListener("error", onErr);
        resolve();
      };
      socket.once("error", onErr);
      socket.once("listening", onListening);
      socket.bind(0);
    });

    socket.setBroadcast(true);

    let sentCount = 0;
    for (const target of targets) {
      const ok = await sendUdpPacket(socket, packet, WOL_UDP_PORT, target);
      if (ok) sentCount += 1;
    }

    if (sentCount === 0) {
      return { ok: false, error: "UDP 唤醒魔术包发送失败" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "发送 Wake-on-LAN 失败",
    };
  } finally {
    try {
      socket.close();
    } catch {
      // Ignore socket close error
    }
  }
}

function sanitizePeerString(raw: unknown, maxLen: number): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLen);
}

/**
 * UDP LAN peer discovery service (default port 21119).
 * - Responds to `{"v":1,"cmd":"discover"}` with public device metadata (NEVER secrets/passwords).
 * - Broadcasts discovery probes to locate other VeloDeck desktop hosts on the same LAN.
 */
export class LanDiscoveryService {
  private readonly port: number;
  private readonly getAnnouncement: () => LanHostAnnouncement | null;
  private socket: dgram.Socket | null = null;
  private active = false;

  constructor(options: LanDiscoveryServiceOptions) {
    this.port = options.port ?? LAN_DISCOVERY_PORT;
    this.getAnnouncement = options.getAnnouncement;
  }

  public isRunning(): boolean {
    return this.active;
  }

  public start(): void {
    if (this.active || this.socket) {
      return;
    }

    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = sock;
    this.active = true;

    sock.on("error", (err) => {
      console.warn("[velodeck-lan] UDP discovery listener error:", err.message);
      if (this.socket === sock) {
        this.stop();
      }
    });

    sock.on("listening", () => {
      try {
        sock.setBroadcast(true);
      } catch {
        // Optional on some interfaces
      }
    });

    sock.on("message", (msgBuf, rinfo) => {
      if (msgBuf.byteLength === 0 || msgBuf.byteLength > MAX_UDP_PACKET_BYTES) {
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        const obj: unknown = JSON.parse(msgBuf.toString("utf8"));
        if (!obj || typeof obj !== "object") return;
        parsed = obj as Record<string, unknown>;
      } catch {
        return;
      }

      if (parsed.v !== 1 || parsed.cmd !== "discover") {
        return;
      }

      const ann = this.getAnnouncement();
      if (!ann || !ann.deviceId) {
        return;
      }

      const net = collectLocalNetworkInfo();
      const response = JSON.stringify({
        v: 1,
        cmd: "announce",
        deviceId: ann.deviceId,
        name: ann.name,
        osPlatform: ann.osPlatform,
        lanIp: net.lanIp,
        macAddresses: net.macAddresses,
        controlCode: ann.controlCode,
      });

      const payload = Buffer.from(response, "utf8");
      try {
        sock.send(payload, 0, payload.length, rinfo.port, rinfo.address, () => {
          // Swallow transient per-interface send errors so the listener remains active
        });
      } catch {
        // Ignore transient send errors
      }
    });

    try {
      sock.bind(this.port);
    } catch (err) {
      console.warn(
        "[velodeck-lan] Failed to bind UDP discovery port:",
        err instanceof Error ? err.message : String(err),
      );
      this.stop();
    }
  }

  public stop(): void {
    this.active = false;
    const sock = this.socket;
    this.socket = null;
    if (!sock) return;
    try {
      sock.removeAllListeners();
      sock.close();
    } catch {
      // Ignore
    }
  }

  public async discoverPeers(
    timeoutMs = 1200,
    excludeDeviceId?: string,
  ): Promise<LanPeerInfo[]> {
    const safeTimeout = Math.max(200, Math.min(5000, Math.round(timeoutMs || 1200)));
    const selfId = excludeDeviceId ?? this.getAnnouncement()?.deviceId ?? "";
    const peers = new Map<string, LanPeerInfo>();

    const probe = Buffer.from(JSON.stringify({ v: 1, cmd: "discover" }), "utf8");
    const net = collectLocalNetworkInfo();
    const targetSet = new Set<string>(net.broadcastAddresses);
    targetSet.add("255.255.255.255");
    const targets = Array.from(targetSet);

    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

    return new Promise<LanPeerInfo[]>((resolve) => {
      let settled = false;
      let retryTimer: NodeJS.Timeout | null = null;
      let doneTimer: NodeJS.Timeout | null = null;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        if (doneTimer) {
          clearTimeout(doneTimer);
          doneTimer = null;
        }
        try {
          sock.close();
        } catch {
          // Ignore
        }
        resolve(Array.from(peers.values()));
      };

      sock.on("error", () => {
        finish();
      });

      sock.on("message", (msgBuf, rinfo) => {
        if (msgBuf.byteLength === 0 || msgBuf.byteLength > MAX_UDP_PACKET_BYTES) {
          return;
        }
        let parsed: Record<string, unknown>;
        try {
          const obj: unknown = JSON.parse(msgBuf.toString("utf8"));
          if (!obj || typeof obj !== "object") return;
          parsed = obj as Record<string, unknown>;
        } catch {
          return;
        }
        if (parsed.v !== 1 || parsed.cmd !== "announce") {
          return;
        }

        const deviceId = sanitizePeerString(parsed.deviceId, 64);
        if (!deviceId || (selfId && deviceId === selfId)) {
          return;
        }

        const name = sanitizePeerString(parsed.name, 64) || deviceId;
        const osPlatform = sanitizePeerString(parsed.osPlatform, 32) || "linux";
        const reportedIp = sanitizePeerString(parsed.lanIp, 64);
        const lanIp = isPrivateOrCgnatIpv4(reportedIp)
          ? reportedIp
          : isValidIpv4(rinfo.address)
            ? rinfo.address
            : "";
        const controlCode = sanitizePeerString(parsed.controlCode, 24);
        const rawMacs = Array.isArray(parsed.macAddresses)
          ? parsed.macAddresses
          : [];
        const macSet = new Set<string>();
        for (const item of rawMacs) {
          if (typeof item !== "string") continue;
          const norm = normalizeMacAddress(item);
          if (norm && macSet.size < MAX_MAC_ADDRESSES) {
            macSet.add(norm);
          }
        }

        peers.set(deviceId, {
          deviceId,
          name,
          osPlatform,
          lanIp,
          macAddresses: Array.from(macSet),
          controlCode,
          seenAt: Date.now(),
        });
      });

      const sendProbes = (): void => {
        for (const target of targets) {
          try {
            sock.send(probe, 0, probe.length, this.port, target, () => {
              // Swallow per-interface broadcast errors (e.g. EHOSTUNREACH/ENETUNREACH)
            });
          } catch {
            // Ignore per-interface broadcast errors
          }
        }
      };

      sock.once("listening", () => {
        try {
          sock.setBroadcast(true);
        } catch {
          // Ignore
        }
        sendProbes();
        if (safeTimeout >= 600) {
          retryTimer = setTimeout(() => {
            if (!settled) {
              sendProbes();
            }
          }, 300);
          retryTimer.unref?.();
        }
        doneTimer = setTimeout(finish, safeTimeout);
        doneTimer.unref?.();
      });

      try {
        sock.bind(0);
      } catch {
        finish();
      }
    });
  }
}
