import { useEffect, useRef, useState } from "react";
import {
  Check,
  Eye,
  EyeOff,
  Globe,
  Pencil,
  Plus,
  Server,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import type { TransportMode } from "@velodeck/protocol";
import {
  detectDefaultTransport,
  detectDefaultWsUrl,
  inferModeFromWsUrl,
  normalizeWsUrl,
  type ConnectionMode,
  type ConnectionProfile,
  type QualityPreset,
} from "../state/profiles";

interface ConnectionModalProps {
  open: boolean;
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  initialEditProfileId?: string | null;
  onClose: () => void;
  onSelectProfile: (profile: ConnectionProfile) => void;
  onSaveProfile: (
    input: Omit<ConnectionProfile, "id"> & { id?: string },
  ) => void;
  onDeleteProfile: (id: string) => void;
}

export function ConnectionModal({
  open,
  profiles,
  activeProfileId,
  initialEditProfileId,
  onClose,
  onSelectProfile,
  onSaveProfile,
  onDeleteProfile,
}: ConnectionModalProps) {
  const [view, setView] = useState<"list" | "form">("list");
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [mode, setMode] = useState<ConnectionMode>("direct");
  const [label, setLabel] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [preferredTransport, setPreferredTransport] = useState<TransportMode>(() =>
    detectDefaultTransport(),
  );
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>("auto");
  const [formError, setFormError] = useState<string | null>(null);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  useEffect(() => {
    if (!open) return;

    const currentProfiles = profilesRef.current;
    if (initialEditProfileId) {
      const found = currentProfiles.find((p) => p.id === initialEditProfileId);
      if (found) {
        populateForm(found);
        setView("form");
        return;
      }
    }

    if (currentProfiles.length === 0) {
      resetForm("direct");
      setView("form");
    } else {
      setView("list");
    }
  }, [open, initialEditProfileId]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  function populateForm(profile: ConnectionProfile) {
    setEditingId(profile.id);
    setMode(profile.mode);
    setLabel(profile.label);
    setWsUrl(profile.wsUrl);
    setAccessToken(profile.accessToken);
    setPreferredTransport(profile.preferredTransport);
    setQualityPreset(profile.qualityPreset);
    setShowToken(false);
    setFormError(null);
  }

  function resetForm(nextMode: ConnectionMode = "direct") {
    setEditingId(undefined);
    setMode(nextMode);
    setLabel("");
    setWsUrl("");
    setAccessToken("");
    setPreferredTransport(detectDefaultTransport());
    setQualityPreset("auto");
    setShowToken(false);
    setFormError(null);
  }

  function handleUseCurrentUrl() {
    const detected = detectDefaultWsUrl(window.location);
    if (!detected) {
      setFormError("当前环境无法自动识别网址，请手动填写 WebSocket 地址");
      return;
    }
    const inferred = inferModeFromWsUrl(detected);
    setWsUrl(detected);
    setMode(inferred);
    if (!label.trim()) {
      setLabel(inferred === "direct" ? "当前直连服务" : "当前中继服务");
    }
    setFormError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const normalized = normalizeWsUrl(wsUrl, mode);
    if (!normalized || !/^wss?:\/\/.+/i.test(normalized)) {
      setFormError("请输入有效的 WebSocket 地址（例如 ws://192.168.1.x:8765/ws 或 wss://domain/ws）");
      return;
    }

    onSaveProfile({
      id: editingId,
      label:
        label.trim() ||
        (mode === "direct" ? "局域网 / 虚拟组网直连" : "自定义中继服务器"),
      mode,
      wsUrl: normalized,
      accessToken: accessToken.trim(),
      preferredTransport,
      qualityPreset,
    });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="modal-panel animate-sheet-up safe-bottom max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl text-[#111318] sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#E2E6EC] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-[#111318]">
              {view === "list"
                ? "局域网与自建地址"
                : editingId
                  ? "编辑连接配置"
                  : "添加连接配置"}
            </h2>
            <p className="mt-0.5 text-xs text-[#6B7280]">
              支持局域网 / 蒲公英直连与自定义中继服务
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111318]"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          {view === "list" ? (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-lg border border-[#E2E6EC]">
                <ul className="divide-y divide-[#ECEFF4]">
                  {profiles.map((profile) => {
                    const isActive = profile.id === activeProfileId;
                    return (
                      <li
                        key={profile.id}
                        className={`flex items-center gap-2 px-3.5 py-3 transition-colors ${
                          isActive ? "bg-[#EFF4FF]" : "bg-white hover:bg-[#F8F9FB]"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            onSelectProfile(profile);
                            onClose();
                          }}
                          className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        >
                          <div
                            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                              profile.mode === "direct"
                                ? "bg-[#ECFDF3] text-[#15803D]"
                                : "bg-[#EFF4FF] text-[#2563EB]"
                            }`}
                          >
                            {profile.mode === "direct" ? (
                              <Wifi className="h-4 w-4" />
                            ) : (
                              <Server className="h-4 w-4" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-[#111318]">
                                {profile.label}
                              </span>
                              <span className="shrink-0 rounded bg-[#F3F4F6] px-1.5 py-0.5 text-[10px] font-medium text-[#4B5563]">
                                {profile.mode === "direct" ? "直连" : "中继"}
                              </span>
                              {isActive && (
                                <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-[#2563EB]">
                                  <Check className="h-3 w-3" />
                                  当前
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 truncate font-mono text-[11px] text-[#6B7280]">
                              {profile.wsUrl}
                            </p>
                          </div>
                        </button>

                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              populateForm(profile);
                              setView("form");
                            }}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111318]"
                            aria-label="编辑配置"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteProfile(profile.id)}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] hover:bg-[#FEF2F2] hover:text-[#DC2626]"
                            aria-label="删除配置"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <button
                type="button"
                onClick={() => {
                  resetForm("direct");
                  setView("form");
                }}
                className="btn-outline flex h-10 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium"
              >
                <Plus className="h-4 w-4" />
                新增连接配置
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#F1F3F6] p-1">
                <button
                  type="button"
                  onClick={() => setMode("direct")}
                  className={`flex items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium transition ${
                    mode === "direct"
                      ? "bg-white text-[#111318] shadow-xs"
                      : "text-[#6B7280] hover:text-[#111318]"
                  }`}
                >
                  <Wifi className="h-3.5 w-3.5 text-[#15803D]" />
                  局域网 / 组网直连
                </button>

                <button
                  type="button"
                  onClick={() => setMode("relay")}
                  className={`flex items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium transition ${
                    mode === "relay"
                      ? "bg-white text-[#111318] shadow-xs"
                      : "text-[#6B7280] hover:text-[#111318]"
                  }`}
                >
                  <Server className="h-3.5 w-3.5 text-[#2563EB]" />
                  自定义中继
                </button>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-medium text-[#374151]">
                    WebSocket 地址
                  </label>
                  <button
                    type="button"
                    onClick={handleUseCurrentUrl}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[#2563EB] hover:underline"
                  >
                    <Globe className="h-3 w-3" />
                    使用当前网址
                  </button>
                </div>
                <input
                  type="text"
                  value={wsUrl}
                  onChange={(e) => {
                    setWsUrl(e.target.value);
                    setFormError(null);
                  }}
                  placeholder={
                    mode === "direct"
                      ? "ws://192.168.1.x:8765/ws"
                      : "wss://velodeck.example.com/ws"
                  }
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="field h-10 w-full rounded-lg px-3 font-mono text-sm placeholder:text-[#9CA3AF]"
                />
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-[#374151]">
                  访问密钥 (Access Token)
                </label>
                <div className="relative">
                  <input
                    type={showToken ? "text" : "password"}
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                    placeholder="输入与手机端一致的直连密钥"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="field h-10 w-full rounded-lg pl-3 pr-9 font-mono text-sm placeholder:font-sans placeholder:text-[#9CA3AF]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((prev) => !prev)}
                    className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-[#6B7280] hover:text-[#111318]"
                    aria-label={showToken ? "隐藏密钥" : "显示密钥"}
                  >
                    {showToken ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-[#374151]">
                  备注名称（可选）
                </label>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={mode === "direct" ? "例如：家里备用机直连" : "例如：自建中继"}
                  className="field h-10 w-full rounded-lg px-3 text-sm placeholder:text-[#9CA3AF]"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-[#374151]">
                    首选通道
                  </label>
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#F1F3F6] p-1">
                    {(
                      [
                        { id: "webrtc", label: "WebRTC" },
                        { id: "ws-jpeg", label: "WS 帧流" },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setPreferredTransport(item.id)}
                        className={`h-8 rounded-md text-xs font-medium transition ${
                          preferredTransport === item.id
                            ? "bg-white text-[#111318] shadow-xs"
                            : "text-[#6B7280]"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-[#374151]">
                    默认清晰度
                  </label>
                  <div className="grid grid-cols-4 gap-1 rounded-lg bg-[#F1F3F6] p-1">
                    {(
                      [
                        { id: "auto", label: "智能" },
                        { id: "eco", label: "省流" },
                        { id: "balanced", label: "均衡" },
                        { id: "hd", label: "高清" },
                      ] as const
                    ).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setQualityPreset(item.id)}
                        className={`h-8 rounded-md text-xs font-medium transition ${
                          qualityPreset === item.id
                            ? "bg-white text-[#111318] shadow-xs"
                            : "text-[#6B7280]"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {formError && (
                <div className="rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#991B1B]">
                  {formError}
                </div>
              )}

              <div className="flex items-center gap-2.5 pt-1">
                {profiles.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setView("list")}
                    className="btn-outline h-10 flex-1 rounded-lg text-xs font-medium"
                  >
                    返回列表
                  </button>
                )}
                <button
                  type="submit"
                  className="btn-primary h-10 flex-[2] rounded-lg text-sm font-medium"
                >
                  {editingId ? "保存并重连" : "保存并连接"}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
