import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeControlCode, type DeviceSummary } from "@velodeck/protocol";
import { ConnectionModal } from "./components/ConnectionModal";
import { DashboardView } from "./components/DashboardView";
import type { DesktopHostHandlers } from "./components/DesktopHostPanel";
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
  type DesktopHostState,
  type DesktopWindowPreset,
  type DesktopWindowState,
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
    };
  }, []);

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
      client.startSession(target.deviceId);
    }
  }, [client, clientState.socketStatus, clientState.devices]);

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

  function handleConnectWithCode(input: {
    controlCode: string;
    controlPassword: string;
    rememberPassword: boolean;
  }) {
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
  }

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
    showToast("info", "密码已修改，其他设备登录态已失效");
  }

  async function handleLogoutAllSessions() {
    if (!savedAccount) {
      throw new Error("当前未登录账号");
    }
    await logoutAllSessionsApi(savedAccount.apiBase, savedAccount.authToken);
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
      client.removeDevice(device.deviceId);
      showToast("info", `已解绑设备「${device.name || device.model}」`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "解绑设备失败";
      showToast("error", msg);
    }
  }

  function handleSelectProfile(profile: ConnectionProfile) {
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
        client.connect(fallback);
      } else if (clientState.authType === "token") {
        client.disconnect();
        if (!savedAccount) {
          setViewMode("launch");
        }
      }
    }
  }

  function handleControlDevice(device: DeviceSummary) {
    client.startSession(device.deviceId, {
      preferredTransport:
        clientState.profile?.preferredTransport ?? clientState.desiredTransport,
      qualityPreset:
        clientState.profile?.qualityPreset ?? clientState.qualityPreset,
    });
  }

  function handleWakeDevice(device: DeviceSummary) {
    const res = client.sendCommand({ action: "wake" }, device.deviceId);
    if (res.sent) {
      showToast("info", `已向「${device.name}」发送亮屏唤醒指令`);
    } else {
      showToast("error", "当前未连接，无法发送唤醒指令");
    }
  }

  function handleSwitchToDirectUrl(device: DeviceSummary) {
    if (!device.directUrl) return;
    // Strictly validate private/LAN IP before forwarding accessToken to a device-advertised directUrl
    if (!isAllowedDirectUrl(device.directUrl)) {
      showToast("error", "已拦截非局域网/私有网段的直连地址，防止凭据泄露");
      return;
    }

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
        reconnectHandlerRef.current();
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
    async (patch: DesktopHostConfigPatch) => {
      if (!desktopBridge || typeof desktopBridge.updateHostConfig !== "function") {
        return;
      }
      try {
        const next = await desktopBridge.updateHostConfig(patch);
        if (next) setHostState(next);
        showToast("info", "本机被控配置已更新");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "保存本机配置失败";
        showToast("error", msg);
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

  const isInRemoteViewport = Boolean(clientState.activeDeviceId);

  return (
    <>
      {isInRemoteViewport ? (
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
          onExit={handleExitViewport}
        />
      ) : viewMode === "launch" ? (
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
