# 讯飞语音听写接入说明（经验与踩坑）

鲸聊手机端的语音输入，最终采用 **讯飞「语音听写（流式版）」WebSocket API + 系统网络栈（OkHttp）** 自实现，不依赖讯飞任何原生 SDK。本文记录接入步骤与踩坑经验。

## 一、为什么绕开 SDK

| 方案 | 结果 | 原因 |
| --- | --- | --- |
| 系统 `SpeechRecognizer` / `RecognizerIntent` | ❌ 报 `ERROR_CLIENT` / 无对话框 | 国产 ROM（如 vivo）默认的识别服务是「唤醒词」服务（`com.vivo.ai.copilot/...wakeup.CopilotRec`），只认「你好小v」，不是通用语音转文字 |
| 讯飞 SparkChain 原生 SDK | ❌ 报 `18801`（连接建立出错） | 其自带网络栈在部分设备上连不上；且包体 +10MB |
| **WebSocket API + OkHttp（最终）** | ✅ | 走系统 TLS 网络栈（与输入法/浏览器同一套），稳定、轻量 |

## 二、申请密钥步骤

1. 打开 <https://console.xfyun.cn/>，注册 / 登录。
2. **创建应用**（平台选 Android）。
3. **开通「语音听写（流式版）」**（免费，默认每日 500 次；只建应用不点开通是没额度的）。
4. 在应用信息里拿到三个值。⚠️ **控制台顺序是 `APPID / APISecret / APIKey`**：
   - `APIKey`：32 位 **hex** 字符串（如 `ccbe233d...`）
   - `APISecret`：**base64** 字符串（如 `MTNmY2Uy...`）
   - 两者别搞反，搞反后服务器报 `401 apikey not found`。

## 三、配置到项目

1. 复制 `app/app/secrets.properties.example` → `app/app/secrets.properties`。
2. 填入三个值。
3. 正常构建。`app/app/build.gradle` 会把值注入 `BuildConfig`，`secrets.properties` 已在 `.gitignore` 排除，**不会提交到公开仓库**。

```properties
# app/app/secrets.properties（本地，不提交）
IFLYTEK_APP_ID=你的APPID
IFLYTEK_API_KEY=你的APIKey
IFLYTEK_API_SECRET=你的APISecret
```

## 四、技术要点

- **端点**：`wss://iat-api.xfyun.cn/v2/iat`
- **鉴权**：hmac-sha256 签名，签名原文为
  `host: iat-api.xfyun.cn\ndate: <RFC1123 GMT>\nGET /v2/iat HTTP/1.1`
- **请求帧**：`common`（app_id）+ `business`（language/domain/accent）只在首帧带；`data` 每帧带，`status` 0/1/2，音频为 base64 的 16k/16bit/单声道 PCM（每 40ms 发 1280 字节）。
- **返回**：文字在 `data.result.ws[].cw[].w`，逐帧累积；`data.status==2` 为最终结果。
- **录音**：`AudioRecord`（MIC，16k，16bit，mono）读 1280 字节即发送一帧。

## 五、踩坑记录（重点）

1. **密钥顺序**：控制台是 `APPID / APISecret / APIKey`，不是 `APPID / APIKey / APISecret`。搞反 → `401 apikey not found`。
2. **`authorization` 必须 URL 编码**：它是 base64（含 `+ / =`），不编码时 `+` 会被解码成空格，签名校验失败 → `401`。
3. **SparkChain 的 `18801` 有误导性**：原生 SDK 把「鉴权握手失败」包装成「连接建立出错(18801)」，看起来像网络问题，实际是密钥错误。
4. **系统语音识别在国产 ROM 不可用**：默认的 `voice_recognition_service` 是唤醒词服务，不是通用 STT。

## 六、错误码速查

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `401 apikey not found` | APIKey 填错 / 与 APISecret 搞反 | 核对顺序与值 |
| `401 HMAC signature does not match` | 密钥或签名拼接错 | 检查 api_key/api_secret 与签名原文 |
| `10005` | AppID 授权失败 | 确认已开通「语音听写」服务 |
| `11200` | 无权限 / 额度超限 | 控制台查看套餐用量 |
