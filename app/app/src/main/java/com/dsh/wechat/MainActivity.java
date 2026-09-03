package com.dsh.wechat;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import com.yalantis.ucrop.UCrop;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private static final int CAMERA_REQ = 100;
    private static final int PICK_AVATAR_REQ = 200;
    private static final int PICK_BG_REQ = 300;
    private static final int REC_AUDIO_REQ = 500;
    private boolean pendingScan = false;
    private String pendingAvatarSide = "other";
    private String pendingPickKind = "avatar";

    // 讯飞语音听写（WebSocket，系统网络栈）；密钥由 BuildConfig 从 secrets.properties 注入
    private static final String IF_APP_ID = BuildConfig.IFLYTEK_APP_ID;
    private static final String IF_API_KEY = BuildConfig.IFLYTEK_API_KEY;
    private static final String IF_API_SECRET = BuildConfig.IFLYTEK_API_SECRET;
    private static final String IF_HOST = "iat-api.xfyun.cn";
    private WebSocket iatWs = null;
    private AudioRecord audioRecord = null;
    private Thread recordThread = null;
    private volatile boolean voiceRunning = false;
    private volatile boolean voiceStopRequested = false;
    private volatile boolean voiceCancelled = false;
    private final StringBuilder voiceText = new StringBuilder();

    /** 稳定客户端标识：跨扫码/换公网地址保留同一会话历史。 */
    private String clientId() {
        SharedPreferences p = getSharedPreferences("dsh_wechat", MODE_PRIVATE);
        String id = p.getString("client_id", null);
        if (id == null || id.isEmpty()) {
            id = java.util.UUID.randomUUID().toString();
            p.edit().putString("client_id", id).apply();
        }
        return id;
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) backToFirstRun();
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                if (request.isForMainFrame() && errorResponse.getStatusCode() >= 400) backToFirstRun();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // 进入远程页后清空历史：返回键直接退出，不再回到引导页
                if (!url.startsWith("file://")) view.clearHistory();
            }
        });
        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(new Bridge(), "WechatBridge");
        CookieManager.getInstance().setAcceptCookie(true);

        String origin = getSharedPreferences("dsh_wechat", MODE_PRIVATE).getString("origin", null);
        if (origin == null || origin.isEmpty()) {
            webView.loadUrl("file:///android_asset/firstrun.html");
        } else {
            // 已配对：直接进聊天页（加载失败再由 onReceivedError 兜底回引导页）
            webView.loadUrl(origin + "/wechat?client=" + clientId());
        }
    }

    /** 页面加载失败（公网地址失效/网络不可达）时回到引导页重新扫码。 */
    private void backToFirstRun() {
        getSharedPreferences("dsh_wechat", MODE_PRIVATE).edit().remove("origin").apply();
        webView.loadUrl("file:///android_asset/firstrun.html");
    }

    /* JS bridge used by the WeChat chat page and the first-run page. */
    public class Bridge {
        @JavascriptInterface
        public void scanQR() {
            startScan();
        }

        @JavascriptInterface
        public void saveOrigin(String origin) {
            if (origin == null || origin.isEmpty()) return;
            getSharedPreferences("dsh_wechat", MODE_PRIVATE).edit().putString("origin", origin).apply();
        }

        @JavascriptInterface
        public void pickAvatar(String side) {
            pendingPickKind = "avatar";
            pendingAvatarSide = ("me".equals(side)) ? "me" : "other";
            openGallery("选择头像", PICK_AVATAR_REQ);
        }

        @JavascriptInterface
        public void pickBackground() {
            pendingPickKind = "background";
            openGallery("选择背景", PICK_BG_REQ);
        }

        @JavascriptInterface
        public void startVoice() {
            runOnUiThread(() -> startVoiceRecognition());
        }

        @JavascriptInterface
        public void stopVoice() {
            runOnUiThread(() -> stopVoiceRecognition());
        }

        @JavascriptInterface
        public void cancelVoice() {
            runOnUiThread(() -> cancelVoiceRecognition());
        }
    }

    /** 语音输入开始（按住说话）。 */
    private void startVoiceRecognition() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.RECORD_AUDIO}, REC_AUDIO_REQ);
            return;
        }
        if (IF_APP_ID == null || IF_APP_ID.isEmpty() || IF_APP_ID.startsWith("your_")
                || IF_API_KEY.startsWith("your_") || IF_API_SECRET.startsWith("your_")) {
            voiceError("未配置讯飞语音密钥：请在 app/app/secrets.properties 填入后重新构建（见 docs/iflytek-voice.md）");
            return;
        }
        if (voiceRunning) return;
        voiceRunning = true;
        voiceStopRequested = false;
        voiceCancelled = false;
        synchronized (voiceText) { voiceText.setLength(0); }
        try {
            String url = buildIatUrl();
            OkHttpClient client = new OkHttpClient.Builder()
                    .connectTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
                    .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                    .build();
            Request req = new Request.Builder().url(url).build();
            iatWs = client.newWebSocket(req, new WebSocketListener() {
                @Override public void onOpen(WebSocket ws, Response response) {
                    startRecording(ws);
                }
                @Override public void onMessage(WebSocket ws, String text) {
                    handleIatMessage(text);
                }
                @Override public void onFailure(WebSocket ws, Throwable t, Response response) {
                    runOnUiThread(() -> {
                        cleanupVoice();
                        voiceError("连接讯飞失败：" + (t != null && t.getMessage() != null ? t.getMessage() : "网络不可用"));
                    });
                }
                @Override public void onClosed(WebSocket ws, int code, String reason) {}
            });
            // 最长按住 60 秒自动松手
            webView.postDelayed(() -> { if (voiceRunning) stopVoiceRecognition(); }, 60000);
        } catch (Exception e) {
            voiceRunning = false;
            voiceError("语音识别启动失败：" + (e.getMessage() == null ? "未知错误" : e.getMessage()));
        }
    }

    /** 语音输入结束（松开）。 */
    private void stopVoiceRecognition() {
        voiceStopRequested = true;
    }

    /** 构造鉴权 WebSocket URL（hmac-sha256 签名）。 */
    private String buildIatUrl() throws Exception {
        java.text.SimpleDateFormat sdf = new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", java.util.Locale.US);
        sdf.setTimeZone(java.util.TimeZone.getTimeZone("GMT"));
        String date = sdf.format(new java.util.Date());
        String requestLine = "GET /v2/iat HTTP/1.1";
        String signatureOrigin = "host: " + IF_HOST + "\ndate: " + date + "\n" + requestLine;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(IF_API_SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String signature = Base64.encodeToString(mac.doFinal(signatureOrigin.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        String authOrigin = "api_key=\"" + IF_API_KEY + "\", algorithm=\"hmac-sha256\", headers=\"host date request-line\", signature=\"" + signature + "\"";
        String authorization = Base64.encodeToString(authOrigin.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        // 关键：authorization 是 base64（含 + / =），必须 URL 编码，否则 + 会被解码成空格导致签名校验失败
        String authEncoded = java.net.URLEncoder.encode(authorization, "UTF-8");
        String dateEncoded = java.net.URLEncoder.encode(date, "UTF-8").replace("+", "%20");
        return "wss://" + IF_HOST + "/v2/iat?authorization=" + authEncoded + "&date=" + dateEncoded + "&host=" + IF_HOST;
    }

    /** WebSocket 连上后启动录音，持续发音频帧。 */
    private void startRecording(final WebSocket ws) {
        try {
            final int sampleRate = 16000;
            int minBuf = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            audioRecord = new AudioRecord(MediaRecorder.AudioSource.MIC, sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuf, 1280 * 4));
            audioRecord.startRecording();
            recordThread = new Thread(() -> {
                byte[] buf = new byte[1280];
                boolean first = true;
                try {
                    while (voiceRunning && !voiceStopRequested) {
                        int read = audioRecord.read(buf, 0, 1280);
                        if (read > 0) {
                            byte[] chunk = (read == 1280) ? buf : Arrays.copyOf(buf, read);
                            sendAudio(ws, chunk, first ? 0 : 1);
                            first = false;
                        }
                    }
                } catch (Exception ignored) {}
                try { audioRecord.stop(); } catch (Exception e) {}
                try { audioRecord.release(); } catch (Exception e) {}
                audioRecord = null;
                sendAudioEnd(ws);
                // 兜底：发完结束帧 5 秒内没结果就强制收尾
                runOnUiThread(() -> webView.postDelayed(() -> { if (voiceRunning) { cleanupVoice(); voiceError("语音识别超时"); } }, 5000));
            });
            recordThread.start();
        } catch (Exception e) {
            runOnUiThread(() -> {
                cleanupVoice();
                voiceError("录音启动失败：" + (e.getMessage() == null ? "未知错误" : e.getMessage()));
            });
        }
    }

    private void sendAudio(WebSocket ws, byte[] pcm, int status) {
        try {
            JSONObject data = new JSONObject();
            data.put("status", status);
            data.put("format", "audio/L16;rate=16000");
            data.put("encoding", "raw");
            data.put("audio", Base64.encodeToString(pcm, Base64.NO_WRAP));
            JSONObject frame = new JSONObject();
            if (status == 0) {
                frame.put("common", new JSONObject().put("app_id", IF_APP_ID));
                frame.put("business", new JSONObject()
                        .put("language", "zh_cn")
                        .put("domain", "iat")
                        .put("accent", "mandarin")
                        .put("ptt", 1));
            }
            frame.put("data", data);
            ws.send(frame.toString());
        } catch (Exception ignored) {}
    }

    private void sendAudioEnd(WebSocket ws) {
        try {
            JSONObject frame = new JSONObject();
            frame.put("data", new JSONObject().put("status", 2));
            ws.send(frame.toString());
        } catch (Exception ignored) {}
    }

    /** 解析识别结果：累计 ws[].cw[].w，status==2 时收尾。 */
    private void handleIatMessage(String text) {
        try {
            JSONObject obj = new JSONObject(text);
            int code = obj.optInt("code", 0);
            if (code != 0) {
                final String msg = "识别失败(" + code + ")：" + obj.optString("message", "");
                runOnUiThread(() -> { cleanupVoice(); voiceError(msg); });
                return;
            }
            JSONObject data = obj.optJSONObject("data");
            if (data == null) return;
            JSONObject result = data.optJSONObject("result");
            if (result != null) {
                JSONArray wsArr = result.optJSONArray("ws");
                if (wsArr != null) {
                    StringBuilder sb = new StringBuilder();
                    for (int i = 0; i < wsArr.length(); i++) {
                        JSONArray cwArr = wsArr.optJSONObject(i).optJSONArray("cw");
                        if (cwArr == null) continue;
                        for (int j = 0; j < cwArr.length(); j++) {
                            String w = cwArr.optJSONObject(j).optString("w", "");
                            if (w != null) sb.append(w);
                        }
                    }
                    synchronized (voiceText) { voiceText.append(sb.toString()); }
                }
            }
            int status = data.optInt("status", -1);
            final String full;
            synchronized (voiceText) { full = voiceText.toString(); }
            if (status == 2) {
                runOnUiThread(() -> finishVoice(full));
            } else if (status == 0 || status == 1) {
                sendVoicePartial(full);
            }
        } catch (Exception ignored) {}
    }

    /** 实时识别中间结果回传页面（用于显示正在识别的文字）。 */
    private void sendVoicePartial(String text) {
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.wechatVoicePartial && window.wechatVoicePartial(" + jsonQuote(text) + ");", null));
    }

    private void finishVoice(String text) {
        cleanupVoice();
        if (voiceCancelled) return; // 上滑取消：不发送
        if (text == null || text.trim().isEmpty()) { voiceError("没有识别到内容"); return; }
        webView.evaluateJavascript("window.wechatVoiceResult && window.wechatVoiceResult(" + jsonQuote(text.trim()) + ");", null);
    }

    /** 上滑取消：终止识别且不发送。 */
    private void cancelVoiceRecognition() {
        voiceCancelled = true;
        cleanupVoice();
    }

    private void cleanupVoice() {
        voiceRunning = false;
        voiceStopRequested = true;
        if (audioRecord != null) {
            try { audioRecord.stop(); } catch (Exception e) {}
            try { audioRecord.release(); } catch (Exception e) {}
            audioRecord = null;
        }
        if (iatWs != null) {
            try { iatWs.close(1000, "done"); } catch (Exception e) {}
            iatWs = null;
        }
    }

    /** 语音出错：Toast + 回传页面提示。 */
    private void voiceError(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
        webView.evaluateJavascript("window.wechatVoiceError && window.wechatVoiceError(" + jsonQuote(msg) + ");", null);
    }

    private void openGallery(String title, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(Intent.createChooser(intent, title), requestCode);
        } catch (Exception e) {
            Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
        }
    }

    private void startScan() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            pendingScan = true;
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, CAMERA_REQ);
            return;
        }
        new IntentIntegrator(this).setOrientationLocked(true).initiateScan();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_REQ) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                new IntentIntegrator(this).setOrientationLocked(true).initiateScan();
            } else {
                Toast.makeText(this, "需要相机权限才能扫码", Toast.LENGTH_LONG).show();
            }
            pendingScan = false;
        }
        if (requestCode == REC_AUDIO_REQ) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startVoiceRecognition();
            } else {
                voiceError("需要麦克风权限才能语音输入");
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == PICK_AVATAR_REQ || requestCode == PICK_BG_REQ) {
            // 从相册/文件选择器拿到原图后，进入裁剪/旋转
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                startCrop(data.getData());
            }
            return;
        }

        if (requestCode == UCrop.REQUEST_CROP) {
            if (resultCode == RESULT_OK) {
                final Uri resultUri = UCrop.getOutput(data);
                if (resultUri != null) {
                    final String kind = pendingPickKind;
                    new Thread(() -> {
                        try {
                            Bitmap bmp = decodeSampledBitmap(resultUri, 1280);
                            if (bmp == null) throw new Exception("decode failed");
                            ByteArrayOutputStream out = new ByteArrayOutputStream();
                            bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
                            bmp.recycle();
                            String b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                            final String js;
                            if ("background".equals(kind)) {
                                js = "window.wechatBackgroundPicked && window.wechatBackgroundPicked('data:image/png;base64," + b64 + "');";
                            } else {
                                js = "window.wechatAvatarPicked && window.wechatAvatarPicked("
                                        + jsonQuote(pendingAvatarSide) + ", 'data:image/png;base64," + b64 + "');";
                            }
                            runOnUiThread(() -> webView.evaluateJavascript(js, null));
                        } catch (Exception e) {
                            runOnUiThread(() -> Toast.makeText(MainActivity.this, "读取图片失败", Toast.LENGTH_SHORT).show());
                        }
                    }).start();
                }
            } else if (resultCode == UCrop.RESULT_ERROR) {
                Toast.makeText(this, "裁剪失败", Toast.LENGTH_SHORT).show();
            }
            return;
        }

        IntentResult result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (result != null && result.getContents() != null) {
            final String scanned = result.getContents();
            // 记住扫码得到的服务器地址（供下次启动直接进入）
            try {
                java.net.URL u = new java.net.URL(scanned);
                String proto = "https".equals(u.getProtocol()) ? "https" : "http";
                StringBuilder origin = new StringBuilder(proto).append("://").append(u.getHost());
                if (u.getPort() > 0) origin.append(":").append(u.getPort());
                getSharedPreferences("dsh_wechat", MODE_PRIVATE).edit().putString("origin", origin.toString()).apply();
            } catch (Exception ignored) {}
            // 直接由原生加载配对链接（不依赖 JS 桥），并带上稳定客户端标识；
            // 服务器校验令牌后直接下发聊天页
            final String withClient = scanned + (scanned.contains("?") ? "&" : "?") + "client=" + clientId();
            runOnUiThread(() -> webView.loadUrl(withClient));
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    /** 打开 UCrop 裁剪/旋转：头像 1:1 方形，背景自由比例。 */
    private void startCrop(Uri source) {
        try {
            File dest = new File(getCacheDir(), "crop-" + System.currentTimeMillis() + ".png");
            UCrop.Options options = new UCrop.Options();
            options.setCompressionFormat(Bitmap.CompressFormat.PNG);
            options.setCompressionQuality(100);
            UCrop u = UCrop.of(source, Uri.fromFile(dest)).withOptions(options);
            if ("background".equals(pendingPickKind)) {
                u.withMaxResultSize(1280, 1280);
            } else {
                u.withAspectRatio(1, 1).withMaxResultSize(512, 512);
            }
            u.start(this);
        } catch (Exception e) {
            Toast.makeText(this, "无法打开裁剪：" + (e.getMessage() == null ? "未知错误" : e.getMessage()), Toast.LENGTH_LONG).show();
        }
    }

    /** 读取并等比缩放到 maxSize 以内的位图，避免大图在 WebView 里传 base64 过重。 */
    private Bitmap decodeSampledBitmap(Uri uri, int maxSize) throws Exception {
        InputStream in = getContentResolver().openInputStream(uri);
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeStream(in, null, bounds);
        if (in != null) in.close();
        int w = bounds.outWidth, h = bounds.outHeight;
        int scale = 1;
        while (w / scale > maxSize || h / scale > maxSize) scale *= 2;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = scale;
        in = getContentResolver().openInputStream(uri);
        Bitmap bmp = BitmapFactory.decodeStream(in, null, opts);
        if (in != null) in.close();
        return bmp;
    }

    private static String jsonQuote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r") + "\"";
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        cleanupVoice();
        super.onDestroy();
    }
}
