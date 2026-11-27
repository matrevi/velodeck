import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.velodeck.controller",
  appName: "VeloDeck",
  webDir: "dist",
  server: {
    androidScheme: "https",
    iosScheme: "capacitor",
    // NOTE: cleartext remains enabled strictly for pure-IP / LAN deployments until
    // a TLS-enabled HTTPS domain is configured. Disable once HTTPS is enforced.
    cleartext: true,
  },
  ios: {
    contentInset: "automatic",
    preferredContentMode: "mobile",
    backgroundColor: "#090b10",
  },
  android: {
    // Disallow mixed HTTP content inside HTTPS WebView contexts
    allowMixedContent: false,
    backgroundColor: "#090b10",
  },
};

export default config;
