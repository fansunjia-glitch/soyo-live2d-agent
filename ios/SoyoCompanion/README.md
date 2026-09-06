# Soyo Companion for iOS

Soyo Companion 是 `soyo-live2d-agent` 的原生 iPhone 能力端。它不是越狱或无障碍点击器，也不会绕过 iOS 沙箱。网页控制端只能提出已注册的能力请求；敏感动作必须在手机上逐次确认，iOS 自身的系统权限提示仍然有效。

## 生成工程

要求：macOS、完整 Xcode 15.2+、[XcodeGen](https://github.com/yonaskolb/XcodeGen)。

```bash
cd ios/SoyoCompanion
xcodegen generate
open SoyoCompanion.xcodeproj
```

在 Xcode 的 Signing & Capabilities 中选择自己的 Team 和唯一 Bundle Identifier，然后用真机运行。相机、位置和 ReplayKit 无法在普通单元测试或未配置的模拟器中完整验证。

## 配对

1. 服务端设置高熵 `DEVICE_CONTROL_ADMIN_TOKEN`，通过网页 `/device-control` 生成六位配对码。
2. 手机输入服务端根地址和配对码。Release 构建只接受 `https://`；Debug 构建额外允许 localhost、`.local` 和私网 IP 的 `http://` 地址。
3. `POST /api/device-control/pairings/claim` 成功后，`pairingId/deviceId/deviceToken` 使用 Keychain 的 `ThisDeviceOnly` 保护保存。
4. App 连接 `/ws/device-control/device`，首帧发送认证消息；断线后仅在仍保留本地凭据时指数退避重连。

## 协议与安全边界

- 当前协议固定为 `schemaVersion: 1`。认证首帧和所有手机上行消息都必须携带该字段；缺失或其他版本会被拒绝。
- 认证成功后，服务端发送 `device_session`，必须包含 `schemaVersion/pairingId/deviceId/approvalPolicy/controllerConnected`。手机会将两个 ID 与 Keychain 凭据逐项核对，并要求 v1 审批策略完整一致，失败即关闭连接。
- 服务端命令必须包含 `schemaVersion/id/action/params/requiresApproval/issuedAt/expiresAt/nonce`。当前服务端签发 30 秒审批 TTL；手机检查未来时钟偏差、TTL、过期时间、nonce 重放和 command id 幂等。手机在有效期内批准后，服务端仅把结果关联窗口延长到 5 分钟，命令内容和授权范围不会改变。同一 command id 只执行一次，重复投递返回缓存结果。
- `command_result` 和 `approval_result` 始终回传原命令的 `id` 与 `action`。`screen_frame` 只发送 `data:image/jpeg;base64,`，压缩 JPEG 上限为 1,250,000 字节，并在发送前再次确认完整 JSON 不超过服务端的 2,000,000 字节上限。
- 服务端的 `requiresApproval` 只能增加审批，不能取消手机能力注册表声明的审批。
- 审计日志不保存令牌、照片、坐标、剪贴板正文或朗读正文。

## 支持能力

| Action | 行为 | 本机逐次审批 |
| --- | --- | --- |
| `agent.ping` | Agent 存活探测 | 否 |
| `device.info` | 返回非敏感设备与 App 信息 | 否 |
| `device.open_url` | 打开经过 scheme 校验的 HTTP(S) URL | 是 |
| `device.copy_text` | 写入系统剪贴板 | 是 |
| `device.speak` | 使用 `AVSpeechSynthesizer` 本机朗读 | 是 |
| `device.location_once` | 仅请求一次前台位置 | 是 + 系统权限 |
| `camera.capture` | 展示系统相机并返回压缩单张照片 | 是 + 系统权限 |
| `shortcut.open` | 打开 Shortcuts URL，由系统继续确认/执行 | 是 |
| `screen_share.start` | 用户确认后启动 ReplayKit 低帧率预览 | 是 + ReplayKit 提示 |
| `screen_share.stop` | 停止本 App 的 ReplayKit 捕获 | 否 |

## 权限与平台限制

- **App Transport Security**：Release 只允许 HTTPS/WSS。`NSAllowsArbitraryLoads` 为 false；`NSAllowsLocalNetworking` 仅服务于开发环境，不能作为公网明文传输的例外。
- **相机**：每次远端请求先展示 App 内审批，首次使用还会展示 `NSCameraUsageDescription` 系统权限。只返回用户在相机界面确认的单张 JPEG。
- **位置**：只申请 When In Use，并调用一次 `requestLocation()`；不声明后台定位能力。
- **麦克风**：协议 v1 的模型输出、浏览器桥接、服务端中继和 iOS 执行层都会拒绝 `includeMicrophone: true`，`RPScreenRecorder.isMicrophoneEnabled` 固定为 false，不采集或传输麦克风音频。若未来协议版本显式支持，仍需先经本机审批，系统也会继续依据 `NSMicrophoneUsageDescription` 管理权限。
- **屏幕录制**：iOS 没有可添加到 Info.plist 的通用“屏幕录制权限键”。ReplayKit 自己显示系统级录制提示和状态。这里使用 `RPScreenRecorder.startCapture`，仅捕获系统允许本 App 获得的画面；App 进入后台后 WebSocket 可能被挂起。跨 App 的长期广播需要额外 Broadcast Upload Extension，并且必须由用户通过系统广播选择器主动开始，本工程没有伪装或绕过该流程。
- **快捷指令**：本工程只打开 `shortcuts://run-shortcut` 深链，具体快捷指令及其系统权限由用户创建和确认；不能向其他 App 注入任意触摸。

## 验证

只安装 macOS Command Line Tools、没有完整 Xcode 时，可运行语法解析、plist 和工程结构检查：

```bash
cd ios/SoyoCompanion
bash scripts/validate-static.sh
```

该脚本逐文件运行 `swiftc -parse`，不会解析 iOS SDK 模块，因此不能替代类型检查、链接、模拟器测试或真机测试。

有完整 Xcode 和 XcodeGen 时，先生成工程并完成无签名模拟器构建：

```bash
cd ios/SoyoCompanion
xcodegen generate
xcodebuild -project SoyoCompanion.xcodeproj \
  -scheme SoyoCompanion \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

查看本机已有模拟器并选择返回的 UUID 运行测试：

```bash
xcodebuild -project SoyoCompanion.xcodeproj \
  -scheme SoyoCompanion \
  -showdestinations
xcodebuild -project SoyoCompanion.xcodeproj \
  -scheme SoyoCompanion \
  -destination 'platform=iOS Simulator,id=<SIMULATOR-UUID>' test
```

至少还应在真机验证：系统权限拒绝/撤销、弱网重连、重复命令、过期命令、ReplayKit 开停、前后台切换，以及照片和画面帧是否始终低于服务端消息上限。
