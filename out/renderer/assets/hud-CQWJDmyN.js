import { r as reactExports, j as jsxRuntimeExports, c as createRoot } from "./client-B34VK5kX.js";
import { t as toLocalDay, d as dueLocalDay, f as fmtPoints, a as dueInstant, R as RUBRIC_VERSION } from "./format-Bs86JCX8.js";
const TYPE_RANK = { daily: 0, deadline: 1, event: 2 };
function completionRatio(done, total) {
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, done / total));
}
function ratioLabel(done, total) {
  return `${done}/${total}`;
}
const TAP_TOLERANCE = 4;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
function weekdayLabel(date) {
  return WEEKDAYS[date.getDay()];
}
function tempLabel(value) {
  return value === null ? "--" : `${Math.round(value)}°`;
}
function todayPointsLabel(points) {
  return `今日 ${points > 0 ? "+" : ""}${fmtPoints(points)}`;
}
function dueTimestamp(dueAt) {
  if (dueAt === null || dueAt.length === 0) return null;
  const at = dueInstant(dueAt);
  return at === null ? null : at.getTime();
}
function hudDueLabel(dueAt) {
  const day = dueLocalDay(dueAt);
  return day === null ? "" : day.slice(5);
}
function withinHudWindow(tasks, today) {
  const [year, month, day] = today.split("-").map(Number);
  const end = toLocalDay(new Date(year, month - 1, day + 7));
  return tasks.filter((task) => {
    if (task.status === "done" || task.status === "missed") return true;
    const dueDay = dueLocalDay(task.dueAt);
    if (dueDay === null) return true;
    return dueDay >= today && dueDay <= end;
  });
}
function buildRows(occurrences, tasks) {
  const entries = [
    ...occurrences.map((o) => ({
      row: {
        kind: "occurrence",
        id: o.id,
        title: o.taskTitle ?? "",
        done: o.status === "done",
        // occurrence 只由每日任务产生，类型恒为 daily
        type: "daily",
        completable: true,
        dueLabel: ""
      },
      due: null
    })),
    ...tasks.filter((t) => t.type !== "daily").map((t) => ({
      row: {
        kind: "task",
        id: t.id,
        title: t.title,
        // `missed` 是失败终点态，与完成同属"已结束"（04 §5.3 v0.39）
        done: t.status === "done" || t.status === "missed",
        type: t.type,
        completable: false,
        dueLabel: hudDueLabel(t.dueAt)
      },
      due: dueTimestamp(t.dueAt)
    }))
  ];
  entries.sort((a, b) => {
    const doneDiff = Number(a.row.done) - Number(b.row.done);
    if (doneDiff !== 0) return doneDiff;
    const rankDiff = TYPE_RANK[a.row.type] - TYPE_RANK[b.row.type];
    if (rankDiff !== 0) return rankDiff;
    if (a.row.type === "daily") return 0;
    if (a.due === null || b.due === null) {
      if (a.due === b.due) return 0;
      return a.due === null ? 1 : -1;
    }
    return a.due - b.due;
  });
  return entries.map((entry) => entry.row);
}
function composeHudBg(background, opacity, themeBg) {
  const rgb = parseHexColor(background ?? "") ?? parseHexColor(themeBg) ?? { r: 255, g: 255, b: 255 };
  const alpha = Math.min(1, Math.max(0, opacity));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}
function parseHexColor(value) {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) return null;
  const hex = match[1];
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16)
  };
}
const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
function HudBall({ data }) {
  const ratio = completionRatio(data.done, data.total);
  const gesture = reactExports.useRef(null);
  const frame = reactExports.useRef(null);
  const clearFrame = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  };
  const send = (point, end) => {
    void window.api.hud.dragTo({ x: point.x, y: point.y, end }).then((res) => {
      if (!res.ok) console.error("[hud] hud.dragTo 失败", res.error);
    }).catch((e) => console.error("[hud] hud.dragTo 调用失败", e));
  };
  const schedule = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const g = gesture.current;
      if (!g || !g.dragging || g.target === null) return;
      send(g.target, false);
    });
  };
  const finish = (allowTap) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    clearFrame();
    if (g.dragging) {
      if (g.target !== null) send(g.target, true);
      return;
    }
    if (!allowTap) return;
    if (Math.abs(g.lastX - g.startX) + Math.abs(g.lastY - g.startY) > TAP_TOLERANCE) return;
    data.actions.setMode("panel");
  };
  reactExports.useEffect(() => () => clearFrame(), []);
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const g = {
      startX: e.screenX,
      startY: e.screenY,
      lastX: e.screenX,
      lastY: e.screenY,
      dragging: false,
      grab: null,
      target: null
    };
    gesture.current = g;
    void window.api.hud.dragBegin().then((res) => {
      if (!res.ok) {
        console.error("[hud] hud.dragBegin 失败", res.error);
        return;
      }
      if (gesture.current !== g) return;
      g.grab = { x: g.startX - res.data.x, y: g.startY - res.data.y };
      if (g.dragging) {
        g.target = { x: g.lastX - g.grab.x, y: g.lastY - g.grab.y };
        schedule();
      }
    }).catch((e2) => console.error("[hud] hud.dragBegin 调用失败", e2));
  };
  const onPointerMove = (e) => {
    const g = gesture.current;
    if (!g) return;
    g.lastX = e.screenX;
    g.lastY = e.screenY;
    if (!g.dragging) {
      if (Math.abs(e.screenX - g.startX) + Math.abs(e.screenY - g.startY) <= TAP_TOLERANCE) return;
      g.dragging = true;
    }
    if (g.grab === null) return;
    g.target = { x: e.screenX - g.grab.x, y: e.screenY - g.grab.y };
    schedule();
  };
  const onPointerUp = (e) => {
    const g = gesture.current;
    if (!g) return;
    g.lastX = e.screenX;
    g.lastY = e.screenY;
    finish(true);
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hud-ball", style: { "--hud-bg": data.hudBg }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hud-bar-ring", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("svg", { width: "20", height: "20", viewBox: "0 0 20 20", "aria-hidden": "true", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("circle", { cx: "10", cy: "10", r: RING_RADIUS, className: "hud-bar-track" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "circle",
        {
          cx: "10",
          cy: "10",
          r: RING_RADIUS,
          className: "hud-bar-value",
          strokeDasharray: `${ratio * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`,
          transform: "rotate(-90 10 10)"
        }
      )
    ] }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hud-bar-ratio", children: ratioLabel(data.done, data.total) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "hud-bar-side", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "hud-bar-temps", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hud-bar-temp", children: tempLabel(data.sensors.cpu) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hud-bar-temp hud-bar-temp--gpu", children: tempLabel(data.sensors.gpu) })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hud-bar-week", children: weekdayLabel(/* @__PURE__ */ new Date()) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "button",
      {
        type: "button",
        className: "hud-hit",
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: () => finish(false),
        onLostPointerCapture: () => finish(false),
        "aria-label": "展开悬浮窗"
      }
    )
  ] });
}
function HudSettings({ data }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hud-settings", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "hud-field", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hud-field-label", children: "背景颜色" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "hud-color",
          type: "color",
          value: data.background,
          onChange: (e) => data.actions.setBackground(e.target.value)
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "hud-field", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hud-field-label", children: "透明度" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "hud-range",
          type: "range",
          min: 0.3,
          max: 1,
          step: 0.05,
          value: data.opacity,
          onChange: (e) => data.actions.setOpacity(Number(e.target.value))
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "hud-close", onClick: () => data.actions.showMain(), children: "打开主界面" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "hud-close", onClick: () => data.actions.close(), children: "关闭悬浮窗" })
  ] });
}
function HudRowItem({
  row,
  error,
  onComplete
}) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { className: "hud-row-item", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "div",
      {
        className: row.completable ? "hud-row hud-row--daily" : "hud-row",
        onClick: row.completable ? void 0 : () => void 0,
        children: [
          row.completable ? /* @__PURE__ */ jsxRuntimeExports.jsx(
            "button",
            {
              type: "button",
              className: row.done ? "hud-check is-done" : "hud-check",
              onClick: () => onComplete(row),
              disabled: row.done,
              "aria-label": row.title,
              "aria-pressed": row.done
            }
          ) : null,
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: row.done ? "hud-row-title is-done" : "hud-row-title", children: row.title }),
          row.dueLabel === "" ? null : /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hud-row-date", children: row.dueLabel })
        ]
      }
    ),
    error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "hud-row-error", children: error }) : null
  ] });
}
function HudAddTask({
  error,
  onAdd
}) {
  const [value, setValue] = reactExports.useState("");
  const submit = () => {
    if (value.trim().length === 0) return;
    void onAdd(value).then((ok) => {
      if (ok) setValue("");
    });
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hud-add", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hud-add-line", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "hud-input",
          value,
          placeholder: "一句话加任务…",
          onChange: (e) => setValue(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "hud-add-submit", onClick: submit, "aria-label": "加任务", children: "＋" })
    ] }),
    error ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "hud-row-error", children: error }) : null
  ] });
}
function HudPanel({ data }) {
  const [tab, setTab] = reactExports.useState("today");
  const setMode = data.actions.setMode;
  reactExports.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") setMode("ball");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setMode]);
  const rowErrorFor = (rowId) => data.rowError && data.rowError.rowId === rowId ? data.rowError.message : null;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hud-panel", style: { "--hud-bg": data.hudBg }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hud-head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "hud-ratio", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hud-dot", "aria-hidden": "true" }),
        ratioLabel(data.done, data.total)
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hud-points", children: todayPointsLabel(data.points) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "hud-grow" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "hud-tabs", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            type: "button",
            className: tab === "today" ? "hud-tab is-active" : "hud-tab",
            onClick: () => setTab("today"),
            children: "今天"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            type: "button",
            className: tab === "settings" ? "hud-tab is-active" : "hud-tab",
            onClick: () => setTab("settings"),
            children: "设置"
          }
        )
      ] })
    ] }),
    tab === "today" ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "hud-list", children: data.rows.map((row) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        HudRowItem,
        {
          row,
          error: rowErrorFor(row.id),
          onComplete: data.actions.completeRow
        },
        `${row.kind}:${row.id}`
      )) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(HudAddTask, { error: rowErrorFor("add"), onAdd: data.actions.addTask })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx(HudSettings, { data })
  ] });
}
const ACTIVE_STATUS = /* @__PURE__ */ new Set(["todo", "doing", "reviewing", "pending_review"]);
const ERROR_TTL_MS = 4e3;
const SENSORS_POLL_MS = 2e3;
const DEFAULT_THEME_BG = "#ffffff";
const EMPTY = {
  ready: false,
  mode: "ball",
  occurrences: [],
  tasks: [],
  points: 0,
  background: null,
  opacity: 1,
  sensors: { cpu: null, gpu: null }
};
function readThemeBg() {
  if (typeof window === "undefined") return DEFAULT_THEME_BG;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  return value.length > 0 ? value : DEFAULT_THEME_BG;
}
function upsertOccurrences(list, incoming, titleOf) {
  const today = toLocalDay(/* @__PURE__ */ new Date());
  const map = new Map(list.filter((o) => o.day === today).map((o) => [o.id, o]));
  for (const o of incoming) {
    if (o.day !== today) continue;
    const prev = map.get(o.id);
    map.set(o.id, {
      ...o,
      taskTitle: o.taskTitle ?? prev?.taskTitle ?? titleOf(o.taskId),
      taskType: o.taskType ?? prev?.taskType
    });
  }
  return [...map.values()];
}
function upsertTask(list, task) {
  const index = list.findIndex((t) => t.id === task.id);
  const today = toLocalDay(/* @__PURE__ */ new Date());
  const keep = ACTIVE_STATUS.has(task.status) || toLocalDay(new Date(task.updatedAt)) === today;
  if (!keep) {
    return index >= 0 ? list.filter((t) => t.id !== task.id) : list;
  }
  if (index < 0) return [...list, task];
  const next = [...list];
  next[index] = task;
  return next;
}
function mergeTodayFinished(active, finished) {
  const today = toLocalDay(/* @__PURE__ */ new Date());
  const map = new Map(active.map((t) => [t.id, t]));
  for (const task of finished) {
    if (toLocalDay(new Date(task.updatedAt)) !== today) continue;
    if (!map.has(task.id)) map.set(task.id, task);
  }
  return [...map.values()];
}
function useHudData() {
  const [snapshot, setSnapshot] = reactExports.useState(EMPTY);
  const [rowError, setRowError] = reactExports.useState(null);
  const errorTimer = reactExports.useRef(null);
  const sensorsWarned = reactExports.useRef(false);
  const themeBg = reactExports.useMemo(readThemeBg, []);
  const showError = reactExports.useCallback((rowId, message) => {
    setRowError({ rowId, message });
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setRowError(null), ERROR_TTL_MS);
  }, []);
  reactExports.useEffect(() => {
    let alive = true;
    const handleEvent = (event) => {
      setSnapshot((prev) => {
        const titleOf = (taskId) => prev.tasks.find((t) => t.id === taskId)?.title;
        switch (event.type) {
          case "occurrence.created":
            return {
              ...prev,
              occurrences: upsertOccurrences(prev.occurrences, event.occurrences, titleOf)
            };
          case "occurrence.updated":
            return {
              ...prev,
              occurrences: upsertOccurrences(prev.occurrences, [event.occurrence], titleOf)
            };
          case "task.created":
          case "task.updated":
            return { ...prev, tasks: upsertTask(prev.tasks, event.task) };
          case "task.removed":
            return {
              ...prev,
              tasks: prev.tasks.filter((t) => t.id !== event.taskId),
              occurrences: prev.occurrences.filter((o) => o.taskId !== event.taskId)
            };
          case "points.changed":
            return { ...prev, points: event.today.points };
          case "daystats.changed":
            return event.day.day === toLocalDay(/* @__PURE__ */ new Date()) ? { ...prev, points: event.day.points } : prev;
          case "hud.mode.changed":
            return { ...prev, mode: event.mode };
          case "app.setting.changed":
            if (event.key === "hud.background") {
              return { ...prev, background: typeof event.value === "string" ? event.value : null };
            }
            if (event.key === "hud.opacity" && typeof event.value === "number") {
              return { ...prev, opacity: event.value };
            }
            return prev;
          default:
            return prev;
        }
      });
    };
    const off = window.api.onEvent(handleEvent);
    void Promise.all([
      window.api.hud.getState(),
      window.api.app.getBootstrap(),
      window.api.task.list({ status: ["done", "missed"] })
    ]).then(([state, bootstrap, finished]) => {
      if (!alive) return;
      if (!state.ok) {
        console.error("[hud] hud.getState 失败", state.error);
        return;
      }
      if (!bootstrap.ok) {
        console.error("[hud] app.getBootstrap 失败", bootstrap.error);
        return;
      }
      if (!finished.ok) console.error("[hud] task.list 补拉失败", finished.error);
      const { tasks, todayOccurrences, today: today2, settings } = bootstrap.data;
      setSnapshot({
        ready: true,
        // 形态以窗口状态为准（settings 里的是上次落库值，可能还没同步到窗口）
        mode: state.data.mode,
        occurrences: todayOccurrences,
        tasks: mergeTodayFinished(tasks, finished.ok ? finished.data : []),
        points: today2.points,
        background: settings["hud.background"],
        opacity: settings["hud.opacity"],
        sensors: EMPTY.sensors
      });
    }).catch((e) => console.error("[hud] 首载失败", e));
    return () => {
      alive = false;
      off();
      if (errorTimer.current) clearTimeout(errorTimer.current);
    };
  }, []);
  reactExports.useEffect(() => {
    if (snapshot.mode !== "ball") return;
    let alive = true;
    const pull = () => {
      void window.api.hud.sensors().then((res) => {
        if (!alive) return;
        if (!res.ok) {
          if (!sensorsWarned.current) {
            sensorsWarned.current = true;
            console.warn("[hud] hud.sensors 失败", res.error);
          }
          setSnapshot((prev) => ({ ...prev, sensors: { cpu: null, gpu: null } }));
          return;
        }
        setSnapshot((prev) => ({
          ...prev,
          sensors: { cpu: res.data.cpu, gpu: res.data.gpu }
        }));
      }).catch((e) => {
        if (!alive) return;
        if (!sensorsWarned.current) {
          sensorsWarned.current = true;
          console.warn("[hud] hud.sensors 调用失败", e);
        }
        setSnapshot((prev) => ({ ...prev, sensors: { cpu: null, gpu: null } }));
      });
    };
    pull();
    const timer = setInterval(pull, SENSORS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [snapshot.mode]);
  const refreshMode = reactExports.useCallback(() => {
    void window.api.hud.getState().then((res) => {
      if (!res.ok) {
        console.error("[hud] hud.getState 失败", res.error);
        return;
      }
      setSnapshot((prev) => ({ ...prev, mode: res.data.mode }));
    }).catch((e) => console.error("[hud] hud.getState 调用失败", e));
  }, []);
  const setMode = reactExports.useCallback(
    (mode) => {
      setSnapshot((prev) => prev.mode === mode ? prev : { ...prev, mode });
      void window.api.hud.setMode({ mode }).then((res) => {
        if (!res.ok) {
          console.error("[hud] hud.setMode 失败", res.error);
          refreshMode();
        }
      }).catch((e) => console.error("[hud] hud.setMode 调用失败", e));
    },
    [refreshMode]
  );
  const completeRow = reactExports.useCallback(
    (row) => {
      if (!row.completable) return;
      if (row.done) return;
      void window.api.occurrence.complete({ id: row.id }).then((res) => {
        if (!res.ok) showError(row.id, res.error.message);
      }).catch((e) => console.error("[hud] occurrence.complete 调用失败", e));
    },
    [showError]
  );
  const addTask = reactExports.useCallback(
    (title) => {
      const text = title.trim();
      if (text.length === 0) return Promise.resolve(false);
      return window.api.task.createManual({ type: "deadline", title: text, patch: { difficulty: "medium" } }).then((res) => {
        if (!res.ok) {
          showError("add", res.error.message);
          return false;
        }
        return true;
      }).catch((e) => {
        console.error("[hud] task.createManual 调用失败", e);
        return false;
      });
    },
    [showError]
  );
  const setBackground = reactExports.useCallback((color) => {
    setSnapshot((prev) => ({ ...prev, background: color }));
    void window.api.app.setSetting({ key: "hud.background", value: color }).then((res) => {
      if (!res.ok) console.error("[hud] hud.background 写入失败", res.error);
    }).catch((e) => console.error("[hud] hud.background 写入失败", e));
  }, []);
  const setOpacity = reactExports.useCallback((value) => {
    setSnapshot((prev) => ({ ...prev, opacity: value }));
    void window.api.app.setSetting({ key: "hud.opacity", value }).then((res) => {
      if (!res.ok) console.error("[hud] hud.opacity 写入失败", res.error);
    }).catch((e) => console.error("[hud] hud.opacity 写入失败", e));
  }, []);
  const showMain = reactExports.useCallback(() => {
    void window.api.app.showMain().then((res) => {
      if (!res.ok) console.error("[hud] app.showMain 失败", res.error);
    }).catch((e) => console.error("[hud] app.showMain 调用失败", e));
  }, []);
  const close = reactExports.useCallback(() => {
    void window.api.hud.setVisible({ visible: false }).then((res) => {
      if (!res.ok) console.error("[hud] hud.setVisible 失败", res.error);
    }).catch((e) => console.error("[hud] hud.setVisible 调用失败", e));
  }, []);
  const today = toLocalDay(/* @__PURE__ */ new Date());
  const rows = reactExports.useMemo(
    () => buildRows(snapshot.occurrences, withinHudWindow(snapshot.tasks, today)),
    [snapshot.occurrences, snapshot.tasks, today]
  );
  const done = rows.filter((row) => row.done).length;
  const total = rows.length;
  const hudBg = composeHudBg(snapshot.background, snapshot.opacity, themeBg);
  return {
    ready: snapshot.ready,
    mode: snapshot.mode,
    done,
    total,
    points: snapshot.points,
    rows,
    rowError,
    hudBg,
    background: snapshot.background ?? themeBg,
    opacity: snapshot.opacity,
    sensors: snapshot.sensors,
    actions: { setMode, completeRow, addTask, setBackground, setOpacity, showMain, close }
  };
}
function HudRoot() {
  const data = useHudData();
  const shell = data.mode === "ball" ? "hud-root hud-root--ball" : "hud-root hud-root--panel";
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: shell, children: data.ready ? data.mode === "ball" ? /* @__PURE__ */ jsxRuntimeExports.jsx(HudBall, { data }) : /* @__PURE__ */ jsxRuntimeExports.jsx(HudPanel, { data }) : null });
}
const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
createRoot(container).render(
  /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.StrictMode, { children: /* @__PURE__ */ jsxRuntimeExports.jsx(HudRoot, {}) })
);
console.log(`[renderer:hud] RUBRIC_VERSION=${RUBRIC_VERSION}`);
