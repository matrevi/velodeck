# VeloDeck（极控）Fork 与自托管服务器部署指南

本文档面向 **Fork 本仓库并使用自己服务器独立部署** 的开发者与自托管用户，覆盖从云服务器搭建、防火墙放行、专属 Android APK 编译（支持零本地环境云端编译）到应用内一键自更新与上游版本同步的全流程。

> **安全红线**：部署与二次构建时，请**绝对不要**把你的真实公网 IP、域名私密凭据、`server/.env`、`android-agent/local.properties`、`android-agent/keystore.properties` 或 `.jks` 签名文件提交到公开 Git 仓库，也不要把内嵌私人 IP 的 APK 上传到公开 GitHub Release。

---

## 0. 快速选型：你应该选哪条路线？

在开始之前，先根据自己有没有域名、是否想在本地装 Android Studio 选择最省事的方案：

| 你的情况 | 服务端方案 | Android 客户端获取方式 | 难度 / 耗时 |
| --- | --- | --- | --- |
| **有域名**（推荐，自动 HTTPS/WSS） | `server/docker-compose.yml`（含 Caddy 自动证书 + coturn） | **零编译**：直接下载本仓库 GitHub Releases 中的通用 APK，安装后在 App「高级设置」里把中继地址改为 `wss://你的域名/ws` 即可 | 最简单，约 5 分钟 |
| **无域名（纯公网 IP）** 或希望「装好即连自己服务器」且**不想本地装 Android Studio** | `server/docker-compose.ip.yml`（或域名版） | **Fork + GitHub Actions 云端编译**：在自己 Fork 仓库填入服务器地址与签名 Secret，点一下 `Run workflow` 云端自动出包 | 推荐，约 8 分钟 |
| **无域名（纯公网 IP）** 且本地已有 JDK 17 / Android SDK | `server/docker-compose.ip.yml`（或域名版） | **本地 Gradle 编译**：写入 `local.properties` + `keystore.properties` 后执行 `./gradlew assembleRelease` | 约 10 分钟 |

> **为什么纯 IP 部署必须单独编译 APK？**  
> 出于安全加固，Android 客户端默认在 `network_security_config.xml` 中全局禁止明文 `http://` / `ws://` 流量；只有通过编译参数 `-PvelodeckRelayUrl` / `-PvelodeckApiUrl`（或 `local.properties`）指定的明文主机才会被自动加入白名单。而使用 **HTTPS + WSS 域名** 时则不受此限制，可直接复用官方通用 Release APK。

---

## 1. 服务器前置要求与端口放行

### 1.1 推荐服务器配置

- **系统**：Ubuntu 22.04 / 24.04 或 Debian 12（需安装 Docker Engine 与 Docker Compose v2 插件）
- **规格**：1 核 1G 内存即可稳定运行（`velodeck-server` 内存限制 512 MB，`coturn` 256 MB，`caddy` 256 MB）
- **带宽建议**：
  - **3 Mbps 轻量云服务器**：完全够用，请保持控制端默认的 **「智能（auto）」** 档位（在 TURN 中继下会自动稳驻 `720p @ 60fps @ 2.2 Mbps`，低延迟且无噪点，不会打爆 3 Mbps 出口队列）。
  - **5 Mbps 及以上 / 局域网 P2P**：智能档位会自动上探 `900p / 1080p @ 60fps`。

### 1.2 安装 Docker（如尚未安装）

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
# 重新登录 SSH 后验证
docker compose version
```

### 1.3 云服务器安全组 & 系统防火墙必须放行的端口

> **最常见坑点**：只放行了 `80/443` 却忘了放行 `3478/UDP` 和 `49152-65535/UDP`，会导致跨网 WebRTC 建链失败或回退到低帧率 WS 模式。

| 端口 / 协议 | 用途 | 适用方案 |
| --- | --- | --- |
| `80/TCP` | HTTP 入口 / Caddy 自动申请 Let's Encrypt 证书 / 纯 IP 网页与 API | 全部必需 |
| `443/TCP`、`443/UDP` | Caddy 自动 HTTPS / WSS / HTTP3 | 域名部署必需 |
| `3478/UDP`、`3478/TCP` | `coturn` 同机房 STUN + TURN 控制信令 | 全部必需 |
| `49152-65535/UDP` | `coturn` WebRTC 音视频与文件直传中继端口段 | 全部必需 |

如果服务器开启了 `ufw`，执行：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp
```

---

## 2. 第一步：Fork 仓库并部署自己的服务端

### 2.1 Fork 并克隆到你的服务器

点击本仓库右上角 **Fork** 到你的 GitHub 账号下，然后登录你的 VPS：

```bash
sudo mkdir -p /opt/velodeck && sudo chown "$USER:$USER" /opt/velodeck
git clone https://github.com/<你的GitHub用户名>/velodeck.git /opt/velodeck
cd /opt/velodeck/server
cp .env.example .env
```

### 2.2 生成随机密钥并配置 `server/.env`

先生成一个高强度随机 `TURN_SECRET`（和可选的 `ADMIN_TOKEN`）：

```bash
openssl rand -hex 32
```

根据你的部署方式二选一编辑 `server/.env`：

#### 方案 A：独立域名 + 自动 HTTPS / WSS（生产推荐）

先将你的域名（例如 `remote.example.com`）添加一条 **A 记录** 指向你的服务器公网 IP，然后编辑 `server/.env`：

```dotenv
DOMAIN=remote.example.com
PUBLIC_IP=203.0.113.10
TRUST_PROXY=true
TURN_URLS=turn:remote.example.com:3478?transport=udp,turn:remote.example.com:3478?transport=tcp
TURN_SECRET=<替换为你刚生成的 64 位十六进制随机密钥>
REGISTRATION_MODE=first-user-then-invite
# 可选：如果需要让第 2 位及以后用户注册，设置一个强邀请码
REGISTRATION_INVITE_CODE=
```

启动全部容器（`velodeck-server` + `velodeck-coturn` + `velodeck-caddy`）：

```bash
cd /opt/velodeck/server
docker compose up -d --build
```

#### 方案 B：纯公网 IP 部署（无域名，开箱即用）

编辑 `server/.env`：

```dotenv
PUBLIC_IP=203.0.113.10
TRUST_PROXY=false
TURN_URLS=turn:203.0.113.10:3478?transport=udp,turn:203.0.113.10:3478?transport=tcp
TURN_SECRET=<替换为你刚生成的 64 位十六进制随机密钥>
REGISTRATION_MODE=first-user-then-invite
REGISTRATION_INVITE_CODE=
```

使用纯 IP 编排文件启动（`velodeck-server` + `velodeck-coturn`）：

```bash
cd /opt/velodeck/server
docker compose -f docker-compose.ip.yml up -d --build
```

> **提示**：`TURN_URLS` 建议**将 `?transport=udp` 放在 `?transport=tcp` 前面**（如上所示），避免 TCP-over-TCP 队头阻塞放大延迟。如果不填 `TURN_URLS` 但配置了 `PUBLIC_IP` 与 `TURN_SECRET`，服务端也会自动按 UDP 优先推导。

### 2.3 验证服务端健康状态

```bash
# 域名部署
curl -fsS https://remote.example.com/health
curl -fsS https://remote.example.com/api/info

# 纯 IP 部署
curl -fsS http://203.0.113.10/health
curl -fsS http://203.0.113.10/api/info
```

返回 `{"ok":true,"version":"1.0.9",...}` 且 `docker ps` 显示容器均为 `Up (healthy)` 即表示服务端就绪。

此时打开浏览器访问你的域名（或 `http://203.0.113.10`），**注册第一个管理员账号**。在默认 `first-user-then-invite` 模式下，首个用户注册完成后会自动锁定公开注册，他人无法随意注册使用你的服务器。

---

## 3. 第二步：获取指向你服务器的 Android APK

### 方式 A：零编译直接用官方 Release APK（仅限域名 + HTTPS 部署）

1. 在本仓库 [Releases](https://github.com/matrevi/velodeck/releases) 页面下载最新 `velodeck-agent-vX.Y.Z.apk` 并安装到被控 Android 手机。
2. 打开手机上的 **VeloDeck（极控）** → 展开底部 **「高级设置」** → 将 **中继服务器地址** 改为 `wss://remote.example.com/ws` → 点击保存。
3. 回到首页登录你刚在网页端注册的账号即可上线（App 会自动根据中继地址推导 API 地址 `https://remote.example.com`）。

> 若你也想让手机后续通过你的服务器直接「一键更新」，可以把这份 APK（或你自己编译的定制 APK）复制到服务器的 `/opt/velodeck/server/downloads/velodeck-agent.apk`。

---

### 方式 B：用你 Fork 仓库的 GitHub Actions 云端自动编译（推荐，无需本地装 Android Studio）

本仓库已内置手动触发工作流 [`.github/workflows/build-custom-apk.yml`](../.github/workflows/build-custom-apk.yml)，**支持纯 IP 与域名部署，构建产物仅存为私有 Actions Artifact（绝不会自动发到公开 Release）**。

#### 1）生成一次个人签名密钥（强烈推荐，保证以后可覆盖升级不丢配置）

在任意一台装有 Java/JDK 的电脑（或你的 VPS）上运行一次：

```bash
keytool -genkeypair -v \
  -keystore velodeck-release.jks \
  -alias velodeck \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=VeloDeck SelfHost, OU=Personal, O=SelfHost, L=City, ST=State, C=CN"

# 转为单行 Base64（复制输出内容备用，勿提交此文件到仓库！）
base64 -w 0 velodeck-release.jks 2>/dev/null || base64 -i velodeck-release.jks | tr -d '\n'
```

> **如果不方便生成签名**：也可以在下面触发工作流时把 `build_type` 选为 `debug` 直接产出可安装的测试签名 APK（缺点是每次换 Runner 环境重编可能签名不一致，需要卸载重装；生产长期使用仍建议配置一次上述 `release` 签名）。

#### 2）在你 Fork 后的 GitHub 仓库配置 Secrets

打开你的 Fork 仓库 → **Settings → Secrets and variables → Actions → Repository secrets**，新增以下机密变量（放在 Secrets 中可确保日志自动脱敏、不泄露你的服务器地址与密码）：

| Secret 名称 | 必填 | 示例值 |
| --- | --- | --- |
| `VELODECK_RELAY_URL` | **是** | 域名版：`wss://remote.example.com/ws`<br>纯 IP 版：`ws://203.0.113.10/ws` |
| `VELODECK_API_URL` | **是** | 域名版：`https://remote.example.com`<br>纯 IP 版：`http://203.0.113.10` |
| `ANDROID_KEYSTORE_BASE64` | Release 签名时必填 | 上一步 `base64` 输出的单行字符串 |
| `ANDROID_KEYSTORE_PASSWORD` | Release 签名时必填 | 创建 `.jks` 时输入的 keystore 密码 |
| `ANDROID_KEY_ALIAS` | Release 签名时必填 | `velodeck` |
| `ANDROID_KEY_PASSWORD` | Release 签名时必填 | 创建 `.jks` 时输入的 key 密码（通常与 keystore 密码一致） |

#### 3）一键触发云端编译并下载 APK

1. 在你 Fork 后的仓库顶部进入 **Actions** 标签页（首次使用如提示请点 *I understand my workflows, go ahead and enable them*）。
2. 左侧选择 **Build Custom Server APK** → 点击右侧 **Run workflow**。
3. 选择 `build_type`（配置了签名 Secrets 选 `release`，否则选 `debug`）→ 点击绿色 **Run workflow**。
4. 等待约 3–5 分钟，构建完成后在任务页面底部的 **Artifacts** 区域下载 `velodeck-agent-custom-apk`，解压即可获得指向你自己服务器的专属 APK 与 `.sha256` 校验文件。

---

### 方式 C：本地电脑编译专属签名 APK

适合本地已安装 Node.js 22+、`pnpm`、JDK 17 和 Android SDK（API 36）的开发者：

```bash
# 1. 克隆你 Fork 的仓库并构建前端内嵌资源（供局域网直连模式使用）
git clone https://github.com/<你的GitHub用户名>/velodeck.git
cd velodeck
pnpm install
pnpm build:protocol
pnpm build:controller
pnpm sync:android-web

# 2. 复制服务器地址与签名配置模板（两份文件均已在 .gitignore 中自动忽略）
cp android-agent/local.properties.example android-agent/local.properties
cp android-agent/keystore.properties.example android-agent/keystore.properties
```

按实际路径编辑 `android-agent/local.properties`（注意属性名包含点号）：

```properties
sdk.dir=/你的/Android/sdk路径
# 域名版用 wss:// 与 https://；纯 IP 版用 ws:// 与 http://
velodeck.relayUrl=wss://remote.example.com/ws
velodeck.apiUrl=https://remote.example.com
```

生成个人签名证书并填入 `android-agent/keystore.properties`：

```bash
cd android-agent
keytool -genkeypair -v \
  -keystore velodeck-release.jks \
  -alias velodeck \
  -keyalg RSA -keysize 2048 -validity 10000
```

编辑 `android-agent/keystore.properties`：

```properties
storeFile=velodeck-release.jks
storePassword=你的keystore密码
keyAlias=velodeck
keyPassword=你的key密码
```

开始编译正式签名 APK（也可以直接通过 `-P` 参数临时覆盖服务器地址）：

```bash
cd android-agent
./gradlew assembleRelease

# 或通过命令行参数临时指定（优先级高于 local.properties）
./gradlew assembleRelease \
  -PvelodeckRelayUrl=wss://remote.example.com/ws \
  -PvelodeckApiUrl=https://remote.example.com
```

生成的安装包位于：
`android-agent/app/build/outputs/apk/release/app-release.apk`

---

## 4. 第三步：上传 APK 到自己的服务器，开启手机端一键自更新与远程 OTA

将编译好的专属 APK 上传到你服务器的 `server/downloads/velodeck-agent.apk`：

```bash
# 在本地电脑执行（替换为你的服务器登录信息）
scp app-release.apk user@203.0.113.10:/tmp/velodeck-agent.apk

# 在服务器执行
mkdir -p /opt/velodeck/server/downloads
mv /tmp/velodeck-agent.apk /opt/velodeck/server/downloads/velodeck-agent.apk
chmod 644 /opt/velodeck/server/downloads/velodeck-agent.apk
```

无需重启容器，服务端会实时检测文件变化并自动计算 SHA-256。验证接口：

```bash
curl -fsS http://127.0.0.1:8080/api/info
# 确认 hasAndroidApk 为 true 且 apkSha256 非空
```

开启后你将同时获得两种免数据线升级能力：
1. **手机 App 内一键自更新**：在手机打开 VeloDeck → **「应用更新 → 立即更新」**，自动校验 SHA-256 并以独立文件名保存（避免 ColorOS / 国产 ROM 安装器缓存冲突）拉起系统安装器。
2. **网页控制端远程 OTA 推送**：在电脑/iPhone 网页控制界面 → **文件传输 →「一键推送云端最新 APK 升级」**，通过 WebRTC DataChannel 直传并拉起安装。

---

## 5. 第四步：被控 Android 手机与控制端首次配置

### 5.1 被控 Android 手机（一次性设置）

1. 安装你的专属 APK 并打开 **VeloDeck（极控）**，登录与网页端相同的账号。
2. 按首页向导依次授予：
   - **无障碍服务**（用于远程点击/滑动/返回/锁屏操作）
   - **忽略电池优化 / 允许自启动 / 后台高耗电**（并在多任务界面给应用加锁，防止国产 ROM 杀后台）
   - **屏幕共享（MediaProjection）授权**（持久化保活，无人远控时零流量挂起）
3. **可选 ADB 永久自愈加固（免 Root）**：如果手机偶尔连接电脑，可运行 `./scripts/enable-unattended-permanent.sh` 授予 `WRITE_SECURE_SETTINGS`，实现无障碍服务被系统关闭时自动恢复（OPPO/一加/Realme 需先在开发者选项中开启「禁止权限监控」）。

### 5.2 控制端（原生电脑客户端 / iPhone / 桌面浏览器）

- **原生电脑客户端（macOS / Windows）**：
  - 本地编译打包：`pnpm install && pnpm dist:desktop:mac`（输出 `desktop/release/VeloDeck-*-mac-arm64.dmg`）或 `pnpm dist:desktop:win`（输出 `.exe` 安装包与绿色便携版）。
  - 云端自动打包：在 Fork 仓库进入 **Actions → Build Desktop App (macOS & Windows) → Run workflow**，可一键云端同时编译 macOS `.dmg` 与 Windows `.exe`（支持读取 `VELODECK_API_URL` Secret 预置默认服务器，或留空在 App 内随时填写切换）。
  - 服务端已原生信任 `Origin: app://velodeck` 与 `app://velodeck-host`，无需额外配置 `ALLOWED_ORIGINS`。
  - **双向被控（用手机或另一台电脑反控这台电脑）**：在桌面软件内切换到 **「本机被控」** 面板开启开关即可上线（可绑定同账号或使用 9 位控制码 + 无人值守密码）；macOS 首次开启按面板指引授予「屏幕录制」与「辅助功能」两项系统权限即可支持 60fps 画面与原生键鼠/中文输入。
- **iPhone / 桌面浏览器**：
  - 直接访问 `https://remote.example.com`（或 `http://203.0.113.10`）登录账号即可控制。
  - **iPhone 用户**：在 Safari 点底部「分享」→ **「添加到主屏幕」**，即可以全屏独立 App 形态使用。
- **画质建议**：默认保持 **「智能（auto）」** 档位即可根据当前网络是局域网 P2P 还是云端 TURN 自动调配分辨率、帧率与码率。

---

## 6. 日常运维：同步上游更新与升级部署

当上游仓库发布新版本（例如修复编码器或新增功能）时，按以下 3 步即可无痛升级：

### 6.1 同步上游代码到你的 Fork

在 GitHub 上打开你 Fork 的仓库，点击 **Sync fork → Update branch**；然后在你的 VPS 上拉取并重建服务端：

```bash
cd /opt/velodeck
git pull origin main
cd server

# 域名部署
docker compose up -d --build velodeck-server

# 或纯 IP 部署
docker compose -f docker-compose.ip.yml up -d --build velodeck-server
```

> **数据持久化说明**：账号、绑定设备、控制码与自动生成的 `jwt.secret` 均保存在 `server/data/` 挂载卷中，重建镜像与更新代码不会丢失任何数据。

### 6.2 发布新版专属 Android APK

1. 在你 Fork 仓库的 GitHub Actions 再次点击 **Run workflow**（或本地运行 `./gradlew assembleRelease`）生成新版 APK。
2. 将新 APK 覆盖上传到 `/opt/velodeck/server/downloads/velodeck-agent.apk`。
3. 在手机 VeloDeck App 点击 **「应用更新 → 立即更新」** 即可完成升级（覆盖安装后记得在手机上重新点一次录屏授权）。

---

## 7. 常见问题排查（Troubleshooting）

### Q1：网页能看到手机在线，但一直连不上画面或回退到低帧率 WS？
1. 检查云厂商**安全组**与服务器 `ufw` 是否同时放行了 `3478/UDP`、`3478/TCP` 和 `49152-65535/UDP`。
2. 检查 `server/.env` 中 `PUBLIC_IP` 是否填写为服务器**真实的公网 IPv4**（云服务器网卡默认只有内网 IP，漏填 `PUBLIC_IP` 会导致 `coturn` 向客户端下发内网地址）。
3. 查看 `coturn` 日志确认无报错：`docker logs --tail 50 server-velodeck-coturn-1`（或 `docker compose logs coturn`）。

### Q2：纯 IP 部署时，手机 App 登录或检查更新报错 `CLEARTEXT communication to ... not permitted`？
- 这是因为安装的是默认 HTTPS 通用包，未将你的纯 IP 加入 `network_security_config.xml` 明文白名单。
- **解决**：使用本文第 3 节「方式 B（GitHub Actions）」或「方式 C（本地编译）」，传入 `ws://<你的IP>/ws` 和 `http://<你的IP>` 重新编译即可自动放行你的专属 IP。

### Q3：如何新增第二个用户，或禁止任何人再注册？
- 在 `server/.env` 中修改 `REGISTRATION_MODE`：
  - `first-user-then-invite`（默认）：首个用户开放注册，之后需凭 `REGISTRATION_INVITE_CODE` 注册（留空即彻底禁止他人注册）。
  - `closed`：完全关闭注册入口。
  - `invite`：所有注册均需邀请码。
- 修改 `.env` 后重启服务容器生效：`docker compose up -d velodeck-server`（纯 IP 加 `-f docker-compose.ip.yml`）。

### Q4：为什么覆盖升级 APK 后网页端提示需要重新授权录屏？
- 这是 Android 系统安全策略：应用进程被安装替换重启后，`MediaProjection` 令牌会自动失效。只需在手机 App 里重新点一次「屏幕共享」确认即可恢复 60fps WebRTC。

### Q5：如何确认我 Fork 的公开仓库没有泄露敏感信息？
推送代码前执行一次自查：

```bash
git status
# 确认输出中不包含 server/.env、android-agent/local.properties、android-agent/keystore.properties、*.jks、*.apk
```
