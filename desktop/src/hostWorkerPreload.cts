import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export type HostPlatform = "darwin" | "win32" | "linux";

export interface HostWorkerDisplayInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface HostWorkerPermissions {
  accessibility: boolean;
  screenCapture: boolean;
  platform: HostPlatform;
}

export interface HostWorkerConfig {
  wsUrl: string;
  deviceId: string;
  deviceSecret: string;
  authToken?: string;
  unbindOwner?: boolean;
  controlPassword: string;
  name: string;
  model: string;
  osVersion: string;
  osPlatform: HostPlatform;
  displays: HostWorkerDisplayInfo[];
  activeDisplayId: string;
  permissions: HostWorkerPermissions;
}

export type HostWorkerCommand =
  | { type: "start"; config: HostWorkerConfig }
  | {
      type: "update-config";
      config: HostWorkerConfig;
      reconnect: boolean;
      switchDisplayId?: string;
    }
  | { type: "disconnect-session"; reason?: string }
  | { type: "stop" };

export interface HostWorkerStateReport {
  status?: "stopped" | "connecting" | "online" | "controlling" | "error";
  controlCode?: string;
  ownerUsername?: string;
  activeSessionId?: string | null;
  activeTransport?: "webrtc" | "ws-jpeg" | null;
  activeDisplayId?: string;
  lastError?: string | null;
}

export interface HostCaptureSourceResult {
  ok: boolean;
  sourceId?: string;
  display?: HostWorkerDisplayInfo;
  displays?: HostWorkerDisplayInfo[];
  error?: string;
}

export interface VeloDeckHostWorkerBridge {
  ready(): void;
  onCommand(cb: (command: HostWorkerCommand) => void): () => void;
  reportState(report: HostWorkerStateReport): void;
  requestCaptureSource(displayId?: string): Promise<HostCaptureSourceResult>;
  dispatchControl(
    cmd: Record<string, unknown>,
    displayId?: string,
  ): Promise<{ ok: boolean; message?: string }>;
  setClipboard(text: string): Promise<boolean>;
  fileTransferText(sessionId: string, text: string): Promise<string | null>;
  fileTransferBinary(sessionId: string, chunk: Uint8Array): Promise<string | null>;
  fileTransferAbort(sessionId: string): void;
}

const workerBridge: VeloDeckHostWorkerBridge = Object.freeze({
  ready(): void {
    ipcRenderer.send("velodeck-host:ready");
  },

  onCommand(cb: (command: HostWorkerCommand) => void): () => void {
    if (typeof cb !== "function") {
      return () => {};
    }
    const wrapped = (
      _event: IpcRendererEvent,
      command: HostWorkerCommand,
    ): void => {
      cb(command);
    };
    ipcRenderer.on("velodeck-host:command", wrapped);
    return () => {
      ipcRenderer.removeListener("velodeck-host:command", wrapped);
    };
  },

  reportState(report: HostWorkerStateReport): void {
    ipcRenderer.send("velodeck-host:state", report);
  },

  requestCaptureSource(displayId?: string): Promise<HostCaptureSourceResult> {
    return ipcRenderer.invoke("velodeck-host:get-capture-source", displayId ?? "");
  },

  dispatchControl(
    cmd: Record<string, unknown>,
    displayId?: string,
  ): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke("velodeck-host:control-cmd", {
      cmd,
      displayId: displayId ?? "",
    });
  },

  setClipboard(text: string): Promise<boolean> {
    return ipcRenderer.invoke("velodeck-host:clipboard-set", text);
  },

  fileTransferText(sessionId: string, text: string): Promise<string | null> {
    return ipcRenderer.invoke("velodeck-host:file-text", { sessionId, text });
  },

  fileTransferBinary(sessionId: string, chunk: Uint8Array): Promise<string | null> {
    return ipcRenderer.invoke("velodeck-host:file-binary", { sessionId, chunk });
  },

  fileTransferAbort(sessionId: string): void {
    ipcRenderer.send("velodeck-host:file-abort", sessionId);
  },
});

contextBridge.exposeInMainWorld("velodeckHostWorker", workerBridge);
