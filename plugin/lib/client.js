/* 鲸聊 client 半区：官方 Web GUI 侧栏底部的鲸聊入口（sidebar.footer.action 席位）。
   self-register 惰性 CJS 工厂格式（window.__ModuleLoader__），不是普通 ESM。 */
window.__ModuleLoader__.load({
  id: "dsh-wechat-chat",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;

    var inject = ["slots", "locale"];

    function BubbleIcon() {
      return h("svg", {
        viewBox: "0 0 24 24", width: 16, height: 16,
        fill: "none", stroke: "currentColor", strokeWidth: 2,
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true
      },
        h("path", { d: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" }));
    }

    function Entry() {
      return h("button", {
        type: "button",
        title: "鲸聊",
        "aria-label": "鲸聊：打开配对面板",
        onClick: function () { window.open("/whale-panel", "_blank"); },
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
          };
        } catch (e) {
          return function () {};
        }
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
