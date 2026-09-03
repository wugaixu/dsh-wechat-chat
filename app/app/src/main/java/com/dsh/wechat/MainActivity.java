package com.dsh.wechat;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
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

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;

public class MainActivity extends AppCompatActivity {

    private WebView webView;
    private static final int CAMERA_REQ = 100;
    private static final int PICK_AVATAR_REQ = 200;
    private static final int PICK_BG_REQ = 300;
    private static final int VOICE_REQ = 400;
    private static final int REC_AUDIO_REQ = 500;
    private boolean pendingScan = false;
    private String pendingAvatarSide = "other";
    private String pendingPickKind = "avatar";
    private SpeechRecognizer speechRecognizer = null;
    private Intent recognizerIntent = null;

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
        public void launchVoice() {
            runOnUiThread(() -> startVoiceRecognition());
        }
    }

    /**
     * 语音输入入口：优先系统识别对话框（有对应 Activity 时）；
     * 国产 ROM 常只有识别服务、没有对话框，此时回退到流式 SpeechRecognizer。
     */
    private void startVoiceRecognition() {
        Intent dialog = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        dialog.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        dialog.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
        dialog.putExtra(RecognizerIntent.EXTRA_PROMPT, "请说话");
        dialog.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        if (dialog.resolveActivity(getPackageManager()) != null) {
            try {
                startActivityForResult(dialog, VOICE_REQ);
                return;
            } catch (Exception e) {
                // 打开失败则继续尝试流式识别
            }
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            voiceError("当前设备不支持语音识别");
            return;
        }
        startStreamingRecognition();
    }

    /** 流式语音识别（无对话框但有识别服务的设备）。 */
    private void startStreamingRecognition() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.RECORD_AUDIO}, REC_AUDIO_REQ);
            return;
        }
        ensureRecognizer();
        try {
            speechRecognizer.startListening(recognizerIntent);
        } catch (Exception e) {
            voiceError("语音识别启动失败：" + (e.getMessage() == null ? "未知错误" : e.getMessage()));
        }
    }

    private void ensureRecognizer() {
        if (speechRecognizer == null) {
            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
            speechRecognizer.setRecognitionListener(new RecognitionListener() {
                @Override public void onResults(Bundle results) {
                    ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    final String text = (matches != null && !matches.isEmpty()) ? matches.get(0) : "";
                    runOnUiThread(() -> {
                        if (!text.trim().isEmpty()) {
                            webView.evaluateJavascript("window.wechatVoiceResult && window.wechatVoiceResult(" + jsonQuote(text.trim()) + ");", null);
                        } else {
                            voiceError("没有识别到内容");
                        }
                    });
                }
                @Override public void onError(int error) {
                    final String msg = voiceErrorText(error);
                    runOnUiThread(() -> voiceError(msg));
                }
                @Override public void onReadyForSpeech(Bundle params) {}
                @Override public void onBeginningOfSpeech() {}
                @Override public void onRmsChanged(float rmsdB) {}
                @Override public void onBufferReceived(byte[] buffer) {}
                @Override public void onEndOfSpeech() {}
                @Override public void onPartialResults(Bundle partialResults) {}
                @Override public void onEvent(int eventType, Bundle params) {}
            });
        }
        if (recognizerIntent == null) {
            recognizerIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            recognizerIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
            recognizerIntent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            // 注意：不加 EXTRA_PARTIAL_RESULTS，部分引擎不支持会导致 ERROR_CLIENT
        }
    }

    /** 流式识别的错误码 → 中文提示（带错误码，便于定位）。 */
    private String voiceErrorText(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO: return "录音失败（麦克风不可用）";
            case SpeechRecognizer.ERROR_CLIENT: return "语音识别客户端错误（错误码 " + error + "）";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "没有麦克风权限";
            case SpeechRecognizer.ERROR_NETWORK: return "网络连接失败";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "网络超时";
            case SpeechRecognizer.ERROR_NO_MATCH: return "没有识别到内容";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "识别服务忙，请稍后再试";
            case SpeechRecognizer.ERROR_SERVER: return "识别服务错误（错误码 " + error + "）";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "没有说话";
            default: return "语音识别失败（错误码 " + error + "）";
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
                startStreamingRecognition();
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

        if (requestCode == VOICE_REQ) {
            if (resultCode == RESULT_OK && data != null) {
                ArrayList<String> results = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                final String text = (results != null && !results.isEmpty()) ? results.get(0) : "";
                if (!text.trim().isEmpty()) {
                    webView.evaluateJavascript("window.wechatVoiceResult && window.wechatVoiceResult(" + jsonQuote(text.trim()) + ");", null);
                } else {
                    webView.evaluateJavascript("window.wechatVoiceError && window.wechatVoiceError('没有识别到内容');", null);
                }
            } else if (resultCode == RecognizerIntent.RESULT_AUDIO_ERROR) {
                webView.evaluateJavascript("window.wechatVoiceError && window.wechatVoiceError('录音出错，请重试');", null);
            } else if (resultCode == RecognizerIntent.RESULT_NETWORK_ERROR) {
                webView.evaluateJavascript("window.wechatVoiceError && window.wechatVoiceError('网络出错，请重试');", null);
            }
            // RESULT_CANCELED：用户取消，静默处理
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
        if (speechRecognizer != null) {
            try { speechRecognizer.cancel(); } catch (Exception e) {}
            try { speechRecognizer.destroy(); } catch (Exception e) {}
            speechRecognizer = null;
        }
        super.onDestroy();
    }
}
