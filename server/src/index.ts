import fs from "node:fs";
import { loadConfig } from "./config.js";
import { createVeloDeckServer } from "./httpServer.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createVeloDeckServer(config);
  const { host, port } = await server.listen();

  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const hasStatic = fs.existsSync(config.staticDir);
  const hasApk = fs.existsSync(config.apkPath);

  console.log(`[velodeck-server] Listening on http://${host}:${port}`);
  console.log(`[velodeck-server] WebSocket endpoint: ws://${displayHost}:${port}/ws`);
  console.log(`[velodeck-server] Health check:       http://${displayHost}:${port}/health`);
  console.log(`[velodeck-server] Data directory:     ${config.dataDir}`);
  console.log(
    `[velodeck-server] Security policy:    registration=${config.registrationMode}, trustProxy=${config.trustProxy}, legacyToken=${config.enableLegacyTokenAuth}`,
  );
  console.log(
    `[velodeck-server] Android APK:        ${config.apkPath} (${hasApk ? "available" : "not uploaded"})`,
  );
  console.log(
    `[velodeck-server] Static UI dir:      ${config.staticDir} (${hasStatic ? "found" : "not found — API/WS only"})`,
  );
  console.log(
    `[velodeck-server] ICE servers:        ${config.stunUrls.length} STUN, ${config.turnUrls.length} TURN (${
      config.turnSecret ? "ephemeral HMAC" : config.turnUsername ? "static" : "none"
    }, ttl=${config.turnTtlSeconds}s)`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[velodeck-server] Received ${signal}, shutting down gracefully...`);

    const forceTimer = setTimeout(() => {
      console.error("[velodeck-server] Forced shutdown after timeout");
      process.exit(1);
    }, 5_000);
    forceTimer.unref();

    server
      .close()
      .then(() => {
        clearTimeout(forceTimer);
        console.log("[velodeck-server] Shutdown complete");
        process.exit(0);
      })
      .catch((err: unknown) => {
        clearTimeout(forceTimer);
        console.error("[velodeck-server] Error during shutdown:", err);
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[velodeck-server] Fatal startup error:", err);
  process.exit(1);
});
