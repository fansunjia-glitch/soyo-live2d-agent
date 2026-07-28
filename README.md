# Soyo Live2D Agent

一个面向网页和移动端的实时语音 Live2D 对话原型。项目现在拆分为：

- 前端：Vite + React + PixiJS + pixi-live2d-display，构建后是纯静态资源。
- 后端：Python FastAPI，代理阿里云百炼 Qwen LLM、Paraformer ASR 和 CosyVoice TTS。

云端密钥只由后端读取，不会进入前端 bundle。

## 快速启动

1. 安装依赖：

```bash
npm install
python3 -m pip install -r backend/requirements.txt
```

2. 创建本地环境变量文件：

```bash
cp .env.example .env
```

3. 编辑 `.env`，至少填写：

```env
DASHSCOPE_API_KEY=你的百炼 API Key
```

4. 准备 Live2D 资源。

公开仓库不包含第三方 Live2D 模型文件。你可以放入自己有授权的模型资源，或仅用于个人本地测试时运行：

```bash
node scripts/download-soyo-bestdori.mjs
```

默认模型路径是：

```text
public/models/soyo/bestdori/model.json
```

5. 同时启动前后端：

```bash
npm run dev
```

本地地址：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:8787`

也可以分开启动：

```bash
npm run dev:backend
npm run dev:frontend
```

Vite 开发服务器会把 `/api` 和 `/ws` 代理到 FastAPI，所以本地前端的 `VITE_API_BASE_URL` / `VITE_WS_BASE_URL` 可以留空。

## 公开仓库说明

为了避免泄露密钥和分发未授权素材，仓库不会同步以下本地文件：

- `.env`、`backend/.env`：本地 API Key 和环境变量。
- `.voice-clone*.json`：音色克隆结果、voice id 和请求元数据。
- `voice-samples/`、`voice-tests/`、`public/voice-samples/`：本地语音样本和测试音频。
- `public/models/soyo/bestdori/`：第三方 Live2D 模型资源。
- `dist/`、`deploy/*.tar.gz`：构建产物和发布包。

## 架构

1. 浏览器端
   - 麦克风音频转为 16 kHz PCM，通过 WebSocket 发到后端 `/ws/asr`。
   - React UI 负责会话、状态、移动端布局和音频播放。
   - Live2D 默认加载 `/models/soyo/bestdori/model.json`。

2. FastAPI 后端
   - `GET /api/config`：返回模型、音色和 Live2D 配置。
   - `GET/POST/PUT/DELETE /api/sessions`：读写后端 JSON 会话历史。
   - `POST /api/chat`：调用支持图文输入的 `qwen3.6-flash`，返回 Live2D 表情、动作和 TTS 指令。
   - 手机端可通过输入栏的相机按钮拍照；照片在浏览器内压缩后随本轮请求发送，不写入会话历史。
   - 会话消息超过 20 条时，额外调用一次 LLM 生成长期记忆摘要，将摘要追加到角色 system prompt，并清空已压缩的消息列表。
   - `POST /api/tts`：调用 CosyVoice WebSocket，返回 MP3。
   - `WS /ws/asr`：代理 Paraformer 实时 ASR WebSocket。

3. 表情动作协议
   - LLM 返回 JSON：`reply`、`emotion`、`action`、`ttsInstruction`。
   - 前端将 `emotion` 映射到表情，将 `action` 映射到 motion。
   - 映射表在 `src/live2d/live2dMaps.ts`。

## 本地开发

安装前端依赖：

```bash
npm install
```

安装后端依赖：

```bash
python3 -m pip install -r backend/requirements.txt
```

创建环境文件：

```bash
cp .env.example .env
```

编辑 `.env`，至少填写：

```env
DASHSCOPE_API_KEY=你的百炼 API Key
```

启动前后端：

```bash
npm run dev
```

本地地址：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:8787`

Vite 开发服务器会把 `/api` 和 `/ws` 代理到 FastAPI，所以本地前端的 `VITE_API_BASE_URL` / `VITE_WS_BASE_URL` 可以留空。

手机访问时，使用同一局域网电脑 IP，例如 `http://192.168.x.x:5173`。移动浏览器通常要求 HTTPS 才允许麦克风权限，正式测试建议给前端和后端都配置 HTTPS。

相机按钮使用移动端文件拍摄入口，可在 HTTP 页面由用户主动点击拍照。它只读取用户确认后的单张照片，不会持续访问摄像头；具体表现由手机浏览器决定，部分设备会同时提供相册选择。

## 分别部署

### 后端

在服务器上安装 Python 依赖：

```bash
python3 -m pip install -r backend/requirements.txt
```

设置后端环境变量：

```env
DASHSCOPE_API_KEY=你的百炼 API Key
DASHSCOPE_WORKSPACE_ID=
LLM_MODEL=qwen3.6-flash
ASR_MODEL=paraformer-realtime-v2
TTS_MODEL=cosyvoice-v3.5-flash
TTS_VOICE=longxiaochun
TTS_VOICE_SOYO_SOFT=
TTS_VOICE_SOYO_NATURAL=
LIVE2D_MODEL_PATH=/models/soyo/bestdori/model.json
CORS_ORIGINS=https://你的前端域名
CONVERSATION_STORE_PATH=backend/data/conversations.json
PORT=8787
```

启动：

```bash
python3 -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8787
```

如果用 Nginx 反代，确保同时转发 HTTP API 和 WebSocket：

```nginx
location /api/ {
  proxy_pass http://127.0.0.1:8787;
}

location /ws/ {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

会话历史默认写入 `backend/data/conversations.json`，该目录已被 `.gitignore` 忽略。生产部署时建议把 `CONVERSATION_STORE_PATH` 指向持久化磁盘路径，例如 `/var/lib/soyo/conversations.json`。

### 前端

前端构建时配置后端地址：

```env
VITE_API_BASE_URL=https://你的后端域名
VITE_WS_BASE_URL=wss://你的后端域名
```

构建静态资源：

```bash
npm run build
```

把 `dist/` 部署到任意静态站点、Nginx、OSS/CDN 或前端托管平台。`public/models/` 会随 Vite 构建复制到 `dist/models/`。

## Soyo 双音色

当前后端支持两个 Soyo 音色：

- `TTS_VOICE_SOYO_SOFT`：`soyo夹`
- `TTS_VOICE_SOYO_NATURAL`：`soyo不夹`

后端会根据 LLM 返回的 `emotion` 选择音色：

- `happy`、`shy`、`surprised` 使用 soft。
- 其他情绪使用 natural。

`POST /api/tts` 会返回响应头 `X-Soyo-TTS-Voice`，可用来验证实际命中的 voice id。

准备两段 20 秒样本：

```bash
npm run voice:prepare -- \
  --input "$HOME/Downloads/Soyo干声素材/soyo夹.WAV" \
  --output voice-samples/prepared/soyo-soft.wav \
  --duration 20

npm run voice:prepare -- \
  --input "$HOME/Downloads/Soyo干声素材/soyo不夹.WAV" \
  --output voice-samples/prepared/soyo-natural.wav \
  --duration 20
```

检查样本：

```bash
npm run voice:inspect -- --input voice-samples/prepared/soyo-soft.wav
npm run voice:inspect -- --input voice-samples/prepared/soyo-natural.wav
```

用公网 URL 创建两个阿里云音色：

```bash
npm run voice:clone:soyo -- \
  --soft-url https://example.com/voice-samples/soyo-soft.wav \
  --natural-url https://example.com/voice-samples/soyo-natural.wav
```

成功后脚本会更新 `.env` 的 `TTS_VOICE_SOYO_SOFT` 和 `TTS_VOICE_SOYO_NATURAL`。重启 FastAPI 后端即可生效。

> 只使用你有权使用的音频样本。不要抓取或复刻未经授权的真人、声优或版权角色音频，也不要公开发布仿冒特定真人的生成音频。

## 常用命令

```bash
npm run dev                 # 同时启动 FastAPI 后端和 Vite 前端
npm run dev:backend         # 只启动 FastAPI 后端
npm run dev:frontend        # 只启动 Vite 前端
npm run build               # 构建前端静态资源
npm run check               # TypeScript 检查
npm run voice:doctor        # 检查音色复刻环境
npm run voice:test          # 用当前 TTS 配置生成测试 MP3
```

## Live2D 模型

默认支持 `scripts/download-soyo-bestdori.mjs` 下载 Bestdori 上的 Soyo 资源并转换为 Cubism2 `model.json`：

```bash
node scripts/download-soyo-bestdori.mjs
```

资源会写入：

```text
public/models/soyo/bestdori/
```

这些角色资源来自第三方资源站公开 URL，只建议个人本地测试，不要再分发。若你拥有授权的其他 Soyo Cubism 模型，也可以放到 `public/models/soyo/` 并修改 `LIVE2D_MODEL_PATH` 或前端设置面板里的模型路径。
