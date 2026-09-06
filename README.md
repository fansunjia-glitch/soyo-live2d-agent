# Soyo Live2D Agent

一个面向桌面浏览器、移动浏览器与 iPhone 伴侣端的实时 Soyo Agent。系统把多轮对话、实时语音、Live2D 演出、相机输入和经用户授权的 iPhone 能力统一到一条可打断、可审计的事件链中。

> 浏览器不能绕过 iOS 沙箱去“反控制”整台手机。本项目采用原生 iOS Companion：网页只能请求明确注册的能力，打开链接、剪贴板、位置、相机、快捷指令和屏幕共享等敏感动作仍需在 iPhone 上逐次确认，也不会模拟任意触摸。

## 已实现能力

- React + PixiJS Live2D 舞台，支持 Cubism 2 `model.json` 与 Cubism 4 `*.model3.json`，按模型格式只加载对应 runtime。
- `Live2DAdapter`、模型能力探测与 Soyo rig profile：Cubism 2/4 参数兼容、动作/表情 fallback、重复动作变体、头部/身体触摸回退区域。
- `PerformancePlan v2`：主次情绪、强度、视线和句内 gesture/expression/gaze/scene/prop cue；前后端都严格校验。
- `ConversationOrchestrator`：turnId 隔离、超时、取消、旧响应丢弃、语音打断和完整 phase 状态机。
- Web Audio RMS 口型：真实播放能量驱动嘴型，带噪声门、attack/release；字幕和 cue 使用同一音频时钟。
- 四套舞台主题、portrait/bust/full-body/OBS 构图、状态氛围、音量反馈、移动端安全区与 reduced-motion。
- Paraformer 实时 ASR、Qwen 图文对话、CosyVoice 双音色 TTS、持久会话摘要。
- 关系记忆：会话级 scope、来源与置信度、可衰减情绪、用户专属称呼/边界控制，以及严格的模型补丁校验。
- 隐私优先的感知门：默认关闭，三次语义确认、去重与冷却；屏幕帧只有再次显式授权后才可单请求送入视觉模型，且不落盘。
- iPhone Device Hub：短码配对、SQLite 持久化、能力协商、命令 TTL/nonce/幂等、审计、吊销和 WebSocket 中继。
- 原生 SwiftUI `SoyoCompanion`：Keychain 凭据、HTTPS/WSS 边界、逐次审批、相机、一次性位置、朗读、复制、打开 URL、快捷指令和 ReplayKit 预览。
- 模型诊断 CLI、前后端契约测试、Live2D runtime 单测和 iOS 静态校验。

商业模型、声音和 Cubism SDK/Core 不会复制进仓库；部署者必须提供有权使用的资源。

## 架构

```text
麦克风 ──PCM/WebSocket──> Paraformer ASR
                               │
文字/照片/记忆 ───────────────> Qwen Agent ──> PerformancePlan v2
                                                │
回复文本 ─────────────────────> CosyVoice TTS ──┼──> SpeechPlayer/Audio Clock
                                                │            │
触摸/状态/感知事件 ────────────────────────────> Director ───> Live2D Adapter

网页控制台 ──短码配对/命令──> Device Hub ──WSS──> iPhone Companion
                                  │                 └─ 本机审批 + iOS 系统权限
                                  └─ SQLite pairing/audit
```

主要边界：

- `src/conversation/` 管理对话轮次和可取消任务。
- `src/audio/` 负责音频生命周期、时钟与能量采样。
- `src/performance/` 验证 v2 演出计划并精确调度 cue。
- `src/live2d/` 负责模型加载、能力探测、适配和演出导演。
- `backend/app/performance.py` 是后端规范化与严格契约边界。
- `backend/app/device_hub.py` 与 `device_store.py` 是手机控制平面。
- `ios/SoyoCompanion/` 是受 iOS 沙箱约束的原生能力端。

详细协议与验收标准见 [docs/live2d-performance-architecture.md](docs/live2d-performance-architecture.md)。

## 快速启动

要求 Node.js 20+ 与 Python 3.11+。

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r backend/requirements.txt
cp .env.example .env
```

在 `.env` 至少填写 API key，并生成独立的访问口令：

```env
DASHSCOPE_API_KEY=你的百炼_API_Key
AGENT_ACCESS_TOKEN=高强度随机口令
```

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

会话、聊天、TTS 与 ASR 即使在 localhost 也采用 fail-closed 鉴权；没有配置 `AGENT_ACCESS_TOKEN` 时这些接口不会放行。

准备你有权使用的 Live2D 模型。个人本地测试也可运行：

```bash
node scripts/download-soyo-bestdori.mjs
npm run live2d:inspect -- public/models/soyo/bestdori/model.json
```

启动前后端：

```bash
npm run dev
```

- Web：`http://localhost:5173`
- API：`http://localhost:8787`
- 健康检查：`/health/live`、`/health/ready`

Vite 会把 `/api` 和 `/ws` 代理到 FastAPI。`npm run dev` 只监听 `127.0.0.1`。需要同一局域网的 iPhone 访问时，在 `CORS_ORIGINS` 加入电脑的实际前端地址后使用 `npm run dev:lan`；该命令会在缺少强访问口令时拒绝启动。麦克风、相机和生产环境 Device Hub 应通过 HTTPS/WSS。

## Live2D 模型与舞台

默认入口是：

```text
public/models/soyo/bestdori/model.json
```

也可以在角色控制台或 `LIVE2D_MODEL_PATH` 中指定 Cubism 4 的 `*.model3.json`。运行时选择规则：

- `*.model3.json`：加载 Cubism 4 Core 与 `pixi-live2d-display/cubism4`。
- 其他模型 JSON：加载 Cubism 2 runtime 与 `pixi-live2d-display/cubism2`。

生产环境建议自托管并锁定 runtime 版本：

```env
VITE_CUBISM2_RUNTIME_URL=https://你的域名/live2d.min.js
VITE_CUBISM4_RUNTIME_URL=https://你的域名/live2dcubismcore.min.js
```

部署前诊断模型：

```bash
npm run live2d:inspect -- path/to/model.json --strict
npm run live2d:inspect -- path/to/avatar.model3.json --strict
```

诊断会检查 runtime 类型、贴图/动作/表情/物理引用、hit area 和常用参数。二进制 `.moc/.moc3` 无法离线枚举全部参数，因此未发现某个参数表示需要核对 rig，不等于模型一定缺失。

## PerformancePlan v2

`POST /api/chat` 仍返回兼容字段 `reply`、`emotion`、`action`、`ttsInstruction`，同时返回完整 `performance`：

```json
{
  "schemaVersion": 2,
  "turnId": "turn-001",
  "reply": "嗯，我明白了。",
  "ttsInstruction": "轻柔、稍慢。",
  "affect": {
    "primary": "worried",
    "secondary": "shy",
    "intensity": 0.68,
    "secondaryWeight": 0.2,
    "arousal": 0.32
  },
  "defaultGaze": "user",
  "cues": [
    {
      "cueId": "opening-nod",
      "channel": "gesture",
      "anchor": { "kind": "speech", "event": "start", "offsetMs": 0 },
      "action": "nod",
      "intensity": 0.55,
      "durationMs": 900,
      "priority": "speech"
    }
  ]
}
```

未知字段、越界强度、错误 channel payload 和非法资源 ID 会在契约边界拒绝；旧四字段回复会整体归一化为安全的 v2 fallback。

## iPhone Agent

### 1. 启用服务端

生成高熵管理员令牌并写入后端环境：

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

```env
DEVICE_CONTROL_ADMIN_TOKEN=上一步生成的令牌
AGENT_ACCESS_TOKEN=另一个独立的高熵令牌
DEVICE_SESSION_TTL_SECONDS=2592000
DEVICE_STORE_PATH=backend/data/devices.sqlite3
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://你的电脑局域网IP:5173
```

以 `npm run dev:lan` 启动后打开 `http://你的电脑局域网IP:5173/device-control`。管理员令牌只用来创建配对；浏览器获得独立 controller token，手机获得独立 device token，服务端仅持久化凭据摘要。配对后的 Agent 可在模型工具循环中请求已声明能力，但高风险动作仍由手机逐次确认。

### 2. 构建 iOS Companion

需要完整 Xcode 15.2+ 和 XcodeGen：

```bash
cd ios/SoyoCompanion
xcodegen generate
open SoyoCompanion.xcodeproj
```

选择自己的 Team 和唯一 Bundle Identifier 后在真机运行，输入服务端地址与网页生成的六位配对码。更多平台边界、权限和验证方法见 [ios/SoyoCompanion/README.md](ios/SoyoCompanion/README.md)。

支持动作：

| Action | 功能 | 手机确认 |
| --- | --- | --- |
| `agent.ping` / `device.info` | 存活与非敏感设备信息 | 否 |
| `device.open_url` | 打开 HTTP(S) 链接 | 是 |
| `device.copy_text` | 写入剪贴板 | 是 |
| `device.speak` | 本机朗读 | 是 |
| `device.location_once` | 一次性前台位置 | 是 + 系统权限 |
| `camera.capture` | 单张确认后的压缩照片 | 是 + 系统权限 |
| `shortcut.open` | 打开指定快捷指令 | 是 |
| `screen_share.start/stop` | ReplayKit 低帧率预览 | 开始时确认 |

ReplayKit v1 只转发限速 JPEG 画面，明确拒绝麦克风采集。主界面的“语义感知”和“单帧视觉升级”是两个独立开关，均默认关闭；原始帧不会进入关系记忆或会话 JSON。

## Soyo 双音色

后端支持两个可选克隆音色：

```env
TTS_VOICE_SOYO_SOFT=
TTS_VOICE_SOYO_NATURAL=
```

`happy`、`shy`、`surprised` 默认选择 soft，其余选择 natural。准备并检查两段有权使用的样本：

```bash
npm run voice:prepare -- --input path/to/soft.wav --output voice-samples/prepared/soyo-soft.wav --duration 20
npm run voice:prepare -- --input path/to/natural.wav --output voice-samples/prepared/soyo-natural.wav --duration 20
npm run voice:inspect -- --input voice-samples/prepared/soyo-soft.wav
npm run voice:inspect -- --input voice-samples/prepared/soyo-natural.wav
```

用可访问的 HTTPS 音频 URL 创建音色：

```bash
npm run voice:clone:soyo -- \
  --soft-url https://example.com/soyo-soft.wav \
  --natural-url https://example.com/soyo-natural.wav
```

只使用获得明确授权的角色、真人或声优音频，不公开发布仿冒音色。

## 配置安全

模型 override 只能命中服务端 allowlist：

```env
LLM_MODEL=qwen3.6-flash
LLM_ALLOWED_MODELS=qwen3.6-flash
ASR_MODEL=paraformer-realtime-v2
ASR_ALLOWED_MODELS=paraformer-realtime-v2
TTS_MODEL=cosyvoice-v3.5-flash
TTS_ALLOWED_MODELS=cosyvoice-v3.5-flash
```

密钥、会话、配对凭据、声音样本和第三方模型均被排除在 Git 之外。生产部署还应：

- 必须配置高熵 `AGENT_ACCESS_TOKEN`；所有非 localhost 启动脚本都会先检查它。
- 只配置实际前端域名到 `CORS_ORIGINS`。
- 使用 HTTPS/WSS，并把 `backend/data` 放到有备份和访问控制的持久卷。
- 单进程可直接使用当前 Device Hub；多 worker/多实例时需要把在线 socket 路由迁移到 Redis/pub-sub。
- 为多用户场景增加真实身份与租户隔离；controller token 不是账号系统。

## 验证

```bash
npm run lint
npm test
npm run check
npm run build
npm run test:backend
npm run test:ios:static   # macOS：Swift 语法、plist 与 XcodeGen 配置静态检查
npm run verify
```

如果依赖安装在项目 `.venv`，先执行 `source .venv/bin/activate`。iOS 静态校验与完整 Xcode 验证见 Companion README。

## 部署

前端构建时设置：

```env
VITE_API_BASE_URL=https://api.example.com
VITE_WS_BASE_URL=wss://api.example.com
```

```bash
npm run build
npm run start:backend
```

对外监听前必须配置 `AGENT_ACCESS_TOKEN`；推荐使用 `npm run start:backend`，它会先执行安全检查。

Nginx/网关必须同时转发 `/api/` 和 WebSocket `/ws/`。Linux 单机部署也可以使用：

```bash
SOYO_BRANCH=codex/comprehensive-soyo-agent ./scripts/restart-server.sh
```

脚本会拉取指定分支、安装变更依赖、重启服务并执行健康检查；日志位于 `backend/data/soyo.log`。

## 仓库不包含

- `.env`、`backend/.env`
- `backend/data/`
- `.voice-clone*.json`、`voice-samples/`、`voice-tests/`
- `public/models/soyo/bestdori/`
- `dist/` 与部署压缩包

这些边界用于避免泄露密钥、设备凭据和私人数据，也避免重新分发未经授权的模型或声音资源。
