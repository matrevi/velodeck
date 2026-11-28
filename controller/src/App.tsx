import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";
import {
  normalizeControlCode,
  type DeviceSummary,
  type SessionPermissions,
} from "@velodeck/protocol";
import { ConnectionModal } from "./components/ConnectionModal";
import { DashboardView } from "./components/DashboardView";
import type { DesktopHostHandlers } from "./components/DesktopHostPanel";
import { DesktopTabBar, type OpenSessionTab } from "./components/DesktopTabBar";
import { LaunchView } from "./components/LaunchView";
import { QuickConnectConfirmModal } from "./components/QuickConnectConfirmModal";
import { RemoteViewport } from "./components/RemoteViewport";
import { ServerConfigModal } from "./components/ServerConfigModal";
import {
  deriveRelayWsUrlFromApiBase,
  formatServerHostLabel,
  getDesktopBridge,
  hasDesktopHostBridge,
  loadCachedDesktopServerUrl,
  loadCachedRecentDesktopServers,
  normalizeServerBaseUrl,
  saveCachedDesktopServerUrl,
  saveCachedRecentDesktopServers,
  type DesktopHostConfigPatch,
  type DesktopHostPendingApproval,
  type DesktopHostState,
  type DesktopWindowPreset,
  type DesktopWindowState,
  type LanPeerInfo,
} from "./desktop/bridge";
import {
  changePasswordApi,
  clearAccountSession,
  clearSessionPasswords,
  deleteRecentCodeEntry,
  detectDefaultApiBase,
  detectDefaultRelayWsUrl,
  detectDefaultTransport,
  fetchServerInfo,
  loadAccountSession,
  loadRecentCodes,
  logoutAllSessionsApi,
  sanitizeControlCodeInput,
  saveAccountSession,
  saveRecentCodeEntry,
  unbindDeviceApi,
  updateRecentCodeDeviceName,
  type AuthResponse,
  type RecentControlCode,
  type SavedAccountSession,
  type ServerInfo,
} from "./state/auth";
import {
  assessQuickConnectSecurity,
  deleteProfile,
  importQuickConnectProfile,
  isAllowedDirectUrl,
  loadActiveProfileId,
  loadProfiles,
  parseQuickConnectParams,
  saveActiveProfileId,
  saveProfiles,
  stripQuickConnectParamsFromUrl,
  upsertProfile,
  type ConnectionProfile,
  type QuickConnectParams,
  type QuickConnectSecurityAssessment,
} from "./state/profiles";
import { RemoteClient, type RemoteClientState } from "./transport/RemoteClient";

interface ToastMessage {
  id: number;
  level: "info" | "warn" | "error";
  text: string;
}

interface PendingCodeConnect {
  controlCode: string;
  controlPassword: string;
  rememberPassword: boolean;
  autoStarted: boolean;
  nameSynced: boolean;
}

interface PendingQuickConnect {
  params: QuickConnectParams;
  security: QuickConnectSecurityAssessment;
}

interface TabSessionRuntime {
  client: RemoteClient;
  unsubscribe: () => void;
  sessionRequested: boolean;
  lastNoticeId: number;
}

const MAX_OPEN_TABS = 4;

function deriveLanBroadcastIp(lanIp?: string): string | undefined {
  if (!lanIp) return undefined;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lanIp.trim());
  if (!match) return undefined;
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = Number(match[3]);
  const d = Number(match[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return undefined;
  const isRfc1918 =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
  if (!isRfc1918) return undefined;
  return `${a}.${b}.${c}.255`;
}

function createTabClientId(deviceId: string): string {
  const safeSuffix = deviceId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "dev";
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 14)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `tab-${rand}-${safeSuffix}`.slice(0, 60);
}

export function App() {
  const client = useMemo(() => new RemoteClient(), []);
  const desktopBridge = useMemo(() => getDesktopBridge(), []);
  const defaultApiBase = useMemo(() => detectDefaultApiBase(window.location), []);
  const defaultRelayWsUrl = useMemo(
    () => detectDefaultRelayWsUrl(window.location),
    [],
  );
  const defaultTransport = useMemo(
    () => detectDefaultTransport(window.location),
    [],
  );

  const [desktopServerUrl, setDesktopServerUrl] = useState<string>(() => {
    if (!desktopBridge) return "";
    return (
      loadCachedDesktopServerUrl() ||
      normalizeServerBaseUrl(desktopBridge.defaultServerUrl || "") ||
      ""
    );
  });
  const [recentServers, setRecentServers] = useState<string[]>(() =>
    desktopBridge ? loadCachedRecentDesktopServers() : [],
  );
  const [serverConfigModalOpen, setServerConfigModalOpen] = useState(false);
  const [desktopWindowState, setDesktopWindowState] =
    useState<DesktopWindowState>({
      alwaysOnTop: false,
      preset: "dashboard",
      isFullScreen: false,
    });
  const [hostState, setHostState] = useState<DesktopHostState | null>(null);

  const [clientState, setClientState] = useState<RemoteClientState>(() =>
    client.getState(),
  );

  const [savedAccount, setSavedAccount] = useState<SavedAccountSession | null>(() =>
    loadAccountSession(),
  );
  const [recentCodes, setRecentCodes] = useState<RecentControlCode[]>(() =>
    loadRecentCodes(),
  );
  const [serverInfo, setServerInfo] = useState<ServerInfo>({
    hasAndroidApk: false,
  });

  const [profiles, setProfiles] = useState<ConnectionProfile[]>(() =>
    loadProfiles(),
  );
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() =>
    loadActiveProfileId(),
  );
  const [pendingQuickConnect, setPendingQuickConnect] =
    useState<PendingQuickConnect | null>(null);

  const initialQuickRef = useRef<QuickConnectParams | null | undefined>(undefined);
  if (initialQuickRef.current === undefined) {
    initialQuickRef.current = parseQuickConnectParams(
      window.location.search,
      window.location.hash,
      window.location,
    );
  }

  const [viewMode, setViewMode] = useState<"launch" | "dashboard">(() => {
    const quick = initialQuickRef.current ?? null;
    const hasTrustedQuick =
      quick !== null &&
      !assessQuickConnectSecurity(quick.wsUrl, window.location).requiresConfirmation;
    if (hasTrustedQuick || loadAccountSession()) {
      return "dashboard";
    }
    return "launch";
  });
  const [launchTab, setLaunchTab] = useState<"code" | "account" | "host">("code");
  const [codeOfflineNotice, setCodeOfflineNotice] = useState<{
    controlCode: string;
    deviceName?: string;
  } | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editProfileId, setEditProfileId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [openTabs, setOpenTabs] = useState<OpenSessionTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<"dashboard" | string>("dashboard");
  const [tabStates, setTabStates] = useState<Record<string, RemoteClientState>>({});
  const [tabRecordingMap, setTabRecordingMap] = useState<Record<string, boolean>>({});

  const sessionClientsRef = useRef<Map<string, TabSessionRuntime>>(new Map());
  const openTabsRef = useRef<OpenSessionTab[]>(openTabs);
  openTabsRef.current = openTabs;
  const activeTabIdRef = useRef<"dashboard" | string>(activeTabId);
  activeTabIdRef.current = activeTabId;
  const openTabDeviceIds = useMemo(
    () => new Set(openTabs.map((tab) => tab.deviceId)),
    [openTabs],
  );

  const toastSeqRef = useRef(0);
  const toastTimerRef = useRef<number | null>(null);
  const pendingAutoDeviceIdRef = useRef<string | null>(null);
  const pendingCodeRef = useRef<PendingCodeConnect | null>(null);
  const quickUrlStrippedRef = useRef(false);

  const effectiveDefaultApiBase = desktopBridge
    ? desktopServerUrl
    : defaultApiBase;
  const effectiveDefaultWsUrl = desktopBridge
    ? deriveRelayWsUrlFromApiBase(desktopServerUrl)
    : defaultRelayWsUrl;
  const activeApiBase = savedAccount?.apiBase || effectiveDefaultApiBase;

  const effectiveDefaultWsUrlRef = useRef(effectiveDefaultWsUrl);
  effectiveDefaultWsUrlRef.current = effectiveDefaultWsUrl;

  const showToast = useCallback((level: ToastMessage["level"], text: string) => {
    const id = ++toastSeqRef.current;
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ id, level, text });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast((curr) => (curr?.id === id ? null : curr));
    }, 3200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
      for (const runtime of sessionClientsRef.current.values()) {
        runtime.unsubscribe();
        runtime.client.stopSession("user_exit");
        runtime.client.disconnect();
      }
      sessionClientsRef.current.clear();
    };
  }, []);

  const handleTabRecordingChange = useCallback(
    (deviceId: string, recording: boolean) => {
      setTabRecordingMap((prev) =>
        prev[deviceId] === recording ? prev : { ...prev, [deviceId]: recording },
      );
    },
    [],
  );

  const closeTab = useCallback((deviceId: string) => {
    const runtime = sessionClientsRef.current.get(deviceId);
    if (runtime) {
      runtime.unsubscribe();
      runtime.client.stopSession("user_exit");
      runtime.client.disconnect();
      sessionClientsRef.current.delete(deviceId);
    }

    setTabStates((prev) => {
      if (!(deviceId in prev)) return prev;
      const next = { ...prev };
      delete next[deviceId];
      return next;
    });

    setTabRecordingMap((prev) => {
      if (!(deviceId in prev)) return prev;
      const next = { ...prev };
      delete next[deviceId];
      return next;
    });

    const prevTabs = openTabsRef.current;
    const idx = prevTabs.findIndex((t) => t.deviceId === deviceId);
    if (idx < 0) return;

    const nextTabs = prevTabs.filter((t) => t.deviceId !== deviceId);
    const shouldSwitchActive = activeTabIdRef.current === deviceId;
    const fallbackTab = nextTabs[idx] ?? nextTabs[idx - 1];

    setOpenTabs(nextTabs);
    if (shouldSwitchActive) {
      setActiveTabId(fallbackTab ? fallbackTab.deviceId : "dashboard");
    }
  }, []);

  const closeAllTabs = useCallback(() => {
    for (const runtime of sessionClientsRef.current.values()) {
      runtime.unsubscribe();
      runtime.client.stopSession("user_exit");
      runtime.client.disconnect();
    }
    sessionClientsRef.current.clear();
    setOpenTabs([]);
    setTabStates({});
    setTabRecordingMap({});
    setActiveTabId("dashboard");
  }, []);

  const openDeviceTab = useCallback(
    (device: DeviceSummary) => {
      const existing = sessionClientsRef.current.get(device.deviceId);
      if (existing) {
        setOpenTabs((prev) =>
          prev.map((tab) =>
            tab.deviceId === device.deviceId
              ? {
                  ...tab,
                  label: device.name || device.model || tab.label,
                  deviceType: device.deviceType === "desktop" ? "desktop" : "android",
                }
              : tab,
          ),
        );
        setViewMode("dashboard");
        setActiveTabId(device.deviceId);
        return;
      }

      if (sessionClientsRef.current.size >= MAX_OPEN_TABS) {
        showToast(
          "warn",
          `最多同时保持 ${MAX_OPEN_TABS} 个远控标签页，请先关闭一个标签页`,
        );
        return;
      }

      const primaryState = client.getState();
      const preferredTransport =
        primaryState.profile?.preferredTransport ??
        primaryState.desiredTransport ??
        defaultTransport;
      const qualityPreset =
        primaryState.profile?.qualityPreset ??
        primaryState.qualityPreset ??
        "auto";

      // Only spawn dedicated multi-tab clients for Account or Token/Profile modes
      const isTokenMode =
        primaryState.authType === "token" && Boolean(primaryState.profile);
      const accountToken = savedAccount?.authToken || client.getAuthToken() || "";
      const accountWsUrl =
        savedAccount?.wsUrl ||
        primaryState.wsUrl ||
        effectiveDefaultWsUrlRef.current;
      const isAccountConnectable =
        !isTokenMode && Boolean(accountToken && accountWsUrl);

      if (!isTokenMode && !isAccountConnectable) {
        client.startSession(device.deviceId, {
          preferredTransport,
          qualityPreset,
        });
        return;
      }

      const tabClient = new RemoteClient(createTabClientId(device.deviceId));
      const runtime: TabSessionRuntime = {
        client: tabClient,
        unsubscribe: () => {},
        sessionRequested: false,
        lastNoticeId: 0,
      };

      runtime.unsubscribe = tabClient.subscribe((next) => {
        setTabStates((prev) =>
          prev[device.deviceId] === next
            ? prev
            : { ...prev, [device.deviceId]: next },
        );
        if (next.lastNotice && next.lastNotice.id !== runtime.lastNoticeId) {
          runtime.lastNoticeId = next.lastNotice.id;
          if (activeTabIdRef.current === device.deviceId) {
            showToast(next.lastNotice.level, next.lastNotice.text);
          }
        }
        if (next.socketStatus === "connected" && !runtime.sessionRequested) {
          runtime.sessionRequested = true;
          tabClient.startSession(device.deviceId, {
            preferredTransport: next.desiredTransport ?? defaultTransport,
            qualityPreset: next.qualityPreset ?? "auto",
          });
        }
      });

      sessionClientsRef.current.set(device.deviceId, runtime);

      if (isTokenMode && primaryState.profile) {
        tabClient.connect(primaryState.profile);
      } else {
        tabClient.connectWithAccount({
          wsUrl: accountWsUrl,
          authToken: accountToken,
          user: savedAccount?.user ?? primaryState.user ?? undefined,
          preferredTransport,
          qualityPreset,
        });
      }

      const tabMeta: OpenSessionTab = {
        deviceId: device.deviceId,
        label: device.name || device.model || device.deviceId,
        deviceType: device.deviceType === "desktop" ? "desktop" : "android",
      };
      setOpenTabs((prev) =>
        prev.some((t) => t.deviceId === tabMeta.deviceId)
          ? prev
          : [...prev, tabMeta],
      );
      setViewMode("dashboard");
      setActiveTabId(device.deviceId);
    },
    [client, defaultTransport, savedAccount, showToast],
  );

  const openControlCodeTab = useCallback(
    (input: {
      controlCode: string;
      controlPassword: string;
      peerName?: string;
    }) => {
      const cleanCode = sanitizeControlCodeInput(input.controlCode);
      if (cleanCode.length !== 9 || !input.controlPassword.trim()) return;

      const targetWsUrl = savedAccount?.wsUrl || effectiveDefaultWsUrlRef.current;
      if (desktopBridge && !targetWsUrl) {
        showToast("warn", "请先配置自托管服务器地址");
        setServerConfigModalOpen(true);
        return;
      }

      const tabId = `code:${cleanCode}`;
      const existing = sessionClientsRef.current.get(tabId);
      if (existing) {
        const existingState = existing.client.getState();
        const isTerminal =
          existingState.socketStatus === "error" ||
          existingState.sessionStatus === "error" ||
          existingState.sessionStatus === "ended";
        if (!isTerminal) {
          setViewMode("dashboard");
          setActiveTabId(tabId);
          return;
        }
        closeTab(tabId);
      }

      if (sessionClientsRef.current.size >= MAX_OPEN_TABS) {
        showToast(
          "warn",
          `最多同时保持 ${MAX_OPEN_TABS} 个远控标签页，请先关闭一个标签页`,
        );
        return;
      }

      const primaryState = client.getState();
      const preferredTransport =
        primaryState.profile?.preferredTransport ??
        primaryState.desiredTransport ??
        defaultTransport;
      const qualityPreset =
        primaryState.profile?.qualityPreset ??
        primaryState.qualityPreset ??
        "auto";

      const tabClient = new RemoteClient(createTabClientId(cleanCode));
      const runtime: TabSessionRuntime = {
        client: tabClient,
        unsubscribe: () => {},
        sessionRequested: false,
        lastNoticeId: 0,
      };

      runtime.unsubscribe = tabClient.subscribe((next) => {
        setTabStates((prev) =>
          prev[tabId] === next ? prev : { ...prev, [tabId]: next },
        );
        if (next.lastNotice && next.lastNotice.id !== runtime.lastNoticeId) {
          runtime.lastNoticeId = next.lastNotice.id;
          if (activeTabIdRef.current === tabId) {
            showToast(next.lastNotice.level, next.lastNotice.text);
          }
        }
        if (next.socketStatus === "connected" && !runtime.sessionRequested) {
          const target =
            next.devices.find(
              (d) => normalizeControlCode(d.controlCode ?? "") === cleanCode,
            ) ??
            next.devices[0] ??
            null;
          if (target) {
            const resolvedLabel =
              target.name || target.model || input.peerName || cleanCode;
            const resolvedType: "android" | "desktop" =
              target.deviceType === "desktop" ? "desktop" : "android";
            setOpenTabs((prev) =>
              prev.map((tab) =>
                tab.deviceId === tabId
                  ? { ...tab, label: resolvedLabel, deviceType: resolvedType }
                  : tab,
              ),
            );
            if (target.name) {
              setRecentCodes(updateRecentCodeDeviceName(cleanCode, target.name));
            }
            if (target.online) {
              runtime.sessionRequested = true;
              tabClient.startSession(target.deviceId, {
                preferredTransport: next.desiredTransport ?? defaultTransport,
                qualityPreset: next.qualityPreset ?? "auto",
              });
            }
          }
        }
      });

      sessionClientsRef.current.set(tabId, runtime);

      tabClient.connectWithControlCode({
        wsUrl: targetWsUrl,
        controlCode: cleanCode,
        controlPassword: input.controlPassword,
        preferredTransport,
        qualityPreset,
      });

      const tabMeta: OpenSessionTab = {
        deviceId: tabId,
        label: input.peerName?.trim() || cleanCode,
        deviceType: "desktop",
      };
      setOpenTabs((prev) =>
        prev.some((t) => t.deviceId === tabId) ? prev : [...prev, tabMeta],
      );
      setViewMode("dashboard");
      setActiveTabId(tabId);
    },
    [client, closeTab, defaultTransport, desktopBridge, savedAccount?.wsUrl, showToast],
  );

  // Keep open tab display names synchronized when fleet metadata updates
  useEffect(() => {
    if (openTabs.length === 0 || clientState.devices.length === 0) return;
    setOpenTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        const fresh = clientState.devices.find((d) => d.deviceId === tab.deviceId);
        if (!fresh) return tab;
        const freshLabel = fresh.name || fresh.model || tab.label;
        const freshType: "android" | "desktop" =
          fresh.deviceType === "desktop" ? "desktop" : "android";
        if (freshLabel !== tab.label || freshType !== tab.deviceType) {
          changed = true;
          return { ...tab, label: freshLabel, deviceType: freshType };
        }
        return tab;
      });
      return changed ? next : prev;
    });
  }, [clientState.devices, openTabs.length]);

  // Hydrate desktop server config & window state from Electron preload IPC
  useEffect(() => {
    if (!desktopBridge) return;
    let cancelled = false;

    void desktopBridge
      .getServerConfig()
      .then((cfg) => {
        if (cancelled || !cfg) return;
        const normalized = normalizeServerBaseUrl(cfg.serverUrl || "");
        setDesktopServerUrl(normalized);
        saveCachedDesktopServerUrl(normalized);
        const cleanRecent = (cfg.recentServers ?? [])
          .map((u) => normalizeServerBaseUrl(u))
          .filter(Boolean);
        setRecentServers(cleanRecent);
        saveCachedRecentDesktopServers(cleanRecent);
      })
      .catch(() => {
        // Keep synchronous localStorage cache if IPC is temporarily unavailable
      });

    void desktopBridge
      .getWindowState()
      .then((state) => {
        if (!cancelled && state) {
          setDesktopWindowState(state);
        }
      })
      .catch(() => {});

    const unsubWindow = desktopBridge.onWindowStateChange((state) => {
      if (!cancelled && state) {
        setDesktopWindowState(state);
      }
    });

    let unsubHost = () => {};
    if (typeof desktopBridge.getHostState === "function") {
      void desktopBridge
        .getHostState()
        .then((state) => {
          if (!cancelled && state) {
            setHostState(state);
          }
        })
        .catch(() => {});
    }
    if (typeof desktopBridge.onHostStateChange === "function") {
      unsubHost = desktopBridge.onHostStateChange((state) => {
        if (!cancelled && state) {
          setHostState(state);
        }
      });
    }

    return () => {
      cancelled = true;
      unsubWindow();
      unsubHost();
    };
  }, [desktopBridge]);

  // Desktop shortcut: Cmd/Ctrl + , opens Server Settings modal
  useEffect(() => {
    if (!desktopBridge) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        setServerConfigModalOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [desktopBridge]);

  function applyQuickConnectImport(quick: QuickConnectParams) {
    closeAllTabs();
    const currentProfiles = loadProfiles();
    const { profiles: nextProfiles, profile } = importQuickConnectProfile(
      currentProfiles,
      quick,
    );
    saveProfiles(nextProfiles);
    saveActiveProfileId(profile.id);
    setProfiles(nextProfiles);
    setActiveProfileId(profile.id);

    if (quick.deviceId) {
      pendingAutoDeviceIdRef.current = quick.deviceId;
    }

    setViewMode("dashboard");
    client.connect(profile);
    showToast("info", `已导入连接「${profile.label}」`);
  }

  // Subscribe to RemoteClient state updates
  useEffect(() => {
    const unsub = client.subscribe((next) => {
      setClientState(next);
    });
    return () => {
      unsub();
      client.disconnect();
    };
  }, [client]);

  // Surface client notices as floating toasts
  useEffect(() => {
    const notice = clientState.lastNotice;
    if (!notice) return;
    showToast(notice.level, notice.text);
  }, [clientState.lastNotice]);

  // Fetch server info (/api/info) for APK status, SHA-256 fingerprint, and registration policy
  useEffect(() => {
    if (desktopBridge && !activeApiBase) {
      setServerInfo({ hasAndroidApk: false });
      return;
    }
    let cancelled = false;
    void fetchServerInfo(activeApiBase).then((info) => {
      if (!cancelled) {
        setServerInfo(info);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeApiBase, desktopBridge]);

  // Re-fetch /api/info whenever WebSocket (re)connects so long-lived open tabs
  // automatically pick up updated server version & APK SHA-256 after a server upgrade.
  useEffect(() => {
    if (clientState.socketStatus !== "connected") return;
    if (desktopBridge && !activeApiBase) return;
    let cancelled = false;
    void fetchServerInfo(activeApiBase).then((info) => {
      if (!cancelled) {
        setServerInfo(info);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeApiBase, clientState.socketStatus, desktopBridge]);

  // Boot: 1) QR/URL quick-connect params (with security check) -> 2) saved account session -> 3) LaunchView
  // StrictMode-safe: uses initialQuickRef parsed once on mount and reconnects whenever client is still idle.
  useEffect(() => {
    const quick = initialQuickRef.current ?? null;

    if (quick) {
      // Always strip sensitive parameters from URL & history immediately (once)
      if (!quickUrlStrippedRef.current) {
        quickUrlStrippedRef.current = true;
        stripQuickConnectParamsFromUrl(window);
      }

      const security = assessQuickConnectSecurity(quick.wsUrl, window.location);
      if (security.requiresConfirmation) {
        // Require explicit confirmation before saving or connecting to external/cleartext hosts
        setPendingQuickConnect({ params: quick, security });
      } else {
        if (client.getState().socketStatus === "idle") {
          applyQuickConnectImport(quick);
        }
        return;
      }
    }

    const storedAccount = loadAccountSession();
    if (storedAccount) {
      setSavedAccount(storedAccount);
      setViewMode("dashboard");
      const targetWsUrl = storedAccount.wsUrl || effectiveDefaultWsUrlRef.current;
      if (client.getState().socketStatus === "idle" && targetWsUrl) {
        client.connectWithAccount({
          wsUrl: targetWsUrl,
          authToken: storedAccount.authToken,
          user: storedAccount.user,
          preferredTransport: defaultTransport,
          qualityPreset: "auto",
        });
      }
      return;
    }

    setViewMode("launch");
  }, [client, defaultTransport]);

  // Auto-open device viewport if QR deep-link requested a specific deviceId
  useEffect(() => {
    const wantedId = pendingAutoDeviceIdRef.current;
    if (!wantedId || clientState.socketStatus !== "connected") return;
    const target = clientState.devices.find(
      (d) => d.deviceId === wantedId && d.online,
    );
    if (target) {
      pendingAutoDeviceIdRef.current = null;
      openDeviceTab(target);
    }
  }, [openDeviceTab, clientState.socketStatus, clientState.devices]);

  // Control-Code Auto-Enter: sync device name + auto-start session when online (or show offline notice)
  useEffect(() => {
    const pending = pendingCodeRef.current;
    if (!pending) return;
    if (clientState.authType !== "code") return;

    if (clientState.socketStatus === "error") {
      setCodeOfflineNotice(null);
      return;
    }

    if (clientState.socketStatus !== "connected") {
      return;
    }

    const target =
      clientState.devices.find(
        (d) => normalizeControlCode(d.controlCode ?? "") === pending.controlCode,
      ) ??
      clientState.devices[0] ??
      null;

    if (target?.name && !pending.nameSynced) {
      pending.nameSynced = true;
      const updated = updateRecentCodeDeviceName(pending.controlCode, target.name);
      setRecentCodes(updated);
    }

    if (target?.online) {
      setCodeOfflineNotice(null);
      if (!pending.autoStarted && !clientState.activeDeviceId) {
        pending.autoStarted = true;
        client.startSession(target.deviceId, {
          preferredTransport: defaultTransport,
          qualityPreset: "auto",
        });
      }
    } else if (!clientState.activeDeviceId) {
      setCodeOfflineNotice({
        controlCode: pending.controlCode,
        deviceName: target?.name || undefined,
      });
    }
  }, [
    client,
    clientState.authType,
    clientState.socketStatus,
    clientState.devices,
    clientState.activeDeviceId,
    defaultTransport,
  ]);

  function handleConfirmQuickConnect() {
    if (!pendingQuickConnect) return;
    const { params } = pendingQuickConnect;
    setPendingQuickConnect(null);
    applyQuickConnectImport(params);
  }

  function handleCancelQuickConnect() {
    setPendingQuickConnect(null);
    showToast("info", "已取消外部链接导入");
  }

  const handleConnectWithCode = useCallback(
    (input: {
      controlCode: string;
      controlPassword: string;
      rememberPassword: boolean;
    }) => {
      const cleanCode = sanitizeControlCodeInput(input.controlCode);
      if (cleanCode.length !== 9 || !input.controlPassword.trim()) return;

      const targetWsUrl = savedAccount?.wsUrl || effectiveDefaultWsUrl;
      if (desktopBridge && !targetWsUrl) {
        showToast("warn", "请先配置自托管服务器地址");
        setServerConfigModalOpen(true);
        return;
      }

      const updatedRecent = saveRecentCodeEntry({
        controlCode: cleanCode,
        controlPassword: input.controlPassword,
        rememberPassword: input.rememberPassword,
      });
      setRecentCodes(updatedRecent);
      setCodeOfflineNotice(null);
      closeAllTabs();

      pendingCodeRef.current = {
        controlCode: cleanCode,
        controlPassword: input.controlPassword,
        rememberPassword: input.rememberPassword,
        autoStarted: false,
        nameSynced: false,
      };

      client.connectWithControlCode({
        wsUrl: targetWsUrl,
        controlCode: cleanCode,
        controlPassword: input.controlPassword,
        preferredTransport: defaultTransport,
        qualityPreset: "auto",
      });
    },
    [
      client,
      closeAllTabs,
      defaultTransport,
      desktopBridge,
      effectiveDefaultWsUrl,
      savedAccount?.wsUrl,
      showToast,
    ],
  );

  function handleCancelCodeConnect() {
    pendingCodeRef.current = null;
    setCodeOfflineNotice(null);
    if (clientState.authType === "code") {
      client.disconnect();
    }
  }

  function handleRetryCodeConnect() {
    const pending = pendingCodeRef.current;
    if (!pending) return;
    handleConnectWithCode({
      controlCode: pending.controlCode,
      controlPassword: pending.controlPassword,
      rememberPassword: pending.rememberPassword,
    });
  }

  function handleDeleteRecentCode(controlCode: string) {
    const next = deleteRecentCodeEntry(controlCode);
    setRecentCodes(next);
  }

  function handleAccountAuthed(auth: AuthResponse, isRegister: boolean) {
    closeAllTabs();
    pendingCodeRef.current = null;
    setCodeOfflineNotice(null);

    const session: SavedAccountSession = {
      authToken: auth.token,
      user: auth.user,
      wsUrl: effectiveDefaultWsUrl,
      apiBase: effectiveDefaultApiBase,
    };
    saveAccountSession(session);
    setSavedAccount(session);
    setViewMode("dashboard");

    client.connectWithAccount({
      wsUrl: session.wsUrl,
      authToken: session.authToken,
      user: session.user,
      preferredTransport: defaultTransport,
      qualityPreset: "auto",
    });

    if (isRegister) {
      // Refresh serverInfo since first-user-then-invite transitions to invite-only after initial signup
      void fetchServerInfo(session.apiBase).then((info) => setServerInfo(info));
    }

    const displayName = auth.user.displayName || auth.user.username;
    showToast(
      "info",
      isRegister ? `注册成功，欢迎你 ${displayName}` : `欢迎回来，${displayName}`,
    );
  }

  function handleLogoutAccount() {
    closeAllTabs();
    pendingCodeRef.current = null;
    setCodeOfflineNotice(null);
    clearAccountSession();
    clearSessionPasswords();
    setSavedAccount(null);
    setRecentCodes(loadRecentCodes());
    client.disconnect();
    setLaunchTab("code");
    setViewMode("launch");
    showToast("info", "已退出当前账号");
  }

  function handleReloginAccount() {
    closeAllTabs();
    pendingCodeRef.current = null;
    setCodeOfflineNotice(null);
    clearAccountSession();
    setSavedAccount(null);
    client.disconnect();
    setLaunchTab("account");
    setViewMode("launch");
  }

  async function handleChangePassword(input: {
    currentPassword: string;
    newPassword: string;
  }) {
    if (!savedAccount) {
      throw new Error("当前未登录账号");
    }
    const result = await changePasswordApi(
      savedAccount.apiBase,
      savedAccount.authToken,
      input,
    );
    const updatedSession: SavedAccountSession = {
      ...savedAccount,
      authToken: result.token,
    };
    saveAccountSession(updatedSession);
    setSavedAccount(updatedSession);

    // Reconnect active WebSocket with rotated JWT so future reconnects stay valid
    client.connectWithAccount({
      wsUrl: updatedSession.wsUrl || effectiveDefaultWsUrl,
      authToken: updatedSession.authToken,
      user: updatedSession.user,
      preferredTransport: clientState.desiredTransport ?? defaultTransport,
      qualityPreset: clientState.qualityPreset ?? "auto",
    });
    for (const runtime of sessionClientsRef.current.values()) {
      const st = runtime.client.getState();
      if (st.authType === "account") {
        runtime.sessionRequested = false;
        runtime.client.connectWithAccount({
          wsUrl: updatedSession.wsUrl || effectiveDefaultWsUrl,
          authToken: updatedSession.authToken,
          user: updatedSession.user,
          preferredTransport: st.desiredTransport ?? defaultTransport,
          qualityPreset: st.qualityPreset ?? "auto",
        });
      }
    }
    showToast("info", "密码已修改，其他设备登录态已失效");
  }

  async function handleLogoutAllSessions() {
    if (!savedAccount) {
      throw new Error("当前未登录账号");
    }
    await logoutAllSessionsApi(savedAccount.apiBase, savedAccount.authToken);
    closeAllTabs();
    pendingCodeRef.current = null;
    setCodeOfflineNotice(null);
    clearAccountSession();
    clearSessionPasswords();
    setSavedAccount(null);
    setRecentCodes(loadRecentCodes());
    client.disconnect();
    setLaunchTab("account");
    setViewMode("launch");
    showToast("info", "已踢出全部已登录设备，请重新登录");
  }

  function handleReturnToAccountDashboard() {
    if (!savedAccount) return;
    pendingCodeRef.current = null;
    setCodeOfflineNotice(null);
    setViewMode("dashboard");

    if (
      clientState.authType !== "account" ||
      clientState.socketStatus === "idle" ||
      clientState.socketStatus === "error"
    ) {
      client.connectWithAccount({
        wsUrl: savedAccount.wsUrl || effectiveDefaultWsUrl,
        authToken: savedAccount.authToken,
        user: savedAccount.user,
        preferredTransport: defaultTransport,
        qualityPreset: "auto",
      });
    }
  }

  function handleOpenControlCodeFromDashboard() {
    setCodeOfflineNotice(null);
    setLaunchTab("code");
    setViewMode("launch");
  }

  async function handleUnbindDevice(device: DeviceSummary) {
    if (!savedAccount) return;
    try {
      await unbindDeviceApi(
        savedAccount.apiBase,
        savedAccount.authToken,
        device.deviceId,
      );
      closeTab(device.deviceId);
      client.removeDevice(device.deviceId);
      showToast("info", `已解绑设备「${device.name || device.model}」`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "解绑设备失败";
      showToast("error", msg);
    }
  }

  function handleSelectProfile(profile: ConnectionProfile) {
    closeAllTabs();
    pendingCodeRef.current = null;
    setCodeOfflineNotice(null);
    setActiveProfileId(profile.id);
    saveActiveProfileId(profile.id);
    setViewMode("dashboard");
    client.connect(profile);
    showToast("info", `正在切换至「${profile.label}」`);
  }

  function handleSaveProfile(
    input: Omit<ConnectionProfile, "id"> & { id?: string },
  ) {
    closeAllTabs();
    pendingCodeRef.current = null;
    setCodeOfflineNotice(null);
    const { profiles: nextProfiles, saved } = upsertProfile(profiles, input);
    setProfiles(nextProfiles);
    saveProfiles(nextProfiles);
    setActiveProfileId(saved.id);
    saveActiveProfileId(saved.id);
    setViewMode("dashboard");
    client.connect(saved);
    showToast("info", `已保存并连接「${saved.label}」`);
  }

  function handleDeleteProfile(id: string) {
    const nextProfiles = deleteProfile(profiles, id);
    setProfiles(nextProfiles);
    saveProfiles(nextProfiles);

    if (activeProfileId === id) {
      const fallback = nextProfiles[0] ?? null;
      setActiveProfileId(fallback?.id ?? null);
      saveActiveProfileId(fallback?.id ?? null);
      if (fallback && clientState.authType === "token") {
        closeAllTabs();
        client.connect(fallback);
      } else if (clientState.authType === "token") {
        closeAllTabs();
        client.disconnect();
        if (!savedAccount) {
          setViewMode("launch");
        }
      }
    }
  }

  function handleControlDevice(device: DeviceSummary) {
    openDeviceTab(device);
  }

  function handleWakeDevice(device: DeviceSummary) {
    const res = client.sendCommand({ action: "wake" }, device.deviceId);
    if (res.sent) {
      showToast("info", `已向「${device.name}」发送亮屏唤醒指令`);
    } else {
      showToast("error", "当前未连接，无法发送唤醒指令");
    }
  }

  const handleSendWolRaw = useCallback(
    async (
      macAddress: string,
      _peerName?: string,
      lanIp?: string,
      excludeDeviceId?: string,
    ): Promise<boolean> => {
      const mac = macAddress.trim();
      if (!mac) {
        showToast("warn", "缺少目标设备的 MAC 地址，无法发送 WOL");
        return false;
      }

      const broadcastIp = deriveLanBroadcastIp(lanIp);

      if (desktopBridge && typeof desktopBridge.sendWolPacket === "function") {
        try {
          const res = await desktopBridge.sendWolPacket(mac, broadcastIp);
          if (res?.ok) {
            showToast("info", `已发送局域网 WOL 唤醒魔术包 (${mac})`);
            return true;
          }
        } catch {
          // Fall through to relay peers
        }
      }

      const relayPeers = client
        .getState()
        .devices.filter(
          (d) =>
            d.online &&
            d.capabilities.wolRelay === true &&
            d.deviceId !== excludeDeviceId &&
            d.deviceId !== hostState?.deviceId,
        );
      for (const peer of relayPeers) {
        const ack = await client.sendWolRelayWithAck(
          peer.deviceId,
          mac,
          broadcastIp,
        );
        if (ack.ok) {
          showToast(
            "info",
            `已通过在线设备「${peer.name || peer.model}」发送 WOL 唤醒魔术包 (${mac})`,
          );
          return true;
        }
      }

      showToast(
        "warn",
        "无法发送 WOL 魔术包：请在同局域网桌面端操作，或确保账号下有另一台在线电脑可作为中继",
      );
      return false;
    },
    [client, desktopBridge, hostState?.deviceId, showToast],
  );

  const handleSendWolDevice = useCallback(
    async (device: DeviceSummary): Promise<boolean> => {
      const mac = device.macAddresses?.[0];
      if (!mac) {
        showToast("warn", `「${device.name || device.model}」暂无可用的 MAC 地址`);
        return false;
      }
      return handleSendWolRaw(
        mac,
        device.name || device.model,
        device.lanIp,
        device.deviceId,
      );
    },
    [handleSendWolRaw, showToast],
  );

  const handleDiscoverLanPeers = useCallback(async (): Promise<LanPeerInfo[]> => {
    if (!desktopBridge || typeof desktopBridge.discoverLanPeers !== "function") {
      return [];
    }
    return desktopBridge.discoverLanPeers();
  }, [desktopBridge]);

  const handleConnectLanPeerCode = useCallback(
    (input: { controlCode: string; controlPassword: string; peerName?: string }) => {
      const cleanCode = sanitizeControlCodeInput(input.controlCode);
      if (cleanCode.length !== 9 || !input.controlPassword.trim()) return;

      const updatedRecent = saveRecentCodeEntry({
        controlCode: cleanCode,
        controlPassword: input.controlPassword,
        rememberPassword: false,
      });
      setRecentCodes(
        input.peerName
          ? updateRecentCodeDeviceName(cleanCode, input.peerName)
          : updatedRecent,
      );

      const primaryAuthType = client.getState().authType;
      const keepPrimaryDashboardAlive =
        savedAccount !== null ||
        primaryAuthType === "account" ||
        primaryAuthType === "token";

      if (keepPrimaryDashboardAlive) {
        openControlCodeTab({
          controlCode: cleanCode,
          controlPassword: input.controlPassword,
          peerName: input.peerName,
        });
        return;
      }

      handleConnectWithCode({
        controlCode: cleanCode,
        controlPassword: input.controlPassword,
        rememberPassword: false,
      });
    },
    [client, handleConnectWithCode, openControlCodeTab, savedAccount],
  );

  function handleSwitchToDirectUrl(device: DeviceSummary) {
    if (!device.directUrl) return;
    // Strictly validate private/LAN IP before forwarding accessToken to a device-advertised directUrl
    if (!isAllowedDirectUrl(device.directUrl)) {
      showToast("error", "已拦截非局域网/私有网段的直连地址，防止凭据泄露");
      return;
    }

    closeAllTabs();
    const token = clientState.profile?.accessToken ?? "";
    const { profiles: nextProfiles, profile } = importQuickConnectProfile(
      profiles,
      {
        wsUrl: device.directUrl,
        accessToken: token,
        mode: "direct",
        label: `${device.name} 直连`,
        preferredTransport: clientState.desiredTransport,
        qualityPreset: clientState.qualityPreset,
      },
    );
    setProfiles(nextProfiles);
    saveProfiles(nextProfiles);
    setActiveProfileId(profile.id);
    saveActiveProfileId(profile.id);
    setViewMode("dashboard");
    client.connect(profile);
    showToast("info", `已切换至「${profile.label}」直连模式`);
  }

  function handleDashboardReconnect() {
    if (client.getState().socketStatus !== "idle") {
      client.reconnectNow();
      return;
    }
    if (savedAccount) {
      const targetWsUrl = savedAccount.wsUrl || effectiveDefaultWsUrl;
      if (!targetWsUrl) {
        if (desktopBridge) {
          showToast("warn", "请先配置自托管服务器地址");
          setServerConfigModalOpen(true);
        }
        return;
      }
      client.connectWithAccount({
        wsUrl: targetWsUrl,
        authToken: savedAccount.authToken,
        user: savedAccount.user,
        preferredTransport: clientState.desiredTransport ?? defaultTransport,
        qualityPreset: clientState.qualityPreset ?? "auto",
      });
      return;
    }
    const activeProfile =
      profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? null;
    if (activeProfile) {
      client.connect(activeProfile);
    }
  }

  const reconnectHandlerRef = useRef<() => void>(() => {});
  reconnectHandlerRef.current = handleDashboardReconnect;

  useEffect(() => {
    if (!desktopBridge) return;
    return desktopBridge.onCommand((command) => {
      if (command === "open-server-settings") {
        setServerConfigModalOpen(true);
      } else if (command === "reconnect") {
        const currentTabId = activeTabIdRef.current;
        const tabRuntime =
          currentTabId !== "dashboard"
            ? sessionClientsRef.current.get(currentTabId)
            : undefined;
        if (tabRuntime) {
          tabRuntime.client.reconnectNow();
        } else {
          reconnectHandlerRef.current();
        }
      }
    });
  }, [desktopBridge]);

  async function handleSaveDesktopServer(rawUrl: string) {
    const normalized = normalizeServerBaseUrl(rawUrl);
    if (!normalized) return;

    const previousServerUrl = normalizeServerBaseUrl(desktopServerUrl);
    const serverChanged = normalized !== previousServerUrl;

    saveCachedDesktopServerUrl(normalized);
    setDesktopServerUrl(normalized);

    if (desktopBridge) {
      try {
        const updated = await desktopBridge.setServerConfig(normalized);
        const cleanRecent = (updated.recentServers ?? [])
          .map((u) => normalizeServerBaseUrl(u))
          .filter(Boolean);
        setRecentServers(cleanRecent);
        saveCachedRecentDesktopServers(cleanRecent);
        if (typeof desktopBridge.getHostState === "function") {
          void desktopBridge
            .getHostState()
            .then((nextHost) => {
              if (nextHost) setHostState(nextHost);
            })
            .catch(() => {});
        }
      } catch {
        const fallbackRecent = [
          normalized,
          ...recentServers.filter((u) => u !== normalized),
        ].slice(0, 10);
        setRecentServers(fallbackRecent);
        saveCachedRecentDesktopServers(fallbackRecent);
      }
    }

    const hostLabel = formatServerHostLabel(normalized) || normalized;
    const accountApiBase = savedAccount
      ? normalizeServerBaseUrl(savedAccount.apiBase)
      : "";
    const hasStaleAccount =
      savedAccount !== null && accountApiBase !== normalized;

    if (serverChanged && hasStaleAccount) {
      closeAllTabs();
      pendingCodeRef.current = null;
      setCodeOfflineNotice(null);
      clearAccountSession();
      clearSessionPasswords();
      setSavedAccount(null);
      setRecentCodes(loadRecentCodes());
      client.disconnect();
      setViewMode("launch");
      showToast("info", `已切换至服务器 ${hostLabel}，请登录账号或输入控制码`);
    } else if (serverChanged) {
      closeAllTabs();
      if (client.getState().authType === "code") {
        pendingCodeRef.current = null;
        setCodeOfflineNotice(null);
        client.disconnect();
      }
      showToast("info", `已切换至服务器 ${hostLabel}`);
    } else {
      showToast("info", `已保存服务器 ${hostLabel}`);
    }

    void fetchServerInfo(normalized).then((info) => {
      setServerInfo(info);
    });
  }

  async function handleRemoveRecentServer(serverUrl: string) {
    const normalized = normalizeServerBaseUrl(serverUrl) || serverUrl;
    if (desktopBridge) {
      try {
        const updated = await desktopBridge.removeRecentServer(normalized);
        const cleanRecent = (updated.recentServers ?? [])
          .map((u) => normalizeServerBaseUrl(u))
          .filter(Boolean);
        setRecentServers(cleanRecent);
        saveCachedRecentDesktopServers(cleanRecent);
        return;
      } catch {
        // Fall back to local removal
      }
    }
    const next = recentServers.filter((u) => u !== normalized);
    setRecentServers(next);
    saveCachedRecentDesktopServers(next);
  }

  const handleToggleAlwaysOnTop = useCallback(async () => {
    if (!desktopBridge) return;
    try {
      const next = await desktopBridge.setAlwaysOnTop(
        !desktopWindowState.alwaysOnTop,
      );
      setDesktopWindowState(next);
      showToast(
        "info",
        next.alwaysOnTop ? "已开启窗口置顶浮窗" : "已取消窗口置顶",
      );
    } catch {
      showToast("error", "切换窗口置顶失败");
    }
  }, [desktopBridge, desktopWindowState.alwaysOnTop, showToast]);

  const handleSetWindowPreset = useCallback(
    async (preset: DesktopWindowPreset) => {
      if (!desktopBridge) return;
      try {
        const next = await desktopBridge.setWindowPreset(preset);
        setDesktopWindowState(next);
      } catch {
        showToast("error", "切换窗口比例失败");
      }
    },
    [desktopBridge, showToast],
  );

  const handleOpenNewWindow = useCallback(async () => {
    if (!desktopBridge) return;
    try {
      await desktopBridge.openNewWindow();
    } catch {
      showToast("error", "打开新窗口失败");
    }
  }, [desktopBridge, showToast]);

  const handleStartHost = useCallback(async () => {
    if (!desktopBridge || typeof desktopBridge.startHost !== "function") return;
    if (!desktopServerUrl) {
      showToast("warn", "请先配置自托管服务器地址");
      setServerConfigModalOpen(true);
      return;
    }
    try {
      const next = await desktopBridge.startHost(savedAccount?.authToken ?? null);
      if (next) {
        setHostState(next);
        if (next.lastError) {
          showToast("error", next.lastError);
        } else {
          showToast("info", "已开启本机被控服务");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "开启本机被控失败";
      showToast("error", msg);
    }
  }, [desktopBridge, desktopServerUrl, savedAccount?.authToken, showToast]);

  const handleStopHost = useCallback(async () => {
    if (!desktopBridge || typeof desktopBridge.stopHost !== "function") return;
    try {
      const next = await desktopBridge.stopHost();
      if (next) setHostState(next);
      showToast("info", "已停止本机被控服务");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "停止本机被控失败";
      showToast("error", msg);
    }
  }, [desktopBridge, showToast]);

  const handleUpdateHostConfig = useCallback(
    async (patch: DesktopHostConfigPatch): Promise<boolean> => {
      if (!desktopBridge || typeof desktopBridge.updateHostConfig !== "function") {
        return false;
      }
      try {
        const next = await desktopBridge.updateHostConfig(patch);
        if (next) setHostState(next);
        showToast("info", "本机被控配置已更新");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "保存本机配置失败";
        showToast("error", msg);
        return false;
      }
    },
    [desktopBridge, showToast],
  );

  const handleRegenerateHostPassword = useCallback(async () => {
    if (
      !desktopBridge ||
      typeof desktopBridge.regenerateHostPassword !== "function"
    ) {
      return;
    }
    try {
      const next = await desktopBridge.regenerateHostPassword();
      if (next) setHostState(next);
      showToast("info", "已重置无人值守控制密码");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "重置控制密码失败";
      showToast("error", msg);
    }
  }, [desktopBridge, showToast]);

  const handleBindHostAccount = useCallback(async () => {
    if (!desktopBridge || typeof desktopBridge.bindHostAccount !== "function") {
      return;
    }
    if (!savedAccount?.authToken) {
      showToast("warn", "请先登录账号后再绑定本机");
      return;
    }
    try {
      const next = await desktopBridge.bindHostAccount(savedAccount.authToken);
      if (next) setHostState(next);
      showToast("info", `本机已绑定到账号 @${savedAccount.user.username}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "绑定账号失败";
      showToast("error", msg);
    }
  }, [desktopBridge, savedAccount, showToast]);

  const handleUnbindHostAccount = useCallback(async () => {
    if (!desktopBridge || typeof desktopBridge.unbindHostAccount !== "function") {
      return;
    }
    try {
      const next = await desktopBridge.unbindHostAccount();
      if (next) setHostState(next);
      showToast("info", "已解除本机账号绑定");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "解除账号绑定失败";
      showToast("error", msg);
    }
  }, [desktopBridge, showToast]);

  const handleSelectHostDisplay = useCallback(
    async (displayId: string) => {
      if (!desktopBridge || typeof desktopBridge.selectHostDisplay !== "function") {
        return;
      }
      try {
        const next = await desktopBridge.selectHostDisplay(displayId);
        if (next) setHostState(next);
        showToast("info", "已切换本机共享显示器");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "切换显示器失败";
        showToast("error", msg);
      }
    },
    [desktopBridge, showToast],
  );

  const handleDisconnectHostSession = useCallback(async () => {
    if (
      !desktopBridge ||
      typeof desktopBridge.disconnectHostSession !== "function"
    ) {
      return;
    }
    try {
      const next = await desktopBridge.disconnectHostSession();
      if (next) setHostState(next);
      showToast("info", "已断开当前远程控制会话");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "断开远程会话失败";
      showToast("error", msg);
    }
  }, [desktopBridge, showToast]);

  const handleRefreshHostPermissions = useCallback(async () => {
    if (
      !desktopBridge ||
      typeof desktopBridge.refreshHostPermissions !== "function"
    ) {
      return;
    }
    try {
      const perms = await desktopBridge.refreshHostPermissions();
      if (perms) {
        setHostState((prev) => (prev ? { ...prev, permissions: perms } : prev));
      }
      showToast("info", "已刷新系统权限状态");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "刷新权限状态失败";
      showToast("error", msg);
    }
  }, [desktopBridge, showToast]);

  const handleOpenPermissionSettings = useCallback(
    async (kind: "accessibility" | "screen") => {
      if (
        !desktopBridge ||
        typeof desktopBridge.openPermissionSettings !== "function"
      ) {
        return;
      }
      try {
        await desktopBridge.openPermissionSettings(kind);
        showToast(
          "info",
          kind === "screen"
            ? "已打开系统「屏幕录制」权限设置"
            : "已打开系统「辅助功能」权限设置",
        );
      } catch {
        showToast("error", "无法打开系统权限设置，请手动前往系统设置授权");
      }
    },
    [desktopBridge, showToast],
  );

  const handleSetHostPrivacyScreen = useCallback(
    async (enabled: boolean) => {
      if (
        !desktopBridge ||
        typeof desktopBridge.setHostPrivacyScreen !== "function"
      ) {
        return;
      }
      try {
        const next = await desktopBridge.setHostPrivacyScreen(enabled);
        if (next) setHostState(next);
        showToast(
          "info",
          enabled
            ? "已开启本机隐私防窥黑屏（按 Cmd/Ctrl+Opt/Alt+Esc 可随时解除）"
            : "已解除本机隐私防窥黑屏",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "切换本机隐私黑屏失败";
        showToast("error", msg);
      }
    },
    [desktopBridge, showToast],
  );

  const handleSetHostBlockInput = useCallback(
    async (enabled: boolean) => {
      if (
        !desktopBridge ||
        typeof desktopBridge.setHostBlockInput !== "function"
      ) {
        return;
      }
      try {
        const next = await desktopBridge.setHostBlockInput(enabled);
        if (next) setHostState(next);
        showToast(
          "info",
          enabled ? "已锁定本机物理键鼠输入" : "已解除本机物理键鼠锁定",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "切换本地键鼠锁定失败";
        showToast("error", msg);
      }
    },
    [desktopBridge, showToast],
  );

  const handleApproveHostSession = useCallback(
    async (sessionId: string, permissions: SessionPermissions) => {
      if (
        !desktopBridge ||
        typeof desktopBridge.approveHostSession !== "function"
      ) {
        return;
      }
      try {
        const next = await desktopBridge.approveHostSession(sessionId, permissions);
        if (next) setHostState(next);
        showToast("info", "已允许远程控制接入");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "批准远程接入失败";
        showToast("error", msg);
      }
    },
    [desktopBridge, showToast],
  );

  const handleRejectHostSession = useCallback(
    async (sessionId: string) => {
      if (
        !desktopBridge ||
        typeof desktopBridge.rejectHostSession !== "function"
      ) {
        return;
      }
      try {
        const next = await desktopBridge.rejectHostSession(sessionId);
        if (next) setHostState(next);
        showToast("info", "已拒绝远程接入请求");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "拒绝远程接入失败";
        showToast("error", msg);
      }
    },
    [desktopBridge, showToast],
  );

  const handleSendHostChatMessage = useCallback(
    async (text: string): Promise<boolean> => {
      if (
        !desktopBridge ||
        typeof desktopBridge.sendHostChatMessage !== "function"
      ) {
        return false;
      }
      try {
        const res = await desktopBridge.sendHostChatMessage(text);
        if (res && typeof res === "object") {
          const legacy = res as unknown as { ok?: boolean; error?: string };
          if ("ok" in legacy && legacy.ok === false) {
            showToast("error", legacy.error || "发送会话消息失败");
            return false;
          }
          if ("enabled" in res && "status" in res) {
            setHostState(res);
          }
          return true;
        }
        return false;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "发送会话消息失败";
        showToast("error", msg);
        return false;
      }
    },
    [desktopBridge, showToast],
  );

  const desktopHostHandlers = useMemo<DesktopHostHandlers | undefined>(() => {
    if (!desktopBridge || !hasDesktopHostBridge(desktopBridge)) {
      return undefined;
    }
    return {
      onStartHost: handleStartHost,
      onStopHost: handleStopHost,
      onUpdateConfig: handleUpdateHostConfig,
      onRegeneratePassword: handleRegenerateHostPassword,
      onBindAccount: handleBindHostAccount,
      onUnbindAccount: handleUnbindHostAccount,
      onSelectDisplay: handleSelectHostDisplay,
      onDisconnectSession: handleDisconnectHostSession,
      onRefreshPermissions: handleRefreshHostPermissions,
      onOpenPermissionSettings: handleOpenPermissionSettings,
      onSetPrivacyScreen:
        typeof desktopBridge.setHostPrivacyScreen === "function"
          ? handleSetHostPrivacyScreen
          : undefined,
      onSetBlockInput:
        typeof desktopBridge.setHostBlockInput === "function"
          ? handleSetHostBlockInput
          : undefined,
      onApproveSession:
        typeof desktopBridge.approveHostSession === "function"
          ? handleApproveHostSession
          : undefined,
      onRejectSession:
        typeof desktopBridge.rejectHostSession === "function"
          ? handleRejectHostSession
          : undefined,
      onSendChatMessage:
        typeof desktopBridge.sendHostChatMessage === "function"
          ? handleSendHostChatMessage
          : undefined,
    };
  }, [
    desktopBridge,
    handleStartHost,
    handleStopHost,
    handleUpdateHostConfig,
    handleRegenerateHostPassword,
    handleBindHostAccount,
    handleUnbindHostAccount,
    handleSelectHostDisplay,
    handleDisconnectHostSession,
    handleRefreshHostPermissions,
    handleOpenPermissionSettings,
    handleSetHostPrivacyScreen,
    handleSetHostBlockInput,
    handleApproveHostSession,
    handleRejectHostSession,
    handleSendHostChatMessage,
  ]);

  function handleExitViewport() {
    if (clientState.authType === "code") {
      pendingCodeRef.current = null;
      setCodeOfflineNotice(null);
      client.disconnect();
      setLaunchTab("code");
      setViewMode("launch");
    } else {
      client.stopSession("user_exit");
    }
  }

  const activeDevice =
    clientState.devices.find((d) => d.deviceId === clientState.activeDeviceId) ??
    null;

  const hasOpenTabs = openTabs.length > 0;
  const isInSingleRemoteViewport =
    !hasOpenTabs && Boolean(clientState.activeDeviceId);

  const hostPendingApproval = Boolean(hostState?.pendingApproval);

  const renderDashboardOrLaunch = (hasTabBar: boolean) =>
    viewMode === "launch" ? (
      <LaunchView
        apiBase={activeApiBase}
        serverInfo={serverInfo}
        initialTab={launchTab}
        savedAccount={savedAccount}
        recentCodes={recentCodes}
        profileCount={profiles.length}
        clientState={clientState}
        codeOfflineNotice={codeOfflineNotice}
        desktopServerUrl={desktopBridge ? desktopServerUrl : undefined}
        hostState={desktopBridge ? hostState : null}
        hostHandlers={desktopHostHandlers}
        hasTabBar={hasTabBar}
        hostPendingApproval={hostPendingApproval}
        onConnectWithCode={handleConnectWithCode}
        onCancelCodeConnect={handleCancelCodeConnect}
        onRetryCodeConnect={handleRetryCodeConnect}
        onDeleteRecentCode={handleDeleteRecentCode}
        onAccountAuthed={handleAccountAuthed}
        onReturnToAccountDashboard={handleReturnToAccountDashboard}
        onOpenConnections={() => {
          setEditProfileId(null);
          setModalOpen(true);
        }}
        onOpenServerSettings={
          desktopBridge ? () => setServerConfigModalOpen(true) : undefined
        }
      />
    ) : (
      <DashboardView
        clientState={clientState}
        savedAccount={savedAccount}
        apiBase={activeApiBase}
        serverInfo={serverInfo}
        profileCount={profiles.length}
        desktopServerUrl={desktopBridge ? desktopServerUrl : undefined}
        hostState={desktopBridge ? hostState : null}
        hostHandlers={desktopHostHandlers}
        openTabDeviceIds={openTabDeviceIds}
        hasTabBar={hasTabBar}
        onOpenConnections={(editId) => {
          setEditProfileId(editId ?? null);
          setModalOpen(true);
        }}
        onOpenControlCode={handleOpenControlCodeFromDashboard}
        onLogoutAccount={handleLogoutAccount}
        onReloginAccount={handleReloginAccount}
        onChangePassword={handleChangePassword}
        onLogoutAllSessions={handleLogoutAllSessions}
        onControlDevice={handleControlDevice}
        onWakeDevice={handleWakeDevice}
        onSendWol={handleSendWolDevice}
        onSendWolRaw={handleSendWolRaw}
        onDiscoverLanPeers={
          desktopBridge && typeof desktopBridge.discoverLanPeers === "function"
            ? handleDiscoverLanPeers
            : undefined
        }
        onConnectLanPeerCode={handleConnectLanPeerCode}
        onUnbindDevice={handleUnbindDevice}
        onReconnect={handleDashboardReconnect}
        onSwitchToDirectUrl={handleSwitchToDirectUrl}
        onOpenServerSettings={
          desktopBridge ? () => setServerConfigModalOpen(true) : undefined
        }
        onOpenNewWindow={
          desktopBridge ? () => void handleOpenNewWindow() : undefined
        }
      />
    );

  return (
    <>
      {isInSingleRemoteViewport ? (
        <RemoteViewport
          client={client}
          clientState={clientState}
          device={activeDevice}
          apiBase={activeApiBase}
          authToken={
            clientState.authType === "account" ? savedAccount?.authToken : undefined
          }
          serverInfo={serverInfo}
          desktopWindowState={desktopBridge ? desktopWindowState : undefined}
          onToggleAlwaysOnTop={
            desktopBridge ? handleToggleAlwaysOnTop : undefined
          }
          onSetWindowPreset={desktopBridge ? handleSetWindowPreset : undefined}
          onOpenNewWindow={desktopBridge ? handleOpenNewWindow : undefined}
          onShowToast={showToast}
          suppressKeyboard={serverConfigModalOpen || modalOpen}
          isActiveTab
          hasTabBar={false}
          onExit={handleExitViewport}
        />
      ) : (
        <div
          className={
            hasOpenTabs
              ? "flex h-[100dvh] w-screen flex-col overflow-hidden bg-black"
              : "min-h-[100dvh] w-full"
          }
        >
          {hasOpenTabs && (
            <DesktopTabBar
              tabs={openTabs}
              activeTabId={activeTabId}
              maxTabs={MAX_OPEN_TABS}
              getTabClient={(deviceId) =>
                sessionClientsRef.current.get(deviceId)?.client
              }
              tabStates={tabStates}
              tabRecordingMap={tabRecordingMap}
              hostPendingApproval={hostPendingApproval}
              onSelectTab={(tabId) => {
                setActiveTabId(tabId);
                if (tabId === "dashboard") {
                  setViewMode("dashboard");
                }
              }}
              onCloseTab={closeTab}
              onOpenNewWindow={
                desktopBridge ? () => void handleOpenNewWindow() : undefined
              }
            />
          )}

          <div
            className={
              hasOpenTabs
                ? "relative min-h-0 flex-1 overflow-hidden"
                : "min-h-[100dvh] w-full"
            }
          >
            <div
              className={
                !hasOpenTabs
                  ? "min-h-[100dvh] w-full"
                  : activeTabId === "dashboard"
                    ? "h-full w-full overflow-y-auto bg-[#F4F5F7]"
                    : "hidden"
              }
            >
              {renderDashboardOrLaunch(hasOpenTabs)}
            </div>

            {openTabs.map((tab) => {
              const runtime = sessionClientsRef.current.get(tab.deviceId);
              if (!runtime) return null;
              const tabState = tabStates[tab.deviceId] ?? runtime.client.getState();
              const resolvedDeviceId = tabState.activeDeviceId ?? tab.deviceId;
              const tabDevice =
                tabState.devices.find((d) => d.deviceId === resolvedDeviceId) ??
                tabState.devices[0] ??
                clientState.devices.find((d) => d.deviceId === resolvedDeviceId) ??
                null;
              const isTabActive = activeTabId === tab.deviceId;

              return (
                <div
                  key={tab.deviceId}
                  className={isTabActive ? "h-full w-full" : "hidden"}
                >
                  <RemoteViewport
                    client={runtime.client}
                    clientState={tabState}
                    device={tabDevice}
                    apiBase={activeApiBase}
                    authToken={
                      tabState.authType === "account"
                        ? savedAccount?.authToken
                        : undefined
                    }
                    serverInfo={serverInfo}
                    desktopWindowState={
                      desktopBridge ? desktopWindowState : undefined
                    }
                    onToggleAlwaysOnTop={
                      desktopBridge ? handleToggleAlwaysOnTop : undefined
                    }
                    onSetWindowPreset={
                      desktopBridge ? handleSetWindowPreset : undefined
                    }
                    onOpenNewWindow={
                      desktopBridge ? handleOpenNewWindow : undefined
                    }
                    onRecordingStateChange={(recording) =>
                      handleTabRecordingChange(tab.deviceId, recording)
                    }
                    onShowToast={showToast}
                    suppressKeyboard={
                      serverConfigModalOpen || modalOpen || !isTabActive
                    }
                    isActiveTab={isTabActive}
                    hasTabBar
                    onExit={() => closeTab(tab.deviceId)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {desktopBridge &&
        hostState?.pendingApproval &&
        desktopHostHandlers?.onApproveSession &&
        desktopHostHandlers?.onRejectSession && (
          <GlobalHostApprovalCard
            pendingApproval={hostState.pendingApproval}
            deviceName={hostState.deviceName}
            onApprove={desktopHostHandlers.onApproveSession}
            onReject={desktopHostHandlers.onRejectSession}
          />
        )}

      {desktopBridge && (
        <ServerConfigModal
          open={serverConfigModalOpen}
          currentServerUrl={desktopServerUrl}
          recentServers={recentServers}
          onClose={() => setServerConfigModalOpen(false)}
          onSaveServer={handleSaveDesktopServer}
          onRemoveRecentServer={handleRemoveRecentServer}
        />
      )}

      <ConnectionModal
        open={modalOpen}
        profiles={profiles}
        activeProfileId={activeProfileId}
        initialEditProfileId={editProfileId}
        onClose={() => {
          setModalOpen(false);
          setEditProfileId(null);
        }}
        onSelectProfile={handleSelectProfile}
        onSaveProfile={handleSaveProfile}
        onDeleteProfile={handleDeleteProfile}
      />

      <QuickConnectConfirmModal
        pending={pendingQuickConnect}
        onConfirm={handleConfirmQuickConnect}
        onCancel={handleCancelQuickConnect}
      />

      {/* Global Toast Notification */}
      {toast && (
        <div
          className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex justify-center px-4"
          style={{
            paddingTop: "max(3.75rem, calc(env(safe-area-inset-top) + 3rem))",
          }}
        >
          <div
            className={`animate-sheet-up rounded-lg border px-4 py-2 text-xs font-medium shadow-[0_12px_28px_rgba(17,19,24,0.22)] ${
              toast.level === "error"
                ? "border-[#FCA5A5] bg-[#FEF2F2] text-[#991B1B]"
                : toast.level === "warn"
                  ? "border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]"
                  : "border-[#232732] bg-[#111318] text-white"
            }`}
          >
            {toast.text}
          </div>
        </div>
      )}
    </>
  );
}

export default App;

function GlobalHostApprovalCard({
  pendingApproval,
  deviceName,
  onApprove,
  onReject,
}: {
  pendingApproval: DesktopHostPendingApproval;
  deviceName: string;
  onApprove: (sessionId: string, permissions: SessionPermissions) => Promise<void>;
  onReject: (sessionId: string) => Promise<void>;
}) {
  const [perms, setPerms] = useState({
    input: true,
    clipboard: true,
    fileTransfer: true,
    audio: true,
    terminal: true,
  });
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  useEffect(() => {
    setPerms({
      input: true,
      clipboard: true,
      fileTransfer: true,
      audio: true,
      terminal: true,
    });
    setBusy(null);
  }, [pendingApproval.sessionId]);

  const requestedTimeLabel = (() => {
    if (!pendingApproval.requestedAt) return "";
    try {
      return new Date(pendingApproval.requestedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return "";
    }
  })();

  async function handleApprove() {
    if (busy) return;
    setBusy("approve");
    try {
      await onApprove(pendingApproval.sessionId, {
        keyboard: perms.input,
        mouse: perms.input,
        clipboard: perms.clipboard,
        fileTransfer: perms.fileTransfer,
        audio: perms.audio,
        terminal: perms.terminal,
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleReject() {
    if (busy) return;
    setBusy("reject");
    try {
      await onReject(pendingApproval.sessionId);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="远程接入审批请求"
      className="fixed right-4 top-12 z-[65] w-[360px] max-w-[calc(100vw-2rem)] animate-sheet-up rounded-xl border-2 border-[#2563EB] bg-white p-4 text-xs text-[#111318] shadow-[0_20px_48px_rgba(17,19,24,0.32)]"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#F59E0B]/40 bg-[#FFFBEB] text-[#D97706]">
          <ShieldAlert className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="text-sm font-semibold text-[#111318]">
              收到远程接入请求
            </p>
            <span className="inline-flex items-center gap-1 rounded border border-[#FDE68A] bg-[#FFFBEB] px-1.5 py-0.5 text-[10px] font-semibold text-[#B45309]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#F59E0B]" />
              待审批
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-[#4B5563]">
            目标主机：{deviceName || "本机"}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-[#2563EB]">
            会话 {pendingApproval.sessionId.slice(0, 12)}
            {requestedTimeLabel ? ` · ${requestedTimeLabel}` : ""}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-[#E2E6EC] bg-[#F8F9FB] px-3 py-2.5">
        <p className="mb-2 text-[11px] font-semibold text-[#374151]">
          本次会话授予权限：
        </p>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { key: "input", label: "鼠标与键盘" },
              { key: "clipboard", label: "剪贴板" },
              { key: "fileTransfer", label: "文件管理" },
              { key: "audio", label: "系统声音" },
              { key: "terminal", label: "远程终端" },
            ] as const
          ).map((item) => (
            <label
              key={item.key}
              className="inline-flex cursor-pointer items-center gap-1.5 select-none text-xs text-[#111318]"
            >
              <input
                type="checkbox"
                checked={perms[item.key]}
                onChange={(e) =>
                  setPerms((prev) => ({
                    ...prev,
                    [item.key]: e.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-[#CBD2DC] accent-[#2563EB]"
              />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void handleReject()}
          className="btn-outline inline-flex h-9 items-center gap-1.5 rounded-md border-[#FCA5A5] bg-white px-3.5 text-xs font-medium text-[#DC2626] hover:bg-[#FEF2F2] disabled:opacity-50"
        >
          {busy === "reject" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
          拒绝
        </button>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void handleApprove()}
          className="btn-primary inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-xs font-semibold disabled:opacity-50"
        >
          {busy === "approve" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          允许接入
        </button>
      </div>
    </div>
  );
}
