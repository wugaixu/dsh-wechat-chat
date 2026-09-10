# 本地离线语音输入

鲸聊 1.3 起，Android 只在本机录制 16 kHz、16-bit、单声道 PCM WAV（最长 60 秒），通过已认证的鲸聊隧道上传到电脑。插件使用固定版本的 whisper.cpp multilingual small 模型离线转写，结果先放入手机输入框，用户确认或修改后再发送。

在电脑本机打开 `http://127.0.0.1:3080/whale-panel`，点击「安装离线模型」。首次安装约下载 496 MB。下载由固定 URL、大小及 SHA-256 验证；临时录音和输出在任务结束后删除，不需要或保存任何第三方 STT API Key。

完整安全限制、固定依赖与故障排查见仓库中的 [`docs/local-voice.md`](https://github.com/wugaixu/dsh-wechat-chat/blob/main/docs/local-voice.md)。
