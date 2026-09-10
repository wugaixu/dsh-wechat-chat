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

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private android.widget.TextView nativeVoiceButton;
    private static final int CAMERA_REQ = 100;
    private static final int PICK_AVATAR_REQ = 200;
    private static final int PICK_BG_REQ = 300;
    private static final int REC_AUDIO_REQ = 500;
    private boolean pendingScan = false;
    private String pendingAvatarSide = "other";
    private String pendingPickKind = "avatar";

    // 本机离线语音：手机只录制 PCM/WAV，经已配对的鲸聊隧道上传到电脑转写。
    private static final int VOICE_SAMPLE_RATE = 16000;
    private static final int VOICE_MAX_PCM_BYTES = 1_920_000; // 60 秒、16-bit、单声道
    private final OkHttpClient voiceHttp = new OkHttpClient.Builder()
            .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .writeTimeout(45, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(150, java.util.concurrent.TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build();
    private AudioRecord audioRecord = null;
    private Thread recordThread = null;
    private Call voiceUploadCall = null;
    private volatile boolean voiceRunning = false;
    private volatile boolean voiceStopRequested = false;
    private volatile boolean voiceCancelled = false;
    private boolean voiceHoldActive = false;
    private boolean pendingVoicePermission = false;
    private int voiceGeneration = 0;
    private String voiceDeviceId = "";
    private String voiceOrigin = "";
    private String voiceCookie = "";

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
        nativeVoiceButton = findViewById(R.id.native_voice_button);
        nativeVoiceButton.setOnTouchListener((view, event) -> {
            if (event.getAction() == android.view.MotionEvent.ACTION_DOWN) {
                view.setBackgroundColor(0xffd8d8d8);
                startVoiceRecognition();
                return true;
            }
            if (event.getAction() == android.view.MotionEvent.ACTION_MOVE && event.getY() < -80) {
                view.setBackgroundColor(0xfff5f5f5);
                voiceHoldActive = false;
                cancelVoiceRecognition();
                return true;
            }
            if (event.getAction() == android.view.MotionEvent.ACTION_UP) {
                view.setBackgroundColor(0xfff5f5f5);
                voiceHoldActive = false;
                stopVoiceRecognition();
                return true;
            }
            if (event.getAction() == android.view.MotionEvent.ACTION_CANCEL) {
                view.setBackgroundColor(0xfff5f5f5);
                voiceHoldActive = false;
                cancelVoiceRecognition();
                return true;
            }
            return true;
        });
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("file".equalsIgnoreCase(uri.getScheme())) return false;
                // QR 扫码配对链接（含 pair= 令牌）允许通过，即使 origin 与已保存的不同
                String pairToken = uri.getQueryParameter("pair");
                if (pairToken != null && !pairToken.isEmpty()) return false;
                String saved = getSharedPreferences("dsh_wechat", MODE_PRIVATE).getString("origin", "");
                String target = normalizedOrigin(uri.toString());
                if (!saved.isEmpty() && saved.equals(target)) return false;
                Toast.makeText(MainActivity.this, "已阻止跳转到非配对地址", Toast.LENGTH_SHORT).show();
                return true;
            }

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
                else nativeVoiceButton.setVisibility(android.view.View.GONE);
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

        /** JavaScript can expose the native consent surface, but cannot start the microphone. */
        @JavascriptInterface
        public void setNativeVoiceVisible(boolean visible) {
            runOnUiThread(() -> {
                String saved = getSharedPreferences("dsh_wechat", MODE_PRIVATE).getString("origin", "");
                String current = normalizedOrigin(webView.getUrl());
                boolean chatPage = webView.getUrl() != null && Uri.parse(webView.getUrl()).getPath() != null
                        && Uri.parse(webView.getUrl()).getPath().startsWith("/wechat");
                nativeVoiceButton.setVisibility(visible && !saved.isEmpty() && saved.equals(current) && chatPage
                        ? android.view.View.VISIBLE : android.view.View.GONE);
            });
        }
    }

    /** 语音输入开始（按住说话）：只录音，不连接任何第三方语音服务。 */
    private void startVoiceRecognition() {
        if (voiceRunning) return;
        voiceHoldActive = true;
        voiceDeviceId = "";
        voiceOrigin = normalizedOrigin(webView.getUrl());
        String savedOrigin = getSharedPreferences("dsh_wechat", MODE_PRIVATE).getString("origin", "");
        if (voiceOrigin.isEmpty() || !voiceOrigin.equals(savedOrigin)) {
            voiceHoldActive = false;
            voiceError("当前页面不是已配对的鲸聊地址");
            return;
        }
        if (!voiceOrigin.startsWith("https://")) {
            voiceHoldActive = false;
            voiceError("为防止录音和凭据被窃听，语音输入仅支持 HTTPS 公网隧道");
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingVoicePermission = true;
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.RECORD_AUDIO}, REC_AUDIO_REQ);
            return;
        }
        beginVoiceCapture();
    }

    private void beginVoiceCapture() {
        if (!voiceHoldActive || voiceRunning) return;
        pendingVoicePermission = false;
        voiceRunning = true;
        voiceStopRequested = false;
        voiceCancelled = false;
        final int generation = ++voiceGeneration;
        voiceCookie = CookieManager.getInstance().getCookie(voiceOrigin + "/wechat");
        try {
            int minBuf = AudioRecord.getMinBufferSize(VOICE_SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minBuf <= 0) throw new IllegalStateException("设备不支持 16kHz 录音");
            final AudioRecord recorder = new AudioRecord(MediaRecorder.AudioSource.MIC, VOICE_SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuf, 1280 * 4));
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                recorder.release();
                throw new IllegalStateException("麦克风初始化失败");
            }
            audioRecord = recorder;
            recorder.startRecording();
            voiceProgress("recording", 0, "正在录音，松开后在电脑本地识别");
            recordThread = new Thread(() -> recordVoiceLoop(recorder, generation), "whale-voice-record");
            recordThread.start();
            webView.postDelayed(() -> {
                if (generation == voiceGeneration && voiceRunning) {
                    voiceHoldActive = false;
                    stopVoiceRecognition();
                }
            }, 60000);
        } catch (Exception e) {
            voiceRunning = false;
            voiceError("录音启动失败：" + safeMessage(e));
        }
    }

    private void recordVoiceLoop(AudioRecord recorder, int generation) {
        ByteArrayOutputStream pcm = new ByteArrayOutputStream(VOICE_MAX_PCM_BYTES);
        byte[] chunk = new byte[1280];
        try {
            while (generation == voiceGeneration && voiceRunning && !voiceStopRequested) {
                int read = recorder.read(chunk, 0, chunk.length);
                if (read > 0) {
                    int remaining = VOICE_MAX_PCM_BYTES - pcm.size();
                    if (remaining <= 0) { voiceStopRequested = true; break; }
                    pcm.write(chunk, 0, Math.min(read, remaining));
                    if (read > remaining) { voiceStopRequested = true; break; }
                } else if (read < 0 && read != AudioRecord.ERROR_INVALID_OPERATION) {
                    throw new IOException("录音读取失败：" + read);
                }
            }
        } catch (Exception e) {
            if (!voiceCancelled && generation == voiceGeneration) runOnUiThread(() -> voiceError("录音失败：" + safeMessage(e)));
        } finally {
            try { recorder.stop(); } catch (Exception ignored) {}
            try { recorder.release(); } catch (Exception ignored) {}
            if (audioRecord == recorder) audioRecord = null;
        }
        if (generation != voiceGeneration || voiceCancelled) return;
        byte[] raw = pcm.toByteArray();
        if ((raw.length & 1) != 0) raw = java.util.Arrays.copyOf(raw, raw.length - 1);
        if (raw.length < 3200) {
            runOnUiThread(() -> voiceError("录音时间太短"));
            return;
        }
        uploadVoice(makeWav(raw), generation);
    }

    /** 松开后停止录制；录音线程负责封装并上传。 */
    private void stopVoiceRecognition() {
        pendingVoicePermission = false;
        if (!voiceRunning) return;
        voiceStopRequested = true;
        AudioRecord recorder = audioRecord;
        if (recorder != null) try { recorder.stop(); } catch (Exception ignored) {}
        voiceProgress("uploading", 0, "正在上传录音…");
    }

    private void uploadVoice(byte[] wav, int generation) {
        try {
            String url = voiceOrigin + "/api/wechat/voice/transcribe?client=" + Uri.encode(clientId());
            RequestBody body = RequestBody.create(wav, MediaType.get("audio/wav"));
            Request.Builder builder = new Request.Builder().url(url).post(body).header("Accept", "application/json");
            if (voiceCookie != null && !voiceCookie.isEmpty()) builder.header("Cookie", voiceCookie);
            if (!voiceDeviceId.isEmpty()) builder.header("x-whale-device", voiceDeviceId);
            Call call = voiceHttp.newCall(builder.build());
            voiceUploadCall = call;
            voiceProgress("transcribing", 100, "录音已发送，电脑正在离线识别…");
            call.enqueue(new Callback() {
                @Override public void onFailure(@NonNull Call call, @NonNull IOException e) {
                    runOnUiThread(() -> {
                        if (generation != voiceGeneration || voiceCancelled) return;
                        voiceUploadCall = null;
                        voiceError("语音上传失败：" + safeMessage(e));
                    });
                }
                @Override public void onResponse(@NonNull Call call, @NonNull Response response) throws IOException {
                    String raw = response.body() == null ? "" : response.body().string();
                    int status = response.code();
                    response.close();
                    runOnUiThread(() -> {
                        if (generation != voiceGeneration || voiceCancelled) return;
                        voiceUploadCall = null;
                        try {
                            JSONObject json = new JSONObject(raw);
                            if (status >= 200 && status < 300 && json.optBoolean("ok", false)) {
                                finishVoice(json.optString("text", ""));
                            } else {
                                String msg = json.optString("error", status == 503 ? "请先在电脑配对面板安装离线语音模型" : "语音识别失败");
                                voiceError(msg);
                            }
                        } catch (Exception e) {
                            voiceError(status == 401 ? "公网登录已失效，请重新扫码登录" : "语音服务返回异常");
                        }
                    });
                }
            });
        } catch (Exception e) {
            runOnUiThread(() -> voiceError("无法上传语音：" + safeMessage(e)));
        }
    }

    private static byte[] makeWav(byte[] pcm) {
        byte[] wav = new byte[44 + pcm.length];
        putAscii(wav, 0, "RIFF"); putLe32(wav, 4, 36 + pcm.length); putAscii(wav, 8, "WAVE");
        putAscii(wav, 12, "fmt "); putLe32(wav, 16, 16); putLe16(wav, 20, 1); putLe16(wav, 22, 1);
        putLe32(wav, 24, VOICE_SAMPLE_RATE); putLe32(wav, 28, VOICE_SAMPLE_RATE * 2); putLe16(wav, 32, 2); putLe16(wav, 34, 16);
        putAscii(wav, 36, "data"); putLe32(wav, 40, pcm.length); System.arraycopy(pcm, 0, wav, 44, pcm.length);
        return wav;
    }

    private static void putAscii(byte[] out, int at, String text) {
        for (int i = 0; i < text.length(); i++) out[at + i] = (byte) text.charAt(i);
    }
    private static void putLe16(byte[] out, int at, int value) {
        out[at] = (byte) value; out[at + 1] = (byte) (value >>> 8);
    }
    private static void putLe32(byte[] out, int at, int value) {
        out[at] = (byte) value; out[at + 1] = (byte) (value >>> 8); out[at + 2] = (byte) (value >>> 16); out[at + 3] = (byte) (value >>> 24);
    }

    private void voiceProgress(String stage, int percent, String message) {
        runOnUiThread(() -> webView.evaluateJavascript("window.wechatVoiceProgress && window.wechatVoiceProgress("
                + jsonQuote(stage) + "," + percent + "," + jsonQuote(message) + ");", null));
    }

    private void finishVoice(String text) {
        if (!voiceRunning || voiceCancelled) return;
        voiceRunning = false;
        voiceStopRequested = true;
        if (text == null || text.trim().isEmpty()) { voiceError("没有识别到内容"); return; }
        webView.evaluateJavascript("window.wechatVoiceResult && window.wechatVoiceResult(" + jsonQuote(text.trim()) + ");", null);
    }

    /** 上滑取消：终止录音或上传且不发送。 */
    private void cancelVoiceRecognition() {
        pendingVoicePermission = false;
        voiceCancelled = true;
        voiceRunning = false;
        voiceStopRequested = true;
        voiceGeneration++;
        AudioRecord recorder = audioRecord;
        if (recorder != null) try { recorder.stop(); } catch (Exception ignored) {}
        if (voiceUploadCall != null) voiceUploadCall.cancel();
        voiceUploadCall = null;
    }

    private void cleanupVoice() {
        voiceHoldActive = false;
        cancelVoiceRecognition();
    }

    /** 语音出错：Toast + 回传页面提示。 */
    private void voiceError(String msg) {
        voiceRunning = false;
        voiceStopRequested = true;
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
        webView.evaluateJavascript("window.wechatVoiceError && window.wechatVoiceError(" + jsonQuote(msg) + ");", null);
    }

    private static String safeMessage(Throwable error) {
        return error != null && error.getMessage() != null && !error.getMessage().isEmpty() ? error.getMessage() : "未知错误";
    }

    private static String normalizedOrigin(String raw) {
        try {
            URL url = new URL(raw);
            if (!"http".equalsIgnoreCase(url.getProtocol()) && !"https".equalsIgnoreCase(url.getProtocol())) return "";
            int port = url.getPort();
            boolean defaultPort = port < 0 || (port == 80 && "http".equalsIgnoreCase(url.getProtocol())) || (port == 443 && "https".equalsIgnoreCase(url.getProtocol()));
            return url.getProtocol().toLowerCase(java.util.Locale.US) + "://" + url.getHost().toLowerCase(java.util.Locale.US) + (defaultPort ? "" : ":" + port);
        } catch (Exception ignored) { return ""; }
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
            boolean shouldStart = pendingVoicePermission && voiceHoldActive;
            pendingVoicePermission = false;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                if (shouldStart) beginVoiceCapture();
                else voiceError("权限已允许，请重新按住说话");
            } else {
                voiceHoldActive = false;
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
            String pairedOrigin = normalizedOrigin(scanned);
            if (pairedOrigin.isEmpty()) {
                Toast.makeText(this, "二维码不是有效的 HTTP/HTTPS 鲸聊地址", Toast.LENGTH_LONG).show();
                return;
            }
            getSharedPreferences("dsh_wechat", MODE_PRIVATE).edit().putString("origin", pairedOrigin).apply();
            // 直接由原生加载配对链接（不依赖 JS 桥），并带上稳定客户端标识。
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
    protected void onStop() {
        cleanupVoice();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        cleanupVoice();
        super.onDestroy();
    }
}
