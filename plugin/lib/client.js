/* 鲸聊 client 半区：官方 Web GUI 侧栏底部的鲸聊入口（sidebar.footer.action 席位）。
   self-register 惰性 CJS 工厂格式（window.__ModuleLoader__），不是普通 ESM。

   配对面板的打开方式分两种：
   - 普通 Web（http/https）：新标签页打开 `/whale-panel`（原行为）。
   - 桌面端 Electron 壳：页面 origin 是 `dsh-app://app`，`window.open` 的
     dsh-app URL 会被壳的 setWindowOpenHandler 直接拒绝（只有 http/https 会走系统
     浏览器，而系统浏览器没有 Host 凭据，拿到的是 401），所以改为在应用内用同源
     iframe 打开同一个 `/whale-panel`。壳会把 `dsh-app://app/*` 转发给带凭据的
     本机 Host，面板自身的 `/api/whale/*` 请求也随之走通。 */
window.__ModuleLoader__.load({
  id: "dsh-wechat-chat",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;

    var inject = ["slots", "locale"];

    var OVERLAY_ID = "dsh-wechat-chat-panel";
    var overlayHost = null;

    function BubbleIcon() {
      return h("svg", {
        viewBox: "0 0 24 24", width: 16, height: 16,
        fill: "none", stroke: "currentColor", strokeWidth: 2,
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true
      },
        h("path", { d: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" }));
    }

    /** 是否运行在官方桌面端（Electron 壳）里。 */
    function isDesktopApp() {
      try { return window.location.protocol === "dsh-app:"; } catch (e) { return false; }
    }

    function closePanel() {
      if (overlayHost !== null && overlayHost.parentNode) overlayHost.parentNode.removeChild(overlayHost);
      overlayHost = null;
      document.removeEventListener("keydown", onKeyDown);
    }

    function onKeyDown(event) {
      if (event.key === "Escape") closePanel();
    }

    /**
     * 桌面端：在应用内叠加一层同源 iframe 显示 `/whale-panel`。
     * iframe 直连 dsh-app 协议即可；若壳没有转发（内容为空），退化为取回 HTML
     * 写进 srcdoc，两条路都是同源，面板的接口调用都能带上 Host 凭据。
     */
    function openPanelOverlay() {
      if (overlayHost !== null) return;
      var host = document.createElement("div");
      host.id = OVERLAY_ID;
      host.setAttribute("data-dsh-plugin", "wechat-chat");
      host.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483600;"
        + "display:flex;flex-direction:column;background:#ededed";

      var bar = document.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px;"
        + "background:#ededed;border-bottom:1px solid #e2e2e2";

      var label = document.createElement("span");
      label.textContent = "鲸聊 · 配对";
      label.style.cssText = 'margin-right:auto;color:#666;font-size:13px;'
        + 'font-family:-apple-system,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif';

      var close = document.createElement("button");
      close.type = "button";
      close.textContent = "关闭";
      close.setAttribute("aria-label", "关闭鲸聊配对面板");
      close.style.cssText = "height:28px;padding:0 14px;border:0;border-radius:8px;"
        + "background:#07c160;color:#fff;font-size:13px;cursor:pointer";
      close.addEventListener("click", closePanel);

      var frame = document.createElement("iframe");
      frame.id = OVERLAY_ID + "-frame";
      frame.title = "鲸聊配对面板";
      frame.style.cssText = "flex:1;width:100%;border:0;background:#ededed";
      frame.setAttribute("src", "/whale-panel");

      var fallback = function () {
        if (frame.getAttribute("data-fallback") === "1") return;
        frame.setAttribute("data-fallback", "1");
        fetch("/whale-panel").then(function (response) {
          if (!response.ok) throw new Error("panel " + response.status);
          return response.text();
        }).then(function (html) {
          frame.removeAttribute("src");
          frame.setAttribute("srcdoc", html);
        }).catch(function () { /* 面板打不开时保持空壳，用户可关掉重试 */ });
      };
      var timer = setTimeout(function () {
        if (frame.getAttribute("data-fallback") === "1") return;
        var doc = null;
        try { doc = frame.contentDocument; } catch (e) { doc = null; }
        if (!doc || !doc.body || doc.body.childElementCount === 0) fallback();
      }, 2500);
      frame.addEventListener("load", function () { clearTimeout(timer); });

      bar.appendChild(label);
      bar.appendChild(close);
      host.appendChild(bar);
      host.appendChild(frame);
      document.body.appendChild(host);
      document.addEventListener("keydown", onKeyDown);
      overlayHost = host;
    }

    /** 侧栏入口：Web 开新标签页，桌面端开应用内叠加层。 */
    function openPanel() {
      if (isDesktopApp()) { openPanelOverlay(); return; }
      window.open("/whale-panel", "_blank");
    }

    function Entry() {
      return h("button", {
        type: "button",
        title: "鲸聊",
        "aria-label": "鲸聊：打开配对面板",
        onClick: openPanel,
        style: {
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 28, height: 28, minWidth: 28, borderRadius: 8, border: "none",
          background: "transparent", color: "#07c160", cursor: "pointer", padding: 0
        }
      }, h(BubbleIcon));
    }

    function apply(ctx) {
      ctx.effect(function () {
        try {
          return ctx.locale.register("wechat-chat", { zh: {}, en: {} });
        } catch (e) {
          return function () {};
        }
      }, "wechat-chat: dictionaries");

      ctx.slots.inject("sidebar.footer.action", function () {
        try {
          var unregister = ctx.slots.register(
            { name: "sidebar.footer.action", id: "wechat-chat", locale: "wechat-chat" },
            Entry
          );
          return function () {
            try { unregister(); } catch (e) {}
            closePanel();
          };
        } catch (e) {
          return function () {};
        }
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    exports.Entry = Entry;
    exports.openPanel = openPanel;
    exports.isDesktopApp = isDesktopApp;
    exports.closePanel = closePanel;
    return module.exports;
  }
});
