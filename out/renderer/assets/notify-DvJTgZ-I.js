import { j as jsxRuntimeExports, c as createRoot, r as reactExports } from "./client-B34VK5kX.js";
function splitRemain(label) {
  const matched = /^(\d+(?:\.\d+)?)(.*)$/.exec(label);
  if (matched === null) return { value: label, unit: "" };
  return { value: matched[1], unit: matched[2] };
}
function ReminderNotice({ payload, onDismiss }) {
  if (payload.level === "strong") {
    const { value, unit } = splitRemain(payload.remainLabel);
    return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "notice notice--strong", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "notice-strong-bar" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "notice-strong-head", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "notice-strong-type", children: payload.typeLabel }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "notice-strong-close", onClick: onDismiss, type: "button", children: "×" })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "notice-strong-title", children: payload.title }),
      payload.remainLabel === "" ? null : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "notice-strong-remain", children: [
        value,
        unit ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "notice-strong-unit", children: unit }) : null
      ] }),
      payload.dueLabel === "" ? null : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "notice-strong-due", children: [
        payload.dueLabel,
        " 截止"
      ] })
    ] });
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "notice notice--light", onClick: onDismiss, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "notice-light-bar" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "notice-light-body", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "notice-light-title", children: payload.title }),
      payload.remainLabel === "" ? null : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "notice-light-sub", children: [
        "还剩 ",
        payload.remainLabel
      ] })
    ] })
  ] });
}
function NotifyRoot() {
  const [payload, setPayload] = reactExports.useState(null);
  reactExports.useEffect(() => {
    if (typeof window.api === "undefined") return;
    return window.api.notify.onShow(setPayload);
  }, []);
  const dismiss = reactExports.useCallback(() => {
    const reminderId = payload === null ? null : payload.reminderId;
    const close = () => window.close();
    if (reminderId === null || typeof window.api === "undefined") {
      close();
      return;
    }
    void window.api.alert.ack({ sourceId: reminderId }).then((res) => {
      if (!res.ok) console.error("[notify] alert.ack 失败", res.error);
    }).catch((e) => console.error("[notify] alert.ack 失败", e)).finally(close);
  }, [payload]);
  if (payload === null) return null;
  return /* @__PURE__ */ jsxRuntimeExports.jsx(ReminderNotice, { onDismiss: dismiss, payload });
}
const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
createRoot(container).render(
  /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.StrictMode, { children: /* @__PURE__ */ jsxRuntimeExports.jsx(NotifyRoot, {}) })
);
