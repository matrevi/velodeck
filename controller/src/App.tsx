import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeControlCode, type DeviceSummary } from "@velodeck/protocol";
import { ConnectionModal } from "./components/ConnectionModal";
import { DashboardView } from "./components/DashboardView";
import { LaunchView } from "./components/LaunchView";
import { QuickConnectConfirmModal } from "./components/QuickConnectConfirmModal";
import { RemoteViewport } from "./components/RemoteViewport";
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
  const defaultApiBase = useMemo(() => detectDefaultApiBase(window.location), []);
  const defaultRelayWsUrl = useMemo(
    () => detectDefaultRelayWsUrl(window.location),
    [],
  );
  const defaultTransport = useMemo(
    () => detectDefaultTransport(window.location),
    [],
  );

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
  const [launchTab, setLaunchTab] = useState<"code" | "account">("code");
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

  const activeApiBase = savedAccount?.apiBase ?? defaultApiBase;

  function showToast(level: ToastMessage["level"], text: string) {
    const id = ++toastSeqRef.current;
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ id, level, text });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast((curr) => (curr?.id === id ? null : curr));
    }, 3200);
  }

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

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
    let cancelled = false;
    void fetchServerInfo(activeApiBase).then((info) => {
      if (!cancelled) {
        setServerInfo(info);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeApiBase]);

  // Re-fetch /api/info whenever WebSocket (re)connects so long-lived open tabs
  // automatically pick up updated server version & APK SHA-256 after a server upgrade.
  useEffect(() => {
    if (clientState.socketStatus !== "connected") return;
    let cancelled = false;
    void fetchServerInfo(activeApiBase).then((info) => {
      if (!cancelled) {
        setServerInfo(info);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeApiBase, clientState.socketStatus]);

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
      if (client.getState().socketStatus === "idle") {
        client.connectWithAccount({
          wsUrl: storedAccount.wsUrl || defaultRelayWsUrl,
          authToken: storedAccount.authToken,
          user: storedAccount.user,
          preferredTransport: defaultTransport,
          qualityPreset: "auto",
        });
      }
      return;
    }

    setViewMode("launch");
  }, [client, defaultRelayWsUrl, defaultTransport]);

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
      wsUrl: savedAccount?.wsUrl || defaultRelayWsUrl,
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
      wsUrl: defaultRelayWsUrl,
      apiBase: defaultApiBase,
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
      wsUrl: updatedSession.wsUrl || defaultRelayWsUrl,
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
        wsUrl: savedAccount.wsUrl || defaultRelayWsUrl,
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
      client.connectWithAccount({
        wsUrl: savedAccount.wsUrl || defaultRelayWsUrl,
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
        />
      ) : (
        <DashboardView
          clientState={clientState}
          savedAccount={savedAccount}
          apiBase={activeApiBase}
          serverInfo={serverInfo}
          profileCount={profiles.length}
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
