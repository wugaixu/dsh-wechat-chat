# 鲸聊（dsh-wechat-chat + 安卓 App）

[English](README.en.md) | [中文](README.md)

> 仓库：<https://github.com/wugaixu/dsh-wechat-chat> · 版本 **1.1** · 协议 MIT

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
│  ├─ package.json
│  ├─ verify-release.mjs         # 发布自检：npm pack + 干净安装 + 导入 host 模块
│  └─ lib/
│     ├─ index.js                # 路由 + 会话驱动 + 配对/门控/公网隧道 + 轮询推送
│     ├─ chat-page.html          # 微信风聊天页（单文件）
│     ├─ panel-page.html         # 电脑端配对面板（二维码）
│     ├─ client.js               # client 半区（官方侧栏底部入口）
│     └─ qrcode.js               # 内置 qrcode-generator（MIT）
├─ app/                          # 安卓工程（WebView 壳 + ZXing 扫码 + UCrop + 系统语音识别）
│  ├─ settings.gradle / build.gradle / gradle.properties
│  └─ app/
│     ├─ build.gradle            # applicationId com.dsh.wechat · versionName 1.1
│     └─ src/main/               # MainActivity.java / 布局 / firstrun.html / 图标 / 清单
├─ sdk-fetch.mjs                 # 手动拉取 Android SDK 包（绕开 sdkmanager 网络问题）
├─ toolchain-setup.ps1           # 工具链解压/安装脚本
├─ 鲸聊-v1.1.apk                 # 已编译成品（直接安装到手机）
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
- 打开 `http://127.0.0.1:3080/wechat` 能看到微信风聊天页。

### 构建 / 安装 APK

1. **构建**（JDK 17 + Gradle 8.14.2 + Android SDK；`local.properties` 里的 `sdk.dir`
   指向你的 SDK）：
   ```powershell
   gradle.bat -p app assembleDebug --no-daemon
   ```
   产物：`app/app/build/outputs/apk/debug/app-debug.apk`。
2. **安装**：直接把仓库里的 `鲸聊-v1.1.apk` 拷到手机安装（需允许未知来源），或
   `adb install 鲸聊-v1.1.apk`。
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
| `publicBaseUrl` | 无 | 自备公网地址（优先于隧道） |
| `tokenTtlMs` | `600000` | 配对令牌有效期（毫秒） |
| `idleExpireMs` | `2592000000` | 设备闲置失效（30 天） |
| `maxDevices` | `4` | 最大配对设备数 |

**头像 / 背景**：手机 App 内点头像即可修改（或把图片放到 `$DSH_HOME/wechat-chat/avatars/`：
`other.*` 对方头像、`me.*` 自己头像、`background.*` 聊天背景）。
**界面样式**：改 `plugin/lib/chat-page.html` 内的 CSS（改动后刷新页面即可，无需重启）。
**语音输入**：使用讯飞语音听写，密钥需填到 `app/app/secrets.properties`（本地、不提交）；
申请与配置步骤见 [`docs/iflytek-voice.md`](docs/iflytek-voice.md)。

## 语音识别开通指南（别人 clone 后必看）

> 除语音识别外，插件、安卓壳、扫码配对、聊天等**全部功能 clone 下来就能用**。
> 只有语音识别需要每个人各自的讯飞免费密钥（不随仓库分发）。

**三步开通：**

1. **注册并创建应用**：打开 <https://console.xfyun.cn/> → 登录 → 创建应用（平台选 Android）。
2. **开通「语音听写（流式版）」**：在应用里点开通（免费，默认每日 500 次）。
3. **填密钥**：复制 `app/app/secrets.properties.example` → `app/app/secrets.properties`，填入三个值。

⚠️ **顺序别搞反**：控制台顺序是 `APPID / APISecret / APIKey`（APIKey 是 32 位 hex，APISecret 是 base64），搞反了会报 `401 apikey not found`。

填完重新 `assembleDebug` 即可。完整踩坑记录与错误码见 [`docs/iflytek-voice.md`](docs/iflytek-voice.md)。

## 已知限制

- 纯文本：手机端只发/收文本；代码块、markdown 以纯文本展示。
- 一次一条：上一轮回合未结束时发送会被拒绝（409），回合可用右上状态判断；
  取消按钮暂未在 UI 暴露（接口 `/api/wechat/cancel` 已实现）。
- 免费公网隧道每次重启 dsh web 会换地址（trycloudflare 快隧道的特性）：换地址后
  手机 App 重新扫一次码即可（扫码同时更新服务器地址并配对）；局域网内使用不受影响。
- 局域网纯 HTTP 下安装/使用均正常（App 已允许明文流量）。

## 开发与发布

```bash
cd plugin
npm run verify    # 发布自检：node 语法检查 + 干净 tarball 安装 + 导入 host 模块
```

`verify-release.mjs` 会按 `package.json` 的 `files` 白名单 `npm pack`，装进干净临时目录，
再 `import` host 模块，证明发布产物能像 DSH loader 一样解析自身（本插件零运行时依赖，
仅用 Node 内建模块 + `ctx` 服务）。

**发布到 GitHub**：本仓库即发布源；改完源码后 `git add -A && git commit && git push`。
`files` 白名单与 `.gitignore` 已排除 `node_modules`、`*.tgz`、`package-lock.json`、Gradle
构建产物、`local.properties` 与运行时用户数据（`avatars/`），成品 `鲸聊-v1.1.apk` 保留在仓库。

## 安全

配对设备即完全控制凭据（与现有远程插件同一安全模型）。停止/取消配对会立即
切断 `/remote` 通道，本插件的聊天页与接口随之不可用。四个控制面
（配对、自更新、插件管理、桌面启动器）对远程设备始终不可达。
