# 鲸聊（dsh-wechat-chat + 安卓 App）

[English](README.en.md) | [中文](README.md)

> 仓库：<https://github.com/wugaixu/dsh-wechat-chat> · 版本 **1.3** · 协议 MIT

把电脑上的 DeepSeek Harness Web 变成「微信聊天」：手机装一个微信风的安卓 App「鲸聊」，
扫码配对后像微信一样给电脑上的智能体发文字消息；消息落在电脑 Web UI 的
**真实会话**里（侧栏可见），回答由电脑正常请求 API 生成后推回手机。

## 原理

鲸聊插件**自带完整连接方案**（从 `@linxin666/dsh-remote-web-ui` 移植的同一套机制），
不再依赖任何全家桶插件（远程访问与桌面启动器已按 id 禁用）：

```
手机 App (WebView 微信风聊天页 /wechat)
   │  扫码：二维码内容 = <base>/wechat?pair=<一次性令牌>
   │        /wechat 校验令牌 → 下发设备 cookie whale_pair（1 年）→ 进入聊天
   ▼
已配对设备（cookie/头/查询参数）→ 本插件 /api/wechat/* 门控路由
   │
   ├─ state     会话状态 + 历史 + 头像/昵称
   ├─ send      把文字作为用户消息投进电脑上的真实会话（ctx.sessionController.prompt）
   ├─ events    SSE 推送：正在思考 / 正在使用工具 / 最终回答 / 错误
   └─ cancel    停止当前回合
```

- 电脑端配对入口：**官方 Web UI 侧栏底部的鲸鱼图标**（与设置按钮同排，点击打开配对面板），
  也可直接打开 `http://127.0.0.1:3080/whale-panel`（仅限本机）——生成二维码、
  复制链接、刷新、断开全部设备，并显示公网隧道状态。二维码默认指向**免费公网隧道**
  （Cloudflare quick tunnel，无需账号、不花钱、`cloudflared` 二进制随包分发）；
  隧道未就绪时回落到第一块局域网网卡地址；也可配置 `publicBaseUrl` 使用自备隧道。
- 安全模型与原远程插件一致：一次性令牌（10 分钟）、设备会话持久化
  （`$DSH_HOME/whale-devices.json`，30 天闲置失效、上限 4 台、FIFO 淘汰）、
  配对控制端点仅限回环、非回环的聊天接口必须携带存活设备凭据。
- 手机**不实现**任何 harness 聊天协议，只是一个遥控器。
- 每台配对设备一个持久会话（`$DSH_HOME/wechat-chat-devices.json` 记录映射），
  会话名默认「鲸聊 · 手机」，在电脑官方侧栏可见、可点开查看。

## 文件结构

```
dsh-wechat-chat/
├─ plugin/                       # DSH cordis host 插件（可独立安装）
│  ├─ package.json / cordis.patch.yml
│  ├─ verify-release.mjs         # 发布自检：npm pack + 干净安装 + 导入 host 模块
│  └─ lib/
│     ├─ index.js                # 路由 + 会话驱动 + 配对/门控/公网隧道 + 语音上传
│     ├─ stt.js                  # whisper.cpp 固定下载、校验、安装与离线转写
│     ├─ chat-page.html          # 微信风聊天页（单文件）
│     ├─ panel-page.html         # 电脑端配对面板（二维码）
│     ├─ client.js               # client 半区（官方侧栏底部入口）
│     └─ qrcode.js               # 内置 qrcode-generator（MIT）
├─ app/                          # 安卓工程（录制 WAV 并上传到电脑离线转写）
│  ├─ settings.gradle / build.gradle / gradle.properties
│  └─ app/
│     ├─ build.gradle            # applicationId com.dsh.wechat · versionName 1.3
│     └─ src/main/               # MainActivity.java / 布局 / firstrun.html / 图标 / 清单
├─ sdk-fetch.mjs                 # 手动拉取 Android SDK 包（绕开 sdkmanager 网络问题）
├─ toolchain-setup.ps1           # 工具链解压/安装脚本
├─ 鲸聊-v1.3.apk                 # 已编译成品（直接安装到手机）
├─ README.md / README.en.md / LICENSE / .gitignore
```

工具链（已就位）：`C:\Users\Administrator\.dsh\android-toolchain\`
（JDK 17 / Gradle 8.14.2 / Android SDK：platform-tools、platforms;android-35、
build-tools;35.0.0）。

## 部署步骤

### 安装插件

**方式 A — 从 GitHub 安装（无需 npm 发布）**

```bash
dsh plugin --profile web add github:wugaixu/dsh-wechat-chat
```

**方式 B — 本地目录安装**

把本仓库 `plugin/` 目录拷到 `$DSH_HOME/profiles/web/user-patches/dsh-wechat-chat/`，然后在
`profiles/web/package.json` 加依赖 `"dsh-wechat-chat": "file:./user-patches/dsh-wechat-chat"`，
并在 `profiles/web/cordis.patch.yml` 里注册：

```yaml
- insert:
    - id: wechat-chat
      name: dsh-wechat-chat
      config:
        autoTunnel: true
        model: deepseek-v4-flash
        reasoningEffort: low
```

> ⚠️ 与 `@linxin666/dsh-remote-web-ui` 同源：本插件自带完整的扫码配对 + 门控 + 公网隧道。
> 若你也在用那套「全家桶」插件，请先在 `cordis.patch.yml` 里禁用 `web-ui-remote-web-ui`
> 与 `web-ui-desktop-launcher`，避免功能/端口冲突。

**重启并验证**（插件随 profile 应用加载）：

```
C:\Users\Administrator\.dsh\launcher\stop-dsh-web.ps1
C:\Users\Administrator\.dsh\launcher\start-dsh-web.cmd   （或托盘重启）
```

- 电脑浏览器打开 `http://127.0.0.1:3080/whale-panel` 能看到配对二维码面板；
- 在面板的「公网登录密码」区域输入两次新密码并保存，可随时设置或更换，立即生效；
- 打开 `http://127.0.0.1:3080/wechat` 能看到微信风聊天页。

### 构建 / 安装 APK

1. **构建**（JDK 17 + Gradle 8.14.2 + Android SDK；`local.properties` 里的 `sdk.dir`
   指向你的 SDK）：
   ```powershell
   gradle.bat -p app assembleDebug --no-daemon
   ```
   产物：`app/app/build/outputs/apk/debug/app-debug.apk`。
2. **安装**：直接把仓库里的 `鲸聊-v1.3.apk` 拷到手机安装（需允许未知来源），或
   `adb install 鲸聊-v1.3.apk`。
3. **使用**：电脑端「远程访问」面板生成二维码 → 手机 App 首次启动点「扫一扫连接」扫码 →
   自动配对进入聊天。以后打开 App 直接进聊天。

## 配置项

插件 `cordis.patch.yml` 里的 `config`（均为可选）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `nickname` | `鲸聊助手` | 手机聊天页顶部昵称 |
| `title` | `鲸聊 · 手机` | 电脑侧栏里的会话名 |
| `provider` | `deepseek-official` | 模型提供方 |
| `model` | `deepseek-v4-flash` | 模型 |
| `reasoningEffort` | `low` | 推理强度 |
| `autoTunnel` | `true` | 自动开免费 Cloudflare quick tunnel |
| `tunnelPassword` | 空 | 仅用于旧配置首次迁移；迁移后必须从 YAML 删除，推荐直接在本机面板设置 |
| `publicBaseUrl` | 无 | 自备公网地址（不经过内置密码网关） |
| `tokenTtlMs` | `600000` | 配对令牌有效期（毫秒） |
| `idleExpireMs` | `2592000000` | 设备闲置失效（30 天） |
| `maxDevices` | `4` | 最大配对设备数 |
| `stt.language` | `zh` | 本地转写语言，可选 `zh` / `en` / `auto` |
| `stt.threads` | `8` | whisper.cpp CPU 线程数（1–12） |
| `stt.timeoutMs` | `120000` | 单次本地转写超时（30–300 秒） |

**头像 / 背景**：手机 App 内点头像即可修改（或把图片放到 `$DSH_HOME/wechat-chat/avatars/`：
`other.*` 对方头像、`me.*` 自己头像、`background.*` 聊天背景）。
**界面样式**：改 `plugin/lib/chat-page.html` 内的 CSS（改动后刷新页面即可，无需重启）。

## 免费本地语音输入

在本机配对面板点击「安装离线模型」（首次约下载 496 MB）。手机按住录音后会把最多 60 秒的 PCM WAV 通过已认证隧道上传到电脑，由固定版本的 whisper.cpp multilingual small 模型离线转写。文字先进入输入框，确认或修改后才会发送到真实 DSH 会话。

录音不会发送给讯飞或其他第三方，不需要 API Key；临时 WAV 与输出在转写完成或失败后删除。运行库与模型均固定 URL、大小和 SHA-256，安装接口仅允许本机访问。详见 [`docs/local-voice.md`](docs/local-voice.md)。

## 注意事项

- 使用 `file:` / `link:` 本地安装时，请先在插件源码目录执行 `npm install`，否则真实路径下可能缺少 `cloudflared` 依赖；GitHub/npm 安装不受影响。
- 本插件与 `@linxin666/dsh-remote-web-ui` 功能重叠时，应禁用对方的远程访问与桌面启动器条目，避免冲突。
- 公网密码在仅限本机的 `/whale-panel` 管理，不依赖官方设置页的第三方 namespace allowlist；无需手改 `settings.yaml`。

## 已知限制

- 纯文本：手机端只发/收文本；代码块、markdown 以纯文本展示。
- 一次一条：上一轮回合未结束时发送会被拒绝（409），回合可用右上状态判断；
  取消按钮暂未在 UI 暴露（接口 `/api/wechat/cancel` 已实现）。
- 免费公网隧道每次重启 dsh web 会换地址（trycloudflare 快隧道的特性）：换地址后
  手机 App 重新扫一次码即可（扫码同时更新服务器地址并配对）；局域网内使用不受影响。
- 隧道只拿到地址还不够：插件会从公网侧自检该地址（访问登录页），**自检通过后才允许生成二维码**，
  避免手机扫到 Cloudflare 1033 错误页。自检连续失败 3 次会自动重建隧道；期间面板显示「正在自检连通性」。
- 局域网纯 HTTP 下安装/使用均正常（App 已允许明文流量）；语音上传仍要求 HTTPS 抗窃听。

## 开发与发布

```bash
cd plugin
npm run verify    # 发布自检：node 语法检查 + 干净 tarball 安装 + 导入 host 模块
```

`verify-release.mjs` 会按 `package.json` 的 `files` 白名单 `npm pack`，装进干净临时目录，
再 `import` host 模块，证明发布产物能像 DSH loader 一样解析自身；同时检查发布包不含模型、录音、密钥或构建缓存。

**发布到 GitHub**：本仓库即发布源；改完源码后 `git add -A && git commit && git push`。
`files` 白名单与 `.gitignore` 已排除 `node_modules`、`*.tgz`、`package-lock.json`、Gradle
构建产物、`local.properties` 与运行时用户数据（`avatars/`），成品 `鲸聊-v1.3.apk` 保留在仓库。

## 安全

免费 Quick Tunnel 始终先进入一个仅监听回环地址的安全网关，而不会直连整个 DSH Web。网关只放行 `/wechat`、`/api/wechat/*` 和必要的配对状态端点。密码只能通过本机配对面板设置；服务器只在 `$DSH_HOME/wechat-chat-settings.json` 保存带随机盐的 scrypt 哈希，不保存或回传明文。首次扫码需输入密码，成功后写入 30 天有效的 `HttpOnly + Secure + SameSite=Lax` 登录 Cookie；更换密码会立即令所有旧登录失效，连续 8 次失败会锁定来源 1 分钟。

配对设备即完全控制凭据（与现有远程插件同一安全模型）。停止/取消配对会立即
切断 `/remote` 通道，本插件的聊天页与接口随之不可用。四个控制面
（配对、自更新、插件管理、桌面启动器）对远程设备始终不可达。

[English](README.en.md) | [中文](README.md)
