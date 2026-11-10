import { r as reactExports, j as jsxRuntimeExports, a as reactDomExports, c as createRoot } from "./client-B34VK5kX.js";
import { c as computePlannedPoints, b as duePrecisionOf, d as dueLocalDay, f as fmtPoints, a as dueInstant, D as DEFAULT_CONFIG, e as computeAwardedPoints, t as toLocalDay, g as toDatetimeLocal, h as fmtDueLabel, i as fmtRemaining, j as fmtMoney, R as RUBRIC_VERSION } from "./format-lT38jDfF.js";
const MAX_LINES = 6;
const LINE_HEIGHT = 22;
const MAX_HEIGHT = MAX_LINES * LINE_HEIGHT;
const MAX_FILES = 4;
let localSeq = 0;
function ChatInput({
  sending,
  mode,
  onSend,
  onToggleMode,
  pendingText,
  onPendingTextUsed
}) {
  const [value, setValue] = reactExports.useState("");
  const [files, setFiles] = reactExports.useState([]);
  const areaRef = reactExports.useRef(null);
  const fileRef = reactExports.useRef(null);
  reactExports.useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);
  reactExports.useEffect(() => {
    if (pendingText === null) return;
    setValue(pendingText);
    for (const item of files) URL.revokeObjectURL(item.previewUrl);
    setFiles([]);
    onPendingTextUsed();
    areaRef.current?.focus();
  }, [pendingText]);
  const canSend = !sending && (value.trim().length > 0 || files.length > 0);
  const submit = async () => {
    if (!canSend) return;
    const ok = await onSend(
      value,
      files.map((item) => item.file)
    );
    if (!ok) return;
    setValue("");
    for (const item of files) URL.revokeObjectURL(item.previewUrl);
    setFiles([]);
    areaRef.current?.focus();
  };
  const addFiles = (list) => {
    const incoming = Array.from(list);
    if (incoming.length === 0) return;
    setFiles((prev) => {
      const room = Math.max(0, MAX_FILES - prev.length);
      if (room === 0) return prev;
      return [
        ...prev,
        ...incoming.slice(0, room).map((file) => {
          localSeq += 1;
          return { key: `local-att-${localSeq}`, file, previewUrl: URL.createObjectURL(file) };
        })
      ];
    });
  };
  const removeFile = (key) => {
    setFiles((prev) => {
      const target = prev.find((item) => item.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.key !== key);
    });
  };
  const onKeyDown = (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };
  const onPaste = (event) => {
    const images = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file) => file !== null);
    if (images.length === 0) return;
    event.preventDefault();
    addFiles(images);
  };
  const onDrop = (event) => {
    event.preventDefault();
    addFiles(event.dataTransfer.files);
  };
  const onPick = (event) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = "";
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      className: "chat-input",
      onDragOver: (event) => event.preventDefault(),
      onDrop,
      children: [
        files.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ci-thumbs", children: files.map(
          (item) => item.file.type.startsWith("image/") ? /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "ci-thumb", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("img", { alt: "", className: "ci-thumb-img", src: item.previewUrl }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "ci-thumb-remove", onClick: () => removeFile(item.key), type: "button", children: "×" })
          ] }, item.key) : /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "ci-file", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ci-file-name", children: item.file.name }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "ci-thumb-remove", onClick: () => removeFile(item.key), type: "button", children: "×" })
          ] }, item.key)
        ) }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ci-row", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "button",
            {
              "aria-label": "附件",
              className: "ci-plus",
              onClick: () => fileRef.current?.click(),
              type: "button",
              children: "+"
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              accept: "image/*",
              className: "ci-file-input",
              multiple: true,
              onChange: onPick,
              ref: fileRef,
              type: "file"
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "button",
            {
              "aria-pressed": mode === "chat",
              className: `ci-mode ${mode === "chat" ? "ci-mode--chat" : "ci-mode--task"}`,
              onClick: onToggleMode,
              type: "button",
              children: mode === "chat" ? "聊天模式" : "任务模式"
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "textarea",
            {
              "aria-label": "消息",
              className: "ci-textarea",
              onChange: (event) => setValue(event.target.value),
              onKeyDown,
              onPaste,
              placeholder: "",
              ref: areaRef,
              rows: 1,
              value
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("button", { className: "ci-send", disabled: !canSend, onClick: () => void submit(), type: "button", children: [
            sending ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ci-ring" }) : null,
            "发送"
          ] })
        ] })
      ]
    }
  );
}
const DIFFICULTY_ORDER = [
  "trivial",
  "easy",
  "medium",
  "hard",
  "epic"
];
const ALLOWED_DIFFICULTIES = {
  daily: ["trivial", "easy", "medium"],
  deadline: ["easy", "medium", "hard"],
  event: ["medium", "hard", "epic"]
};
const TYPE_LABEL = {
  daily: "每日",
  deadline: "限时",
  event: "活动"
};
function snapDifficulty(type, difficulty) {
  const allowed = ALLOWED_DIFFICULTIES[type];
  if (allowed.includes(difficulty)) return difficulty;
  const target = DIFFICULTY_ORDER.indexOf(difficulty);
  let best = allowed[0];
  let bestDist = Math.abs(DIFFICULTY_ORDER.indexOf(best) - target);
  for (const candidate of allowed) {
    const dist = Math.abs(DIFFICULTY_ORDER.indexOf(candidate) - target);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}
const TYPE_ORDER = ["daily", "deadline", "event"];
const DIFFICULTY_LABEL = {
  trivial: "琐事",
  easy: "简单",
  medium: "中等",
  hard: "费劲",
  epic: "大工程"
};
const TYPE_DEFAULT_OFFSETS = {
  daily: [],
  deadline: [-1440, -60],
  event: [-10080, -4320, -1440]
};
function pointsConfigOf(settings) {
  return {
    difficultyBase: settings["points.difficultyBase"],
    deadlineBase: settings["points.deadlineBase"],
    dailyBase: settings["points.dailyBase"],
    streakBonus: settings["points.streakBonus"],
    dailyCap: settings["points.dailyCap"]
  };
}
function draftPointsOf(draft2, cfg) {
  return draft2.type === "daily" ? cfg.dailyBase : computePlannedPoints(draft2.type, draft2.difficulty, cfg);
}
function normalizeDraft(draft2, cfg) {
  const difficulty = snapDifficulty(draft2.type, draft2.difficulty);
  return {
    ...draft2,
    difficulty,
    pointsPlanned: draftPointsOf({ type: draft2.type, difficulty }, cfg)
  };
}
function offsetLabel(min) {
  const abs = Math.abs(min);
  if (abs % 1440 === 0) return `前 ${abs / 1440} 天`;
  if (abs % 60 === 0) return `前 ${abs / 60} 小时`;
  return `前 ${abs} 分钟`;
}
function leadLabel(leadHours, overdueDays = 0) {
  if (leadHours < 0) {
    if (overdueDays >= 1) return `逾期 ${overdueDays} 天`;
    const late = Math.floor(-leadHours);
    return late >= 1 ? `逾期 ${late} 小时` : "";
  }
  const hours = Math.floor(leadHours);
  if (hours < 1) return "";
  if (hours >= 24 && hours % 24 === 0) return `提前 ${hours / 24} 天`;
  return `提前 ${hours} 小时`;
}
function reminderSummary(type, dailyTime, offsets) {
  if (type === "daily") return dailyTime ? `每日 ${dailyTime}` : "";
  return offsets.map(offsetLabel).join(" · ");
}
function mimeExt(mime) {
  if (!mime) return "";
  const sub = mime.split("/")[1];
  if (!sub) return "";
  return sub.split("+")[0].toLowerCase();
}
function formatClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function dueHintToLocal(hint) {
  if (!hint) return "";
  const precision = duePrecisionOf(hint);
  if (precision === null) return "";
  if (precision === "minute") {
    const d = new Date(hint);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const day = dueLocalDay(hint);
  return day === null ? "" : `${day}T00:00`;
}
function localToDueHint(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}
function visibleChatMessages(messages, hiddenTaskIds) {
  const latestByTask = /* @__PURE__ */ new Map();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const meta = messages[i].meta;
    if (meta.kind !== "task_review") continue;
    if (!latestByTask.has(meta.taskId)) latestByTask.set(meta.taskId, messages[i].id);
  }
  return messages.filter((message) => {
    const meta = message.meta;
    if (meta.kind !== "task_review") return true;
    if (hiddenTaskIds.has(meta.taskId)) return false;
    return latestByTask.get(meta.taskId) === message.id;
  });
}
function latestNeedEvidenceHint(messages) {
  const hints = {};
  const seen = /* @__PURE__ */ new Set();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const meta = messages[i].meta;
    if (meta.kind !== "task_review") continue;
    if (seen.has(meta.taskId)) continue;
    seen.add(meta.taskId);
    if (meta.verdict.verdict !== "need_evidence") continue;
    const followup = meta.verdict.followup;
    if (typeof followup === "string" && followup.trim().length > 0) hints[meta.taskId] = followup;
  }
  return hints;
}
function latestReviewGaps(messages) {
  const gaps = {};
  const seen = /* @__PURE__ */ new Set();
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const meta = messages[i].meta;
    if (meta.kind !== "task_review") continue;
    if (seen.has(meta.taskId)) continue;
    seen.add(meta.taskId);
    if (meta.verdict.gaps.length > 0) gaps[meta.taskId] = meta.verdict.gaps;
  }
  return gaps;
}
function toEvidenceViews(evidence, attachments) {
  const views = [];
  evidence.forEach((item, i) => {
    if (item.kind === "text") {
      views.push({
        index: i,
        key: `${item.addedAt}-${i}`,
        kind: "text",
        text: item.text,
        url: null,
        attachmentKind: null,
        mime: null
      });
      return;
    }
    const file = attachments[item.attachmentId];
    if (!file) return;
    views.push({
      index: i,
      key: `${item.addedAt}-${i}`,
      kind: "attachment",
      text: null,
      url: file.url,
      attachmentKind: file.kind,
      mime: file.mime
    });
  });
  return views;
}
function filesFromDrop(files, canAccept) {
  if (!canAccept) return [];
  if (files === null || files.length === 0) return [];
  return Array.from(files);
}
function EvidenceChip({
  item,
  onOpen,
  onRemove,
  busy
}) {
  const del = onRemove === void 0 ? null : /* @__PURE__ */ jsxRuntimeExports.jsx(
    "button",
    {
      className: "ev-remove",
      disabled: busy,
      onClick: () => onRemove(item.index),
      type: "button",
      children: "×"
    }
  );
  if (item.kind === "attachment" && item.attachmentKind === "image" && item.url) {
    return /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "ev-thumb", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("img", { alt: "", className: "ev-thumb-img", onClick: () => onOpen(item.url), src: item.url }),
      del
    ] });
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: `ev-text ${item.kind === "attachment" ? "ev-file" : ""}`, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ev-text-body", children: item.kind === "attachment" ? mimeExt(item.mime) : item.text }),
    del
  ] });
}
function EvidencePanel({
  evidence,
  busy,
  canAdd,
  openSignal,
  onPick,
  onOpen,
  onRemove
}) {
  const inputRef = reactExports.useRef(null);
  const [over, setOver] = reactExports.useState(false);
  const droppingRef = reactExports.useRef(false);
  reactExports.useEffect(() => {
    if (openSignal > 0) inputRef.current?.click();
  }, [openSignal]);
  const accept = canAdd && !busy;
  const handleDragOver = (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = accept ? "copy" : "none";
  };
  const handleDragEnter = () => {
    if (accept) setOver(true);
  };
  const handleDragLeave = (event) => {
    const next = event.relatedTarget;
    if (next !== null && event.currentTarget.contains(next)) return;
    setOver(false);
  };
  const handleDrop = (event) => {
    event.preventDefault();
    setOver(false);
    const files = filesFromDrop(event.dataTransfer.files, accept);
    if (files.length === 0) return;
    if (droppingRef.current) return;
    droppingRef.current = true;
    void (async () => {
      try {
        for (const file of files) await onPick(file);
      } finally {
        droppingRef.current = false;
      }
    })();
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      className: `review-evidence${over && accept ? " review-evidence--over" : ""}`,
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "review-evidence-label", children: "证据" }),
        evidence.map((item) => /* @__PURE__ */ jsxRuntimeExports.jsx(EvidenceChip, { busy, item, onOpen, onRemove }, item.key)),
        canAdd ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "button",
            {
              "aria-label": "添加文件",
              className: "ev-add",
              disabled: busy,
              onClick: () => inputRef.current?.click(),
              type: "button",
              children: "+"
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              className: "ev-file-input",
              disabled: busy,
              onChange: (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void onPick(file);
              },
              ref: inputRef,
              type: "file"
            }
          )
        ] }) : null
      ]
    }
  );
}
const ERROR_MS$1 = 2600;
function SubmitCard({
  task,
  evidence,
  hint,
  gaps,
  busy,
  onPick,
  onRemove,
  onAddText,
  onCancel,
  onSubmit
}) {
  const [opened, setOpened] = reactExports.useState(null);
  const [error, setError] = reactExports.useState(null);
  const [noteOpen, setNoteOpen] = reactExports.useState(false);
  const [note, setNote] = reactExports.useState("");
  const [localBusy, setLocalBusy] = reactExports.useState(false);
  const disabled = busy || localBusy;
  reactExports.useEffect(() => {
    if (error === null) return;
    const timer = window.setTimeout(() => setError(null), ERROR_MS$1);
    return () => window.clearTimeout(timer);
  }, [error]);
  const runAction = (fn) => {
    if (disabled) return Promise.resolve();
    setLocalBusy(true);
    return fn().then((message) => {
      if (message) setError(message);
    }).finally(() => setLocalBusy(false));
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "submit-card", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "review-head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "review-title", children: task.title }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "review-meta", children: [
        TYPE_LABEL[task.type],
        " · ",
        fmtPoints(task.pointsPlanned),
        "分"
      ] })
    ] }),
    hint ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "review-reason", children: hint }) : null,
    gaps.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "review-gaps", children: gaps.map((item) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: item }, item)) }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      EvidencePanel,
      {
        busy: disabled,
        canAdd: true,
        evidence,
        onOpen: setOpened,
        onPick: (file) => runAction(() => onPick(file)),
        onRemove: (index) => void runAction(() => onRemove(index)),
        openSignal: 0
      }
    ),
    noteOpen ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-editor", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "textarea",
        {
          autoFocus: true,
          className: "note-input",
          maxLength: 200,
          onChange: (event) => setNote(event.target.value),
          placeholder: "写一句说明",
          rows: 2,
          value: note
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-actions", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "btn btn--ghost",
            onClick: () => {
              setNoteOpen(false);
              setNote("");
            },
            type: "button",
            children: "取消"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "btn btn--primary",
            disabled: disabled || note.trim().length === 0,
            onClick: () => void runAction(async () => {
              const message = await onAddText(note);
              if (message === null) {
                setNote("");
                setNoteOpen(false);
              }
              return message;
            }),
            type: "button",
            children: "确认"
          }
        )
      ] })
    ] }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "review-actions", children: [
      evidence.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "submit-hint", children: "还没有证据" }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "btn btn--ghost",
          disabled,
          onClick: () => {
            setNoteOpen(true);
          },
          type: "button",
          children: "写说明"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "btn btn--ghost",
          disabled,
          onClick: () => runAction(onCancel),
          type: "button",
          children: "取消"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "btn btn--primary",
          disabled: disabled || evidence.length === 0,
          onClick: () => runAction(onSubmit),
          type: "button",
          children: "提交"
        }
      )
    ] }),
    error !== null ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "submit-error", children: error }) : null,
    opened ? reactDomExports.createPortal(
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "lightbox", onClick: () => setOpened(null), role: "presentation", children: /* @__PURE__ */ jsxRuntimeExports.jsx("img", { alt: "", className: "lightbox-img", src: opened }) }),
      document.body
    ) : null
  ] });
}
const BULLET = /^[-*]\s+(.*)$/;
const ORDERED = /^\d+\.\s+(.*)$/;
function parseBlocks(text) {
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: "p", lines: para });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flushPara();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }
    const ordered = ORDERED.exec(line);
    if (ordered) {
      flushPara();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;
function renderInline(text, prefix) {
  const out = [];
  let last = 0;
  let i = 0;
  INLINE.lastIndex = 0;
  let m = INLINE.exec(text);
  while (m !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${prefix}-${i++}`;
    if (token.startsWith("**")) {
      out.push(/* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: token.slice(2, -2) }, key));
    } else {
      out.push(
        /* @__PURE__ */ jsxRuntimeExports.jsx("code", { className: "md-code", children: token.slice(1, -1) }, key)
      );
    }
    last = m.index + token.length;
    m = INLINE.exec(text);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function MarkdownText({ text }) {
  const blocks = parseBlocks(text);
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "md", children: blocks.map((block, bi) => {
    if (block.type === "p") {
      const children = [];
      block.lines.forEach((line, li) => {
        if (li > 0) children.push(/* @__PURE__ */ jsxRuntimeExports.jsx("br", {}, `br-${bi}-${li}`));
        children.push(...renderInline(line, `p-${bi}-${li}`));
      });
      return /* @__PURE__ */ jsxRuntimeExports.jsx("p", { children }, `b-${bi}`);
    }
    const items = block.items.map((item, li) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: renderInline(item, `l-${bi}-${li}`) }, `b-${bi}-${li}`));
    return block.type === "ul" ? /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { children: items }, `b-${bi}`) : /* @__PURE__ */ jsxRuntimeExports.jsx("ol", { children: items }, `b-${bi}`);
  }) });
}
function ImageGlyphIcon() {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "svg",
    {
      fill: "none",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.7,
      viewBox: "0 0 24 24",
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("rect", { height: "16", rx: "2.5", width: "18", x: "3", y: "4" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("circle", { cx: "8.5", cy: "9.5", r: "1.5" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: "M21 16l-4.5-4.5L9 19" })
      ]
    }
  );
}
function FileGlyphIcon() {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "svg",
    {
      fill: "none",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.7,
      viewBox: "0 0 24 24",
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: "M14 3v5h5" })
      ]
    }
  );
}
function CopyIcon() {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "svg",
    {
      fill: "none",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.7,
      viewBox: "0 0 24 24",
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("rect", { height: "12", rx: "2", width: "10", x: "9", y: "9" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: "M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" })
      ]
    }
  );
}
function CheckIcon() {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "svg",
    {
      fill: "none",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.7,
      viewBox: "0 0 24 24",
      children: /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: "M4 12.5l5 5L20 6.5" })
    }
  );
}
function UndoIcon() {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "svg",
    {
      fill: "none",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.7,
      viewBox: "0 0 24 24",
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: "M4 9h10a5 5 0 0 1 0 10h-4" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: "M8 5L4 9l4 4" })
      ]
    }
  );
}
function PencilIcon() {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "svg",
    {
      fill: "none",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 1.7,
      viewBox: "0 0 24 24",
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: "M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: "M14.5 6.5L17.5 9.5" })
      ]
    }
  );
}
const COPIED_MS = 1500;
function TextBubble({ message, onRecall, onEdit }) {
  const isUser = message.role === "user";
  const attachments = message.attachments.slice(0, 4);
  const clock = formatClock(message.createdAt);
  const hasText = message.contentMd.trim().length > 0;
  const [copied, setCopied] = reactExports.useState(false);
  const timer = reactExports.useRef(null);
  reactExports.useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.contentMd);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setCopied(false);
      }, COPIED_MS);
    } catch (e) {
      console.error("[chat] 复制失败", e);
    }
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: `msg-line ${isUser ? "msg-line--user" : "msg-line--assistant"}`, children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `msg-stack ${isUser ? "msg-stack--user" : "msg-stack--assistant"}`, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `bubble ${isUser ? "bubble--user" : "bubble--assistant"}`, children: [
      attachments.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "msg-chips", children: attachments.map((item) => /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "msg-chip", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "msg-chip-icon", children: item.kind === "image" ? /* @__PURE__ */ jsxRuntimeExports.jsx(ImageGlyphIcon, {}) : /* @__PURE__ */ jsxRuntimeExports.jsx(FileGlyphIcon, {}) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "msg-chip-name", children: item.name || item.mime }),
        item.kind === "image" ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "msg-chip-pop", children: /* @__PURE__ */ jsxRuntimeExports.jsx("img", { alt: "", src: item.url }) }) : null
      ] }, item.id)) }) : null,
      message.contentMd ? /* @__PURE__ */ jsxRuntimeExports.jsx(MarkdownText, { text: message.contentMd }) : null
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "msg-actions", children: [
      clock ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "msg-time", children: clock }) : null,
      hasText ? /* @__PURE__ */ jsxRuntimeExports.jsx("button", { "aria-label": "复制", className: "msg-act", onClick: () => void copy(), type: "button", children: copied ? /* @__PURE__ */ jsxRuntimeExports.jsx(CheckIcon, {}) : /* @__PURE__ */ jsxRuntimeExports.jsx(CopyIcon, {}) }) : null,
      onRecall ? /* @__PURE__ */ jsxRuntimeExports.jsx("button", { "aria-label": "撤回", className: "msg-act", onClick: onRecall, type: "button", children: /* @__PURE__ */ jsxRuntimeExports.jsx(UndoIcon, {}) }) : null,
      onEdit ? /* @__PURE__ */ jsxRuntimeExports.jsx("button", { "aria-label": "编辑", className: "msg-act", onClick: onEdit, type: "button", children: /* @__PURE__ */ jsxRuntimeExports.jsx(PencilIcon, {}) }) : null
    ] })
  ] }) });
}
function TaskDraftCard({ view, actions }) {
  const { draft: draft2, dueLocal, confirmedTaskId } = view;
  const confirmed = confirmedTaskId !== null;
  const [expanded, setExpanded] = reactExports.useState(false);
  const patch = (next) => {
    if (confirmed) return;
    actions.patchDraft(draft2.localId, next);
  };
  const summary = reminderSummary(draft2.type, draft2.dailyTimeHint, draft2.reminderOffsets);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      className: [
        "draft-card",
        draft2.confidence < 0.5 ? "draft-card--low" : "",
        confirmed ? "draft-card--confirmed" : ""
      ].filter(Boolean).join(" "),
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "draft-types", children: TYPE_ORDER.map((type) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            "aria-pressed": draft2.type === type,
            className: `draft-type ${draft2.type === type ? "draft-type--on" : ""}`,
            disabled: confirmed,
            onClick: () => patch({ type }),
            type: "button",
            children: TYPE_LABEL[type]
          },
          type
        )) }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "draft-title-row", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              "aria-label": "标题",
              className: "draft-title",
              disabled: confirmed,
              onChange: (event) => patch({ title: event.target.value }),
              value: draft2.title
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "draft-points", children: [
            "+",
            fmtPoints(draft2.pointsPlanned)
          ] })
        ] }),
        draft2.detailMd ? /* @__PURE__ */ jsxRuntimeExports.jsx(
          "div",
          {
            className: `draft-detail ${expanded ? "" : "draft-detail--clamp"}`,
            onClick: () => setExpanded((value) => !value),
            role: "presentation",
            children: /* @__PURE__ */ jsxRuntimeExports.jsx(MarkdownText, { text: draft2.detailMd })
          }
        ) : null,
        draft2.steps.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "draft-steps", children: draft2.steps.map((step) => /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "draft-step-dot" }),
          step.title
        ] }, step.localId)) }) : null,
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "draft-fields", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "draft-field", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "draft-field-label", children: "难度" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "select",
              {
                "aria-label": "难度",
                className: "draft-select",
                disabled: confirmed,
                onChange: (event) => patch({ difficulty: event.target.value }),
                value: draft2.difficulty,
                children: ALLOWED_DIFFICULTIES[draft2.type].map((item) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: item, children: DIFFICULTY_LABEL[item] }, item))
              }
            )
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "draft-field", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "input",
              {
                "aria-label": "时长",
                className: "draft-num",
                disabled: confirmed,
                min: 0,
                onChange: (event) => patch({ estimateMin: event.target.value === "" ? null : Number(event.target.value) }),
                step: 5,
                type: "number",
                value: draft2.estimateMin ?? ""
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "draft-field-label", children: "分钟" })
          ] }),
          draft2.type === "daily" ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "input",
              {
                "aria-label": "每日时刻",
                className: "draft-time",
                disabled: confirmed,
                onChange: (event) => patch({ dailyTimeHint: event.target.value || null }),
                type: "time",
                value: draft2.dailyTimeHint ?? ""
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "input",
              {
                "aria-label": "结束日期",
                className: "draft-time draft-time--date",
                disabled: confirmed,
                onChange: (event) => patch({ activeToHint: event.target.value || null }),
                type: "date",
                value: draft2.activeToHint ?? ""
              }
            )
          ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              "aria-label": "时间",
              className: "draft-time",
              disabled: confirmed,
              onChange: (event) => patch({ dueHint: localToDueHint(event.target.value) }),
              type: "datetime-local",
              value: dueLocal
            }
          ),
          confirmed ? null : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "draft-actions", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "button",
              {
                className: "btn btn--ghost",
                onClick: () => actions.rejectDraft(draft2.localId),
                type: "button",
                children: "丢弃"
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "button",
              {
                className: "btn btn--primary",
                onClick: () => actions.confirmDraft(draft2.localId),
                type: "button",
                children: "确认"
              }
            )
          ] })
        ] }),
        summary ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "draft-reminders", children: summary }) : null,
        draft2.missingInfo.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "draft-missing", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "draft-missing-label", children: "待补" }),
          draft2.missingInfo.map((item) => /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "chip", children: item }, item))
        ] }) : null,
        confirmedTaskId ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "draft-linked", children: confirmedTaskId }) : null
      ]
    }
  );
}
const ERROR_MS = 2600;
function TaskReviewCard({ view, verdict, actions }) {
  const [opened, setOpened] = reactExports.useState(null);
  const [busy, setBusy] = reactExports.useState(false);
  const [error, setError] = reactExports.useState(null);
  const [openSignal, setOpenSignal] = reactExports.useState(0);
  const [noteOpen, setNoteOpen] = reactExports.useState(false);
  const [note, setNote] = reactExports.useState("");
  const { task, planned, evidence, needEvidenceCount, leadLabel: leadLabel2, isLatest } = view;
  const isNeed = verdict.verdict === "need_evidence";
  const actionable = isNeed && isLatest && task.status === "reviewing";
  const canAdd = task.status === "todo" || task.status === "doing" || task.status === "pending_review" || task.status === "reviewing";
  reactExports.useEffect(() => {
    if (error === null) return;
    const timer = window.setTimeout(() => setError(null), ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [error]);
  const runAction = (fn) => {
    if (busy) return Promise.resolve();
    setBusy(true);
    return fn().then((message) => {
      if (message) setError(message);
    }).finally(() => setBusy(false));
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `review-card review-card--${verdict.verdict}`, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "review-head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "review-title", children: task.title }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "review-meta", children: [
        TYPE_LABEL[task.type],
        " · ",
        fmtPoints(planned),
        "分",
        leadLabel2 ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "review-lead", children: leadLabel2 }) : null
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "review-reason", children: isNeed ? verdict.followup ?? verdict.reason : verdict.reason }),
    verdict.gaps.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "review-gaps", children: verdict.gaps.map((item) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: item }, item)) }) : null,
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      EvidencePanel,
      {
        busy,
        canAdd,
        evidence,
        onOpen: setOpened,
        onPick: (file) => runAction(() => actions.addEvidence(task.id, file)),
        openSignal
      }
    ),
    noteOpen ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-editor", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "textarea",
        {
          autoFocus: true,
          className: "note-input",
          maxLength: 200,
          onChange: (event) => setNote(event.target.value),
          placeholder: "写一句说明",
          rows: 2,
          value: note
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "note-actions", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "btn btn--ghost",
            onClick: () => {
              setNoteOpen(false);
              setNote("");
            },
            type: "button",
            children: "取消"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "btn btn--primary",
            disabled: busy || note.trim().length === 0,
            onClick: () => void runAction(async () => {
              const message = await actions.addTextEvidence(task.id, note);
              if (message === null) {
                setNote("");
                setNoteOpen(false);
              }
              return message;
            }),
            type: "button",
            children: "确认"
          }
        )
      ] })
    ] }) : null,
    actionable ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "review-actions", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "btn btn--ghost",
          disabled: busy,
          onClick: () => {
            setNoteOpen(true);
          },
          type: "button",
          children: "写说明"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "btn btn--ghost",
          disabled: busy,
          onClick: () => runAction(() => actions.cancelSubmit(task.id)),
          type: "button",
          children: "取消"
        }
      ),
      evidence.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "btn btn--ghost",
          disabled: busy,
          onClick: () => runAction(() => actions.reReview(task.id)),
          type: "button",
          children: "重新审核"
        }
      ) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "btn btn--primary",
          disabled: busy,
          onClick: () => setOpenSignal((n) => n + 1),
          type: "button",
          children: "补证据"
        }
      ),
      needEvidenceCount >= 3 ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "btn btn--faint",
          disabled: busy,
          onClick: () => runAction(() => actions.markDoneWithoutPoints(task.id)),
          type: "button",
          children: "直接标记完成（不计分）"
        }
      ) : null
    ] }) : null,
    error !== null ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "review-error", children: error }) : null,
    opened ? reactDomExports.createPortal(
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "lightbox", onClick: () => setOpened(null), role: "presentation", children: /* @__PURE__ */ jsxRuntimeExports.jsx("img", { alt: "", className: "lightbox-img", src: opened }) }),
      document.body
    ) : null
  ] });
}
function clockOf(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function ReminderRow({
  title,
  fireAt,
  offsetMin,
  taskId,
  reminderId,
  messageId,
  acked,
  actions
}) {
  const clock = clockOf(fireAt);
  const suffix = offsetMin === null ? clock ? ` · ${clock}` : "" : ` · ${offsetLabel(offsetMin)}`;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: acked ? "reminder-row is-settled" : "reminder-row", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "reminder-dot" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "button",
      {
        className: "reminder-text",
        disabled: taskId === null,
        onClick: () => {
          if (taskId) actions.openTask(taskId);
        },
        type: "button",
        children: [
          title,
          suffix
        ]
      }
    ),
    acked ? null : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "reminder-snooze",
          onClick: () => {
            actions.snoozeReminder(reminderId);
            actions.settleReminder(messageId);
          },
          type: "button",
          children: "稍后提醒"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "reminder-ack",
          onClick: () => actions.settleReminder(messageId),
          type: "button",
          children: "知道了"
        }
      )
    ] })
  ] });
}
function ErrorBubble({ text, retryable, onRetry }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "error-card", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "error-text", children: text }),
    retryable ? /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "btn btn--ghost", onClick: onRetry, type: "button", children: "重试" }) : null
  ] });
}
const MessageItem = reactExports.memo(function MessageItem2({
  message,
  draftViews,
  reviewViews,
  actions,
  runningUserId
}) {
  const meta = message.meta;
  switch (meta.kind) {
    case "task_draft":
      return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "msg-drafts", children: meta.drafts.map((item) => {
        const view = draftViews[item.localId];
        return view ? /* @__PURE__ */ jsxRuntimeExports.jsx(TaskDraftCard, { actions, view }, item.localId) : null;
      }) });
    case "task_review": {
      const view = reviewViews[message.id];
      return view ? /* @__PURE__ */ jsxRuntimeExports.jsx(TaskReviewCard, { actions, verdict: meta.verdict, view }) : null;
    }
    case "reminder":
      return /* @__PURE__ */ jsxRuntimeExports.jsx(
        ReminderRow,
        {
          actions,
          acked: message.settledAt !== null,
          fireAt: meta.fireAt,
          messageId: message.id,
          offsetMin: meta.offsetMin,
          reminderId: meta.reminderId,
          taskId: meta.taskId,
          title: meta.title
        }
      );
    case "error":
      return /* @__PURE__ */ jsxRuntimeExports.jsx(
        ErrorBubble,
        {
          onRetry: () => actions.retry(message.id),
          retryable: meta.retryable,
          text: meta.message
        }
      );
    case "none":
    default: {
      const editable = message.role === "user" && message.id !== runningUserId;
      return /* @__PURE__ */ jsxRuntimeExports.jsx(
        TextBubble,
        {
          message,
          onEdit: editable ? () => actions.editMessage(message.id) : void 0,
          onRecall: editable ? () => actions.recallMessage(message.id) : void 0
        }
      );
    }
  }
});
const EST = 88;
const OVERSCAN = 4;
const BOTTOM_THRESHOLD = 24;
const LOAD_MORE_THRESHOLD = 240;
const TAIL_ID = "__tail__";
function Row({ id, top, onMeasure, children }) {
  const ref = reactExports.useRef(null);
  reactExports.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onMeasure(id, el.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [id, onMeasure]);
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "msg-row", ref, style: { transform: `translateY(${top}px)` }, children });
}
function MessageList({
  messages,
  draftViews,
  reviewViews,
  actions,
  runningUserId,
  hasMore,
  loadingMore,
  onLoadMore,
  tail
}) {
  const scrollRef = reactExports.useRef(null);
  const heights = reactExports.useRef(/* @__PURE__ */ new Map());
  const atBottom = reactExports.useRef(true);
  const scrolledUp = reactExports.useRef(false);
  const anchor = reactExports.useRef(null);
  const touchY = reactExports.useRef(0);
  const [, bump] = reactExports.useReducer((n) => n + 1, 0);
  const [scrollTop, setScrollTop] = reactExports.useState(0);
  const [viewport, setViewport] = reactExports.useState(0);
  reactExports.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport(el.clientHeight);
    const observer = new ResizeObserver(() => setViewport(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const measure = reactExports.useCallback((id, height) => {
    const prev = heights.current.get(id);
    if (prev !== void 0 && Math.abs(prev - height) < 0.5) return;
    heights.current.set(id, height);
    bump();
  }, []);
  const offsets = new Array(messages.length);
  let bodyTotal = 0;
  for (let i = 0; i < messages.length; i++) {
    offsets[i] = bodyTotal;
    bodyTotal += heights.current.get(messages[i].id) ?? EST;
  }
  const tailTop = bodyTotal;
  const tailHeight = tail ? heights.current.get(TAIL_ID) ?? EST : 0;
  const total = bodyTotal + tailHeight;
  const indexAt = (y) => {
    if (messages.length === 0) return 0;
    let lo = 0;
    let hi = messages.length - 1;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const first = Math.max(0, indexAt(scrollTop) - OVERSCAN);
  const last = Math.min(messages.length - 1, indexAt(scrollTop + viewport) + OVERSCAN);
  reactExports.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pending = anchor.current;
    if (pending) {
      anchor.current = null;
      if (total > pending.total) {
        el.scrollTop = pending.top + (total - pending.total);
        return;
      }
    }
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [total, messages.length, viewport]);
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const distance = total - el.scrollTop - el.clientHeight;
    if (distance <= BOTTOM_THRESHOLD) {
      atBottom.current = true;
    } else if (distance > BOTTOM_THRESHOLD * 3) {
      atBottom.current = false;
    }
    if (scrolledUp.current && hasMore && !loadingMore && anchor.current === null && el.scrollTop < LOAD_MORE_THRESHOLD) {
      scrolledUp.current = false;
      anchor.current = { total, top: el.scrollTop };
      onLoadMore();
    }
  };
  const handleWheel = (event) => {
    if (event.deltaY < 0) {
      atBottom.current = false;
      scrolledUp.current = true;
    }
  };
  const handleTouchStart = (event) => {
    touchY.current = event.touches[0]?.clientY ?? 0;
  };
  const handleTouchMove = (event) => {
    const y = event.touches[0]?.clientY ?? 0;
    if (y > touchY.current + 2) {
      atBottom.current = false;
      scrolledUp.current = true;
    }
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "div",
    {
      className: "msg-scroll",
      onScroll: handleScroll,
      onTouchMove: handleTouchMove,
      onTouchStart: handleTouchStart,
      onWheel: handleWheel,
      ref: scrollRef,
      children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "msg-spacer", style: { height: total }, children: [
        messages.slice(first, last + 1).map((message, i) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          Row,
          {
            id: message.id,
            onMeasure: measure,
            top: offsets[first + i],
            children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              MessageItem,
              {
                actions,
                draftViews,
                message,
                reviewViews,
                runningUserId
              }
            )
          },
          message.id
        )),
        tail ? /* @__PURE__ */ jsxRuntimeExports.jsx(Row, { id: TAIL_ID, onMeasure: measure, top: tailTop, children: tail }, TAIL_ID) : null
      ] })
    }
  );
}
function layerOfKind(kind) {
  switch (kind) {
    case "task_draft":
    case "task_review":
    case "reminder":
      return "task";
    case "none":
    case "error":
      return "chat";
    default:
      return "chat";
  }
}
function isTaskSignal(message) {
  const kind = message.meta.kind;
  return kind === "task_draft" || kind === "task_review";
}
function layerOfMessage(message) {
  if (layerOfKind(message.meta.kind) === "task") return "task";
  if (message.mode === "task") return "task";
  return "chat";
}
function layersOfMessages(messages) {
  const layers = /* @__PURE__ */ new Map();
  for (const message of messages) {
    if (message.mode !== null) layers.set(message.id, layerOfMessage(message));
  }
  const assignLegacy = (message, turnMarked) => {
    if (message.mode !== null) return;
    const base = layerOfKind(message.meta.kind);
    layers.set(message.id, base === "chat" && turnMarked ? "task" : base);
  };
  const flush = (turn2) => {
    const marked = turn2.some(isTaskSignal);
    for (const message of turn2) assignLegacy(message, marked);
  };
  let turn = [];
  let inTurn = false;
  for (const message of messages) {
    if (message.role === "user") {
      if (inTurn) flush(turn);
      turn = [];
      inTurn = true;
    }
    if (!inTurn) {
      assignLegacy(message, false);
      continue;
    }
    turn.push(message);
  }
  if (inTurn) flush(turn);
  return layers;
}
function messagesOfLayer(visible, layers, layer) {
  return visible.filter(
    (message) => (layers.get(message.id) ?? layerOfKind(message.meta.kind)) === layer
  );
}
const BOOTSTRAP_MESSAGE_LIMIT = 30;
const TYPE_BASE_CPS = 40;
const TYPE_FAST_CPS = 80;
const TYPE_FAST_THRESHOLD = 400;
function createTyper(options) {
  const chars = Array.from(options.text);
  const total = chars.length;
  const rate = total > TYPE_FAST_THRESHOLD ? TYPE_FAST_CPS : TYPE_BASE_CPS;
  const clock = options.now ?? Date.now;
  const startedAt = clock();
  let shown = 0;
  let finished = false;
  const push = (count) => {
    if (count <= shown) return;
    shown = count;
    options.onUpdate(count >= total ? options.text : chars.slice(0, count).join(""));
  };
  return {
    tick(nowMs) {
      if (finished || total === 0) {
        if (!finished && total === 0) finished = true;
        return;
      }
      const elapsedMs = Math.max(0, nowMs - startedAt);
      const target = Math.min(total, Math.floor(elapsedMs / 1e3 * rate));
      push(target);
      if (shown >= total) finished = true;
    },
    finish() {
      if (finished && shown >= total) return;
      finished = true;
      shown = total;
      options.onUpdate(options.text);
    },
    stop() {
      finished = true;
    },
    done() {
      return finished;
    },
    total() {
      return total;
    }
  };
}
const OVERDUE_GRACE_MS = 24 * 60 * 60 * 1e3;
function api() {
  return globalThis.api;
}
const inFlight = /* @__PURE__ */ new Set();
function isOverdue(dueAt, now) {
  const due = dueInstant(dueAt);
  return due !== null && due.getTime() + OVERDUE_GRACE_MS < now.getTime();
}
function decideReview(verdict, task, now) {
  if (verdict.verdict === "pass") return "complete";
  if (verdict.verdict === "need_evidence") return "stay";
  if (task.type === "event") {
    return verdict.verdict === "fail" ? "missed" : "revive";
  }
  return isOverdue(task.dueAt, now) ? "missed" : "revive";
}
function countNeedEvidence(messages, taskId) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const meta = messages[i].meta;
    if (meta.kind !== "task_review" || meta.taskId !== taskId) continue;
    if (meta.verdict.verdict !== "need_evidence") break;
    count += 1;
  }
  return count;
}
function mergePendingSubmit(pending, submitting) {
  const map = /* @__PURE__ */ new Map();
  for (const task of pending) map.set(task.id, task);
  for (const [id, task] of Object.entries(submitting)) if (!map.has(id)) map.set(id, task);
  return [...map.values()].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
}
async function submitForReview(taskId) {
  try {
    const loaded = await api().task.get({ id: taskId });
    if (!loaded.ok) return loaded.error.message;
    if (loaded.data.evidence.length === 0) return null;
    const moved = await api().task.transition({ id: taskId, to: "reviewing" });
    if (!moved.ok) return moved.error.message;
    const result = await runReview(taskId);
    return result.kind === "error" ? result.message : null;
  } catch (e) {
    return messageOf(e);
  }
}
function messageOf(error) {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}
async function reviveToDoing(taskId) {
  try {
    const current = await api().task.get({ id: taskId });
    if (!current.ok || current.data.status !== "reviewing") return;
    const moved = await api().task.transition({ id: taskId, to: "doing" });
    if (!moved.ok) console.warn("[review] 回退到进行中失败", moved.error);
  } catch (e) {
    console.warn("[review] 回退到进行中调用失败", e);
  }
}
async function transitionQuietly(taskId, to) {
  try {
    const moved = await api().task.transition({ id: taskId, to });
    if (!moved.ok) console.warn(`[review] transition(${to}) 失败`, moved.error);
  } catch (e) {
    console.warn(`[review] transition(${to}) 调用失败`, e);
  }
}
async function runReview(taskId, now = /* @__PURE__ */ new Date()) {
  if (inFlight.has(taskId)) return { kind: "skipped" };
  inFlight.add(taskId);
  try {
    const loaded = await api().task.get({ id: taskId });
    if (!loaded.ok) return { kind: "error", message: loaded.error.message };
    const reviewed = await api().ai.review({ taskId });
    if (!reviewed.ok) {
      await reviveToDoing(taskId);
      return { kind: "error", message: reviewed.error.message };
    }
    const verdict = reviewed.data;
    const after = await api().task.get({ id: taskId });
    if (!after.ok) {
      console.warn("[review] AI 返回后重读任务失败，本次不流转", taskId, after.error);
      return { kind: "skipped" };
    }
    if (after.data.status !== "reviewing") {
      console.warn("[review] AI 返回时任务已不在待确认，本次不流转", taskId, after.data.status);
      return { kind: "skipped" };
    }
    const decision = decideReview(verdict, loaded.data, now);
    if (decision === "complete") {
      const input = loaded.data.type === "event" ? { id: taskId, quality: "met", result: verdict.result ?? "met" } : { id: taskId, quality: verdict.quality ?? "met" };
      const done = await api().task.complete(input);
      if (!done.ok) {
        await reviveToDoing(taskId);
        return { kind: "error", message: done.error.message };
      }
      return { kind: "done", verdict };
    }
    if (decision === "revive") {
      await transitionQuietly(taskId, "doing");
      return { kind: "done", verdict };
    }
    if (decision === "missed") {
      await transitionQuietly(taskId, "missed");
      return { kind: "done", verdict };
    }
    return { kind: "done", verdict };
  } catch (e) {
    await reviveToDoing(taskId);
    return { kind: "error", message: messageOf(e) };
  } finally {
    inFlight.delete(taskId);
  }
}
const THREAD = "thread-demo";
const DAY = "2026-10-28";
function mockImage(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect x="0.5" y="0.5" width="95" height="95" fill="none" stroke="#a0a0a8"/><text x="8" y="52" font-size="11" fill="#6b6b73" font-family="sans-serif">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
const FIXTURE_ATTACHMENTS = [
  {
    id: "att-a",
    kind: "image",
    name: "IMG_2041.png",
    url: mockImage("IMG_2041"),
    mime: "image/svg+xml",
    bytes: 20480,
    width: 96,
    height: 96
  },
  {
    id: "att-b",
    kind: "image",
    name: "IMG_2042.png",
    url: mockImage("IMG_2042"),
    mime: "image/svg+xml",
    bytes: 18432,
    width: 96,
    height: 96
  },
  {
    id: "att-c",
    kind: "file",
    name: "回访记录.pdf",
    url: "app://attach/att-c",
    mime: "application/pdf",
    bytes: 348160,
    width: null,
    height: null
  }
];
new Map(FIXTURE_ATTACHMENTS.map((a) => [a.id, a]));
function makeTask(seed) {
  return {
    status: "todo",
    detailMd: "",
    parentId: null,
    sortKey: 0,
    priority: 0,
    difficulty: "medium",
    estimateMin: 60,
    plannedDay: null,
    dueAt: null,
    dailyTime: null,
    repeatRule: null,
    activeFrom: null,
    activeTo: null,
    reminderOffsets: [],
    reminderChannels: ["inapp"],
    tags: [],
    pointsPlanned: 20,
    pointsAwarded: null,
    quality: null,
    requiresEvidence: false,
    evidence: [],
    streakCurrent: 0,
    streakBest: 0,
    source: "chat",
    aiConfidence: 0.8,
    createdAt: `${DAY}T01:00:00.000Z`,
    updatedAt: `${DAY}T01:00:00.000Z`,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    ...seed
  };
}
const evidencePhoto = {
  kind: "attachment",
  attachmentId: "att-c",
  addedAt: `${DAY}T02:02:00.000Z`
};
const evidenceShot = {
  kind: "attachment",
  attachmentId: "att-a",
  addedAt: `${DAY}T02:05:00.000Z`
};
const evidenceText = { kind: "text", text: "实验数据在第 3 页，误差分析在附录", addedAt: `${DAY}T02:06:00.000Z` };
[
  makeTask({
    id: "task-physics",
    type: "deadline",
    title: "交物理作业",
    detailMd: "把本周实验报告导出 PDF 后提交。",
    difficulty: "medium",
    estimateMin: 60,
    dueAt: `${DAY}T10:00:00.000Z`,
    // 提前 96h 完成 → 提前 4 天，效率系数 1.2（04 §3.3 的示例场景）
    completedAt: `2026-10-24T10:00:00.000Z`,
    pointsPlanned: computePlannedPoints("deadline", "medium"),
    requiresEvidence: true,
    evidence: [evidencePhoto, evidenceShot],
    reminderOffsets: [-1440, -60],
    status: "doing"
  }),
  makeTask({
    id: "task-words",
    type: "daily",
    title: "背单词 30 个",
    difficulty: "trivial",
    estimateMin: 30,
    dailyTime: "21:00",
    repeatRule: "DAILY",
    // 每日任务入库的就是单日基数（默认 1），与卡片显示一致
    pointsPlanned: 1,
    streakCurrent: 7
  }),
  makeTask({
    id: "task-cet",
    type: "event",
    title: "英语六级考试",
    difficulty: "hard",
    estimateMin: 120,
    dueAt: `2026-11-14T01:00:00.000Z`,
    pointsPlanned: computePlannedPoints("event", "hard"),
    requiresEvidence: true
  }),
  makeTask({
    id: "task-report",
    type: "deadline",
    title: "客户回访记录",
    detailMd: "整理三家客户的回访结论。",
    difficulty: "easy",
    estimateMin: 30,
    dueAt: `${DAY}T12:00:00.000Z`,
    pointsPlanned: computePlannedPoints("deadline", "easy"),
    requiresEvidence: true,
    evidence: [evidenceText],
    reminderOffsets: [-1440]
  })
];
function draft(seed) {
  const difficulty = snapDifficulty(seed.type, seed.difficulty ?? "medium");
  const estimateMin = seed.estimateMin === void 0 ? 60 : seed.estimateMin;
  return {
    detailMd: "",
    dueHint: null,
    plannedDay: null,
    dailyTimeHint: null,
    activeToHint: null,
    reminderOffsets: [...TYPE_DEFAULT_OFFSETS[seed.type]],
    tags: [],
    steps: [],
    missingInfo: [],
    requiresEvidence: false,
    confidence: 0.8,
    ...seed,
    difficulty,
    estimateMin,
    // 只看难度/类型。占位值：useChatData 载入时会用 bootstrap.settings 的真配置
    // normalizeDraft 重算（02 §5.2b），这里的数值不进显示。
    pointsPlanned: draftPointsOf({ type: seed.type, difficulty }, DEFAULT_CONFIG)
  };
}
const FIXTURE_DRAFTS = [
  draft({
    localId: "draft-1",
    type: "deadline",
    title: "交物理作业",
    detailMd: "把本周实验报告导出 PDF 后提交，**含完整实验数据**。",
    difficulty: "medium",
    estimateMin: 60,
    dueHint: "2026-10-30T10:00:00.000Z",
    steps: [
      { localId: "s-1", title: "整理实验数据", estimateMin: 20, done: false },
      { localId: "s-2", title: "导出 PDF", estimateMin: 10, done: false },
      { localId: "s-3", title: "提交到课程平台", estimateMin: 5, done: false }
    ],
    requiresEvidence: true,
    confidence: 0.82
  }),
  draft({
    localId: "draft-2",
    type: "daily",
    title: "背单词 30 个",
    detailMd: "晚上刷牙后背，`30` 个一组。",
    difficulty: "trivial",
    estimateMin: 30,
    dailyTimeHint: "21:00",
    activeToHint: "2026-11-30",
    steps: [{ localId: "s-4", title: "复习昨日错词", estimateMin: 5, done: false }],
    confidence: 0.42
  }),
  draft({
    localId: "draft-3",
    type: "event",
    title: "英语六级考试",
    detailMd: "",
    difficulty: "hard",
    estimateMin: 120,
    dueHint: "2026-11-14T01:00:00.000Z",
    requiresEvidence: true,
    confidence: 0.66
  }),
  // 跨年：UTC 1 月 5 日 01:00 = 本地 1 月 5 日 09:00，用来确认卡片不会显示成今年
  draft({
    localId: "draft-4",
    type: "deadline",
    title: "春季选课申请",
    detailMd: "系统 1 月 6 日关闭，先把志愿填了。",
    difficulty: "easy",
    estimateMin: 30,
    dueHint: "2027-01-05T01:00:00.000Z",
    confidence: 0.74
  })
];
function msg(seed) {
  return {
    threadId: THREAD,
    contentMd: "",
    meta: { kind: "none" },
    linkedTaskId: null,
    status: "sent",
    // v0.73：演示数据当作老行（无模式标签），走轮推断兜底
    mode: null,
    attachments: [],
    // 009 迁移（v0.92）：演示数据都是没处理过的提醒
    settledAt: null,
    createdAt: `${DAY}T01:00:00.000Z`,
    ...seed
  };
}
const reviewPass = {
  verdict: "pass",
  quality: "exceeded",
  // v0.9：仅 event 有值，限时/每日传 null
  result: null,
  reason: "导出的 PDF 含完整实验数据，第 3 页有误差分析。",
  followup: null,
  gaps: []
};
const reviewNeed = {
  verdict: "need_evidence",
  quality: null,
  result: null,
  reason: "看不到回访记录本身。",
  followup: "补一份回访纪要，标注客户与日期。",
  gaps: []
};
const reviewPartial = {
  verdict: "partial",
  quality: "partial",
  result: null,
  reason: "只交了前两家客户的记录。",
  followup: null,
  gaps: ["第三家客户（张先生）的回访记录", "每家客户的回访日期"]
};
const reviewFail = {
  verdict: "fail",
  quality: null,
  // 没有完成动作就没有分值可算：fail 不带结果档，卡片也不渲染下拉
  result: null,
  reason: "截图里是一张空白页。",
  followup: null,
  gaps: []
};
const reviewCetPass = {
  verdict: "pass",
  quality: "met",
  result: "met",
  reason: "成绩单显示 585 分。",
  followup: null,
  gaps: []
};
const FIXTURE_MESSAGES = [
  msg({
    id: "m-1",
    role: "user",
    kind: "text",
    contentMd: "这周的物理作业和报销，帮我排一下。",
    attachments: [FIXTURE_ATTACHMENTS[0], FIXTURE_ATTACHMENTS[1]],
    createdAt: `${DAY}T01:12:00.000Z`
  }),
  msg({
    id: "m-2",
    role: "assistant",
    kind: "text",
    contentMd: "拆成两件事，按截止时间排。\n\n- **交物理作业**：10-30 18:00 前，`60` 分钟\n- 报销单：本周内，15 分钟\n\n1. 先做物理，数据齐了再导出\n2. 报销放在晚上",
    createdAt: `${DAY}T01:12:06.000Z`
  }),
  msg({
    id: "m-3",
    role: "assistant",
    kind: "task_draft",
    meta: { kind: "task_draft", drafts: FIXTURE_DRAFTS },
    createdAt: `${DAY}T01:12:08.000Z`
  }),
  msg({
    id: "m-4",
    role: "assistant",
    kind: "task_review",
    contentMd: "交物理作业",
    meta: { kind: "task_review", taskId: "task-physics", verdict: reviewPass },
    linkedTaskId: "task-physics",
    createdAt: `${DAY}T02:07:00.000Z`
  }),
  msg({
    id: "m-5",
    role: "assistant",
    kind: "task_review",
    contentMd: "客户回访记录",
    meta: { kind: "task_review", taskId: "task-report", verdict: reviewNeed },
    linkedTaskId: "task-report",
    createdAt: `${DAY}T02:20:00.000Z`
  }),
  msg({
    id: "m-6",
    role: "assistant",
    kind: "task_review",
    contentMd: "客户回访记录",
    meta: { kind: "task_review", taskId: "task-report", verdict: reviewPartial },
    linkedTaskId: "task-report",
    createdAt: `${DAY}T02:32:00.000Z`
  }),
  msg({
    id: "m-7",
    role: "assistant",
    kind: "task_review",
    contentMd: "英语六级考试",
    meta: { kind: "task_review", taskId: "task-cet", verdict: reviewFail },
    linkedTaskId: "task-cet",
    createdAt: `${DAY}T02:40:00.000Z`
  }),
  msg({
    id: "m-10",
    role: "assistant",
    kind: "task_review",
    contentMd: "英语六级考试",
    meta: { kind: "task_review", taskId: "task-cet", verdict: reviewCetPass },
    linkedTaskId: "task-cet",
    createdAt: `${DAY}T03:05:00.000Z`
  }),
  msg({
    id: "m-8",
    role: "system",
    kind: "reminder",
    meta: {
      kind: "reminder",
      reminderId: "rem-1",
      taskId: "task-physics",
      title: "交物理作业",
      fireAt: `${DAY}T09:00:00.000Z`,
      offsetMin: -60
    },
    createdAt: `${DAY}T09:00:00.000Z`
  }),
  msg({
    id: "m-9",
    role: "system",
    kind: "error",
    meta: {
      kind: "error",
      code: "AI_UPSTREAM_ERROR",
      message: "模型调用超时（30s）。",
      retryable: true
    },
    createdAt: `${DAY}T09:05:00.000Z`
  })
];
function makeBulkMessages(count) {
  const pool = [];
  for (let i = 0; i < count; i++) {
    const user = i % 2 === 0;
    pool.push(
      msg({
        id: `bulk-${i}`,
        role: user ? "user" : "assistant",
        kind: "text",
        contentMd: user ? `第 ${i + 1} 条：把这件事排进去。` : `第 ${i + 1} 条回复，包含 **粗体**、\`inline\` 与

- 列表项 A
- 列表项 B`,
        createdAt: `${DAY}T01:${String(i % 60).padStart(2, "0")}:00.000Z`
      })
    );
  }
  return pool;
}
function mergeOlderPage(existing, page, pageSize) {
  if (page.length === 0) return { messages: [...existing], hasMore: false };
  const pageIds = new Set(page.map((message) => message.id));
  return {
    messages: [...page, ...existing.filter((message) => !pageIds.has(message.id))],
    hasMore: page.length >= pageSize
  };
}
const PAGE = 20;
function bulkCount() {
  if (typeof window === "undefined") return 0;
  return 0;
}
function leadHoursOf(task) {
  if (task.type !== "deadline" || !task.dueAt || !task.completedAt) return null;
  const due = dueInstant(task.dueAt);
  const done = Date.parse(task.completedAt);
  if (due === null || Number.isNaN(done)) return null;
  return (due.getTime() - done) / 36e5;
}
function overdueDaysOf(leadHours) {
  if (leadHours === null || leadHours >= 0) return 0;
  return Math.floor(-leadHours / 24);
}
function scoreOf(task, verdict, result) {
  const leadHours = leadHoursOf(task);
  const overdueDays = overdueDaysOf(leadHours);
  const awarded = verdict.verdict === "pass" || verdict.verdict === "partial" ? computeAwardedPoints({
    type: task.type,
    planned: task.pointsPlanned,
    quality: verdict.quality ?? "met",
    overdueDays,
    leadHours,
    result
  }) : null;
  return {
    awarded,
    leadLabel: leadHours === null ? null : leadLabel(leadHours, overdueDays) || null
  };
}
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("文件读取失败"));
    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      const comma = raw.indexOf(",");
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw);
    };
    reader.readAsDataURL(file);
  });
}
function applyDraftPatch(current, patch, cfg) {
  const offsets = patch.type && patch.reminderOffsets === void 0 ? { reminderOffsets: [...TYPE_DEFAULT_OFFSETS[patch.type]] } : {};
  const difficulty = patch.type && !patch.difficulty ? { difficulty: snapDifficulty(patch.type, current.difficulty) } : {};
  const next = { ...current, ...offsets, ...difficulty, ...patch };
  if (next.difficulty !== current.difficulty || next.type !== current.type) {
    next.pointsPlanned = draftPointsOf(next, cfg);
  }
  return next;
}
function promotePatchOf(draft2) {
  return {
    type: draft2.type,
    title: draft2.title,
    detailMd: draft2.detailMd,
    difficulty: draft2.difficulty,
    estimateMin: draft2.estimateMin,
    // 计划日（91）：不带上去的话，草稿确认后就丢了——AI 认出来的"哪天做"白认
    plannedDay: draft2.plannedDay,
    dueAt: draft2.type === "daily" ? null : draft2.dueHint,
    dailyTime: draft2.type === "daily" ? draft2.dailyTimeHint : null,
    activeTo: draft2.type === "daily" ? draft2.activeToHint : null,
    reminderOffsets: [...draft2.reminderOffsets],
    tags: [...draft2.tags],
    requiresEvidence: draft2.requiresEvidence
  };
}
function promoteMarkerOf(draft2) {
  return draft2;
}
function useChatData() {
  const [cfg, setCfg] = reactExports.useState(null);
  const [messages, setMessages] = reactExports.useState(() => {
    const n = bulkCount();
    return n > 0 ? makeBulkMessages(n) : FIXTURE_MESSAGES;
  });
  const [drafts, setDrafts] = reactExports.useState({});
  const [confirmed, setConfirmed] = reactExports.useState({});
  const [taskById, setTaskById] = reactExports.useState({});
  const [attachmentById, setAttachmentById] = reactExports.useState({});
  const missing = reactExports.useRef(/* @__PURE__ */ new Set());
  const [pendingList, setPendingList] = reactExports.useState([]);
  const [submittingTasks, setSubmittingTasks] = reactExports.useState({});
  const [sending, setSending] = reactExports.useState(false);
  const [composeText, setComposeText] = reactExports.useState(null);
  const [hasMore, setHasMore] = reactExports.useState(() => bulkCount() === 0);
  const [loadingMore, setLoadingMore] = reactExports.useState(false);
  const seq = reactExports.useRef(0);
  const [mode, setMode] = reactExports.useState("task");
  const toggleMode = reactExports.useCallback(() => {
    setMode((prev) => prev === "task" ? "chat" : "task");
  }, []);
  const [displayText, setDisplayText] = reactExports.useState({});
  const typers = reactExports.useRef({});
  const rafId = reactExports.useRef(null);
  const liveTurnIds = reactExports.useRef(/* @__PURE__ */ new Set());
  const stopTyping = reactExports.useCallback(() => {
    for (const typer of Object.values(typers.current)) typer.stop();
    typers.current = {};
    if (rafId.current !== null) {
      window.cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    setDisplayText((prev) => Object.keys(prev).length === 0 ? prev : {});
  }, []);
  const pumpTyping = reactExports.useCallback(() => {
    if (rafId.current !== null) return;
    const step = () => {
      const now = performance.now();
      const finished = [];
      for (const [id, typer] of Object.entries(typers.current)) {
        typer.tick(now);
        if (typer.done()) finished.push(id);
      }
      if (finished.length > 0) {
        for (const id of finished) delete typers.current[id];
        setDisplayText((prev) => {
          if (finished.every((id) => prev[id] === void 0)) return prev;
          const next = { ...prev };
          for (const id of finished) delete next[id];
          return next;
        });
      }
      rafId.current = Object.keys(typers.current).length > 0 ? window.requestAnimationFrame(step) : null;
    };
    rafId.current = window.requestAnimationFrame(step);
  }, []);
  const startTyping = reactExports.useCallback(
    (id, text) => {
      if (typers.current[id] !== void 0) return;
      typers.current[id] = createTyper({
        text,
        now: () => performance.now(),
        onUpdate: (partial) => setDisplayText((prev) => ({ ...prev, [id]: partial }))
      });
      pumpTyping();
    },
    [pumpTyping]
  );
  const fetchTask = reactExports.useCallback(async (taskId, force = false) => {
    if (!force && missing.current.has(taskId)) return;
    try {
      const res = await window.api.task.get({ id: taskId });
      if (!res.ok) {
        missing.current.add(taskId);
        console.warn("[chat] 任务取不到，审核卡不渲染", taskId, res.error);
        return;
      }
      missing.current.delete(taskId);
      const task = res.data;
      setTaskById((prev) => ({ ...prev, [taskId]: task }));
    } catch (e) {
      missing.current.add(taskId);
      console.warn("[chat] task.get 调用失败", taskId, e);
    }
  }, []);
  const fetchAttachment = reactExports.useCallback(async (attachmentId) => {
    if (missing.current.has(attachmentId)) return;
    try {
      const res = await window.api.attachment.get({ id: attachmentId });
      if (!res.ok) {
        missing.current.add(attachmentId);
        console.warn("[chat] 附件取不到，该条证据不渲染", attachmentId, res.error);
        return;
      }
      missing.current.delete(attachmentId);
      setAttachmentById((prev) => ({ ...prev, [attachmentId]: res.data }));
    } catch (e) {
      missing.current.add(attachmentId);
      console.warn("[chat] attachment.get 调用失败", attachmentId, e);
    }
  }, []);
  const fetchReviewTasks = reactExports.useCallback(
    (list) => {
      const ids = /* @__PURE__ */ new Set();
      for (const message of list) {
        if (message.meta.kind === "task_review") ids.add(message.meta.taskId);
      }
      if (ids.size === 0) return;
      void Promise.all([...ids].map((id) => fetchTask(id)));
    },
    [fetchTask]
  );
  const reloadPending = reactExports.useCallback(async () => {
    try {
      const res = await window.api.task.list({ status: ["pending_review"] });
      if (!res.ok) {
        console.warn("[chat] 待提交列表取不到", res.error);
        return;
      }
      setPendingList(res.data);
    } catch (e) {
      console.warn("[chat] task.list(pending_review) 调用失败", e);
    }
  }, []);
  reactExports.useEffect(() => {
    void reloadPending();
  }, [reloadPending]);
  reactExports.useEffect(() => {
    const ids = /* @__PURE__ */ new Set();
    for (const task of [...Object.values(taskById), ...pendingList]) {
      for (const item of task.evidence) {
        if (item.kind === "attachment") ids.add(item.attachmentId);
      }
    }
    const pending = [...ids].filter(
      (id) => attachmentById[id] === void 0 && !missing.current.has(id)
    );
    if (pending.length === 0) return;
    void Promise.all(pending.map((id) => fetchAttachment(id)));
  }, [taskById, pendingList, attachmentById, fetchAttachment]);
  reactExports.useEffect(() => {
    return stopTyping;
  }, [stopTyping]);
  reactExports.useEffect(() => {
    let alive = true;
    void window.api.app.getBootstrap().then((res) => {
      if (!alive) return;
      if (!res.ok) {
        console.error("[chat] app.getBootstrap 失败", res.error);
        return;
      }
      const nextCfg = pointsConfigOf(res.data.settings);
      setCfg(nextCfg);
      setMessages(res.data.messages);
      setHasMore(res.data.messages.length >= BOOTSTRAP_MESSAGE_LIMIT);
      fetchReviewTasks(res.data.messages);
      const nextDrafts = {};
      const promoted = {};
      for (const message of res.data.messages) {
        if (message.meta.kind !== "task_draft") continue;
        for (const raw of message.meta.drafts) {
          const draft2 = normalizeDraft(raw, nextCfg);
          nextDrafts[draft2.localId] = draft2;
          const marker = promoteMarkerOf(draft2);
          if (marker.promoted === true && typeof marker.promotedTaskId === "string") {
            promoted[draft2.localId] = marker.promotedTaskId;
          }
        }
      }
      setDrafts(nextDrafts);
      setConfirmed((prev) => ({ ...prev, ...promoted }));
    }).catch((e) => {
      console.error("[chat] app.getBootstrap 调用失败", e);
    });
    return () => {
      alive = false;
    };
  }, [fetchReviewTasks]);
  reactExports.useEffect(() => {
    if (typeof window.api === "undefined") return;
    const off = window.api.onEvent((e) => {
      if (e.type === "task.created" || e.type === "task.updated") {
        setTaskById((prev) => prev[e.task.id] === void 0 ? prev : { ...prev, [e.task.id]: e.task });
        setPendingList((prev) => {
          const isPending = e.task.status === "pending_review";
          const exists = prev.some((t) => t.id === e.task.id);
          if (!isPending) return exists ? prev.filter((t) => t.id !== e.task.id) : prev;
          return exists ? prev.map((t) => t.id === e.task.id ? e.task : t) : [...prev, e.task];
        });
        return;
      }
      if (e.type === "task.removed") {
        setPendingList((prev) => prev.filter((t) => t.id !== e.taskId));
        return;
      }
      if (e.type === "ai.status") {
        if (e.phase === "thinking" && e.messageId !== void 0) {
          liveTurnIds.current.add(e.messageId);
        }
        setSending(e.phase !== "idle");
        return;
      }
      if (e.type === "message.patch") {
        const messageId = e.messageId;
        const patch = e.patch;
        const nextContent = patch.contentMd;
        let typing = null;
        setMessages(
          (prev) => prev.map((message2) => {
            if (message2.id !== messageId) return message2;
            const wasEmpty = message2.contentMd.trim().length === 0;
            if (message2.role === "assistant" && wasEmpty && typeof nextContent === "string" && nextContent.trim().length > 0 && liveTurnIds.current.has(messageId)) {
              typing = nextContent;
            }
            return { ...message2, ...patch };
          })
        );
        if (typing !== null) {
          liveTurnIds.current.delete(messageId);
          startTyping(messageId, typing);
        }
        return;
      }
      if (e.type !== "message.appended") return;
      const message = e.message;
      setMessages((prev) => prev.some((m) => m.id === message.id) ? prev : [...prev, message]);
      if (message.meta.kind === "task_review") {
        void fetchTask(message.meta.taskId);
      }
      if (message.meta.kind === "task_draft" && cfg !== null) {
        const raw = message.meta.drafts;
        setDrafts((prev) => {
          const next = { ...prev };
          for (const draft2 of raw) {
            const normalized = normalizeDraft(draft2, cfg);
            next[normalized.localId] = normalized;
          }
          return next;
        });
      }
    });
    return off;
  }, [cfg, fetchTask, startTyping]);
  const draftViews = reactExports.useMemo(() => {
    const views = {};
    for (const [localId, draft2] of Object.entries(drafts)) {
      views[localId] = {
        draft: draft2,
        dueLocal: dueHintToLocal(draft2.dueHint),
        confirmedTaskId: confirmed[localId] ?? null
      };
    }
    return views;
  }, [drafts, confirmed]);
  const reviewViews = reactExports.useMemo(() => {
    const views = {};
    const latestByTask = /* @__PURE__ */ new Map();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const meta = messages[i].meta;
      if (meta.kind !== "task_review") continue;
      if (!latestByTask.has(meta.taskId)) latestByTask.set(meta.taskId, messages[i].id);
    }
    for (const message of messages) {
      if (message.meta.kind !== "task_review") continue;
      const task = taskById[message.meta.taskId];
      if (!task) continue;
      const isEvent = task.type === "event";
      const result = isEvent ? message.meta.verdict.result ?? "met" : null;
      const score = scoreOf(task, message.meta.verdict, result);
      views[message.id] = {
        task,
        planned: task.pointsPlanned,
        awarded: score.awarded,
        evidence: toEvidenceViews(task.evidence, attachmentById),
        needEvidenceCount: countNeedEvidence(messages, task.id),
        result,
        leadLabel: score.leadLabel,
        isLatest: latestByTask.get(message.meta.taskId) === message.id
      };
    }
    return views;
  }, [messages, taskById, attachmentById]);
  const draftMessageIds = reactExports.useMemo(() => {
    const map = {};
    for (const message of messages) {
      if (message.meta.kind !== "task_draft") continue;
      for (const draft2 of message.meta.drafts) map[draft2.localId] = message.id;
    }
    return map;
  }, [messages]);
  const patchDraft = reactExports.useCallback(
    (localId, patch) => {
      if (!cfg) return;
      setDrafts((prev) => {
        const current = prev[localId];
        if (!current) return prev;
        return { ...prev, [localId]: applyDraftPatch(current, patch, cfg) };
      });
    },
    [cfg]
  );
  const confirmDraft = reactExports.useCallback(
    (localId) => {
      const draft2 = drafts[localId];
      if (!draft2) return;
      if (typeof window.api === "undefined") {
        seq.current += 1;
        setConfirmed((prev) => ({ ...prev, [localId]: `task-local-${seq.current}` }));
        return;
      }
      const messageId = draftMessageIds[localId];
      if (!messageId) return;
      void window.api.task.promoteDraft({ messageId, localId, patch: promotePatchOf(draft2) }).then((res) => {
        if (res.ok) {
          setConfirmed((prev) => ({ ...prev, [localId]: res.data.id }));
        } else {
          console.error("[chat] 确认草稿失败", res.error);
        }
      }).catch((e) => {
        console.error("[chat] 确认草稿调用失败", e);
      });
    },
    [draftMessageIds, drafts]
  );
  const rejectDraft = reactExports.useCallback((localId) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[localId];
      return next;
    });
    setConfirmed((prev) => {
      const next = { ...prev };
      delete next[localId];
      return next;
    });
  }, []);
  const retry = reactExports.useCallback((messageId) => {
    void window.api.msg.retry({ messageId }).then((res) => {
      if (!res.ok) console.error("[chat] msg.retry 失败", res.error);
    }).catch((e) => console.error("[chat] msg.retry 调用失败", e));
  }, []);
  const openTask = reactExports.useCallback((_taskId) => {
    void window.api.app.showMain().catch((e) => console.error("[chat] app.showMain 调用失败", e));
  }, []);
  const snoozeReminder = reactExports.useCallback((reminderId) => {
    void window.api.reminder.snooze({ id: reminderId, minutes: 15 }).then((res) => {
      if (!res.ok) console.error("[chat] reminder.snooze 失败", res.error);
    }).catch((e) => console.error("[chat] reminder.snooze 调用失败", e));
  }, []);
  const settleReminder = reactExports.useCallback((messageId) => {
    void window.api.msg.settle({ messageId }).then((res) => {
      if (!res.ok) console.error("[chat] msg.settle 失败", res.error);
    }).catch((e) => console.error("[chat] msg.settle 调用失败", e));
  }, []);
  const addEvidence = reactExports.useCallback(async (taskId, file) => {
    try {
      const base64 = await readFileAsBase64(file);
      const added = await window.api.attachment.add({
        name: file.name,
        mime: file.type,
        base64
      });
      if (!added.ok) return added.error.message;
      const attached = await window.api.task.addEvidence({
        id: taskId,
        evidence: {
          kind: "attachment",
          attachmentId: added.data.id,
          addedAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      });
      if (!attached.ok) return attached.error.message;
      setAttachmentById((prev) => ({ ...prev, [added.data.id]: added.data }));
      setTaskById((prev) => ({ ...prev, [taskId]: attached.data }));
      setPendingList(
        (prev) => prev.some((t) => t.id === taskId) ? prev.map((t) => t.id === taskId ? attached.data : t) : prev
      );
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, []);
  const addTextEvidence = reactExports.useCallback(
    async (taskId, text) => {
      try {
        const body = text.trim();
        if (body.length === 0) return null;
        const capped = Array.from(body).slice(0, 200).join("");
        const added = await window.api.task.addEvidence({
          id: taskId,
          evidence: { kind: "text", text: capped, addedAt: (/* @__PURE__ */ new Date()).toISOString() }
        });
        if (!added.ok) return added.error.message;
        setTaskById((prev) => ({ ...prev, [taskId]: added.data }));
        setPendingList(
          (prev) => prev.some((t) => t.id === taskId) ? prev.map((t) => t.id === taskId ? added.data : t) : prev
        );
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    []
  );
  const removeEvidence = reactExports.useCallback(
    async (taskId, index) => {
      try {
        const res = await window.api.task.removeEvidence({ id: taskId, index });
        if (!res.ok) return res.error.message;
        setTaskById((prev) => ({ ...prev, [taskId]: res.data }));
        setPendingList(
          (prev) => prev.some((t) => t.id === taskId) ? prev.map((t) => t.id === taskId ? res.data : t) : prev
        );
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    []
  );
  const reReview = reactExports.useCallback(
    async (taskId) => {
      const result = await runReview(taskId);
      await fetchTask(taskId, true);
      return result.kind === "error" ? result.message : null;
    },
    [fetchTask]
  );
  const markDoneWithoutPoints = reactExports.useCallback(
    async (taskId) => {
      const current = await window.api.task.get({ id: taskId });
      if (!current.ok) return current.error.message;
      if (current.data.status !== "reviewing") {
        const task = current.data;
        setTaskById((prev) => ({ ...prev, [taskId]: task }));
        return null;
      }
      const done = await window.api.task.complete({ id: taskId, noPoints: true });
      if (!done.ok) return done.error.message;
      setTaskById((prev) => ({ ...prev, [taskId]: done.data.task }));
      return null;
    },
    []
  );
  const submitReview = reactExports.useCallback(
    async (taskId) => {
      const snapshot = pendingList.find((t) => t.id === taskId);
      if (snapshot) setSubmittingTasks((prev) => ({ ...prev, [taskId]: snapshot }));
      try {
        return await submitForReview(taskId);
      } finally {
        setSubmittingTasks((prev) => {
          if (prev[taskId] === void 0) return prev;
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
        void reloadPending();
      }
    },
    [pendingList, reloadPending]
  );
  const cancelSubmit = reactExports.useCallback(async (taskId) => {
    try {
      const moved = await window.api.task.transition({ id: taskId, to: "doing" });
      if (!moved.ok) return moved.error.message;
      setPendingList((prev) => prev.filter((t) => t.id !== taskId));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, []);
  const removeTurn = reactExports.useCallback(
    async (messageId, fillBack) => {
      const target = messages.find((m) => m.id === messageId);
      const res = await window.api.msg.remove({ messageId });
      if (!res.ok) {
        console.error("[chat] msg.remove 失败", res.error);
        return;
      }
      setMessages((prev) => prev.filter((m) => !res.data.removedIds.includes(m.id)));
      if (fillBack) setComposeText(target ? target.contentMd : "");
    },
    [messages]
  );
  const recallMessage = reactExports.useCallback(
    (messageId) => {
      void removeTurn(messageId, false);
    },
    [removeTurn]
  );
  const editMessage = reactExports.useCallback(
    (messageId) => {
      void removeTurn(messageId, true);
    },
    [removeTurn]
  );
  const actions = reactExports.useMemo(
    () => ({
      patchDraft,
      confirmDraft,
      rejectDraft,
      retry,
      editMessage,
      recallMessage,
      openTask,
      snoozeReminder,
      settleReminder,
      addEvidence,
      addTextEvidence,
      removeEvidence,
      reReview,
      markDoneWithoutPoints,
      cancelSubmit,
      submitReview
    }),
    [
      patchDraft,
      confirmDraft,
      rejectDraft,
      retry,
      editMessage,
      recallMessage,
      openTask,
      snoozeReminder,
      settleReminder,
      addEvidence,
      addTextEvidence,
      removeEvidence,
      reReview,
      markDoneWithoutPoints,
      cancelSubmit,
      submitReview
    ]
  );
  const send = reactExports.useCallback(
    async (text, files, nextMode = mode) => {
      const body = text.trim();
      if (body.length === 0 && files.length === 0) return false;
      setSending(true);
      try {
        const ids = [];
        for (const file of files.slice(0, 4)) {
          const base64 = await readFileAsBase64(file);
          const added = await window.api.attachment.add({
            name: file.name,
            mime: file.type,
            base64
          });
          if (!added.ok) {
            console.error("[chat] attachment.add 失败", added.error);
            setSending(false);
            return false;
          }
          ids.push(added.data.id);
        }
        const sent = await window.api.msg.send({
          text: body,
          mode: nextMode,
          ...ids.length > 0 ? { attachmentIds: ids } : {}
        });
        if (!sent.ok) {
          console.error("[chat] msg.send 失败", sent.error);
          setSending(false);
          return false;
        }
        return true;
      } catch (e) {
        console.error("[chat] 发送失败", e);
        setSending(false);
        return false;
      }
    },
    [mode]
  );
  const consumeCompose = reactExports.useCallback(() => setComposeText(null), []);
  const loadMore = reactExports.useCallback(() => {
    if (loadingMore) return;
    const oldest = messages[0];
    if (!oldest) {
      setHasMore(false);
      return;
    }
    setLoadingMore(true);
    void window.api.msg.list({ before: oldest.id, limit: PAGE }).then((res) => {
      if (!res.ok) {
        console.error("[chat] 翻页失败", res.error);
        setHasMore(false);
        return;
      }
      const next = mergeOlderPage(messages, res.data, PAGE);
      setMessages(next.messages);
      setHasMore(next.hasMore);
    }).catch((e) => {
      console.error("[chat] 翻页失败", e);
      setHasMore(false);
    }).finally(() => setLoadingMore(false));
  }, [messages, loadingMore]);
  const pendingSubmit = reactExports.useMemo(
    () => mergePendingSubmit(pendingList, submittingTasks),
    [pendingList, submittingTasks]
  );
  const submittingIds = reactExports.useMemo(() => new Set(Object.keys(submittingTasks)), [submittingTasks]);
  const submitTaskIds = reactExports.useMemo(
    () => new Set(pendingSubmit.map((task) => task.id)),
    [pendingSubmit]
  );
  const visibleMessages = reactExports.useMemo(() => {
    const base = visibleChatMessages(messages, submitTaskIds);
    if (Object.keys(displayText).length === 0) return base;
    return base.map(
      (message) => displayText[message.id] === void 0 ? message : { ...message, contentMd: displayText[message.id] }
    );
  }, [messages, submitTaskIds, displayText]);
  const needEvidenceHint = reactExports.useMemo(() => latestNeedEvidenceHint(messages), [messages]);
  const reviewGaps = reactExports.useMemo(() => latestReviewGaps(messages), [messages]);
  const runningUserId = reactExports.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      if (message.status !== "pending" && message.status !== "streaming") continue;
      for (let j = i - 1; j >= 0; j -= 1) {
        if (messages[j].role === "user") return messages[j].id;
      }
      return null;
    }
    return null;
  }, [messages]);
  return {
    messages,
    visibleMessages,
    needEvidenceHint,
    reviewGaps,
    draftViews,
    reviewViews,
    pendingSubmit,
    submittingIds,
    attachmentById,
    sending,
    composeText,
    consumeCompose,
    runningUserId,
    hasMore,
    loadingMore,
    actions,
    mode,
    toggleMode,
    send,
    loadMore
  };
}
function ChatPanel() {
  const data = useChatData();
  const layer = data.mode === "chat" ? "chat" : "task";
  const layers = reactExports.useMemo(() => layersOfMessages(data.messages), [data.messages]);
  const chatMessages = messagesOfLayer(data.visibleMessages, layers, "chat");
  const taskMessages = messagesOfLayer(data.visibleMessages, layers, "task");
  const chatEmpty = layer === "chat" && chatMessages.length === 0;
  const tail = data.pendingSubmit.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "submit-tail", children: data.pendingSubmit.map((task) => /* @__PURE__ */ jsxRuntimeExports.jsx(
    SubmitCard,
    {
      busy: data.submittingIds.has(task.id),
      evidence: toEvidenceViews(task.evidence, data.attachmentById),
      gaps: data.reviewGaps[task.id] ?? [],
      hint: data.needEvidenceHint[task.id] ?? null,
      onCancel: () => data.actions.cancelSubmit(task.id),
      onAddText: (text) => data.actions.addTextEvidence(task.id, text),
      onPick: (file) => data.actions.addEvidence(task.id, file),
      onRemove: (index) => data.actions.removeEvidence(task.id, index),
      onSubmit: () => data.actions.submitReview(task.id),
      task
    },
    task.id
  )) }) : null;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "chat-panel", children: [
    chatEmpty ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "chat-empty", children: "发我一段话或一张图，我把它变成任务。" }) : /* @__PURE__ */ jsxRuntimeExports.jsx(
      MessageList,
      {
        actions: data.actions,
        draftViews: data.draftViews,
        hasMore: data.hasMore,
        loadingMore: data.loadingMore,
        messages: layer === "chat" ? chatMessages : taskMessages,
        onLoadMore: data.loadMore,
        reviewViews: data.reviewViews,
        runningUserId: data.runningUserId,
        tail: layer === "task" ? tail : null
      },
      layer
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      ChatInput,
      {
        mode: data.mode,
        onPendingTextUsed: data.consumeCompose,
        onSend: (text, files) => data.send(text, files, data.mode),
        onToggleMode: data.toggleMode,
        pendingText: data.composeText,
        sending: data.sending
      }
    )
  ] });
}
const MAX_N = { D: 365, W: 52, M: 24, Y: 10 };
const WEEKDAY_CHAR = ["一", "二", "三", "四", "五", "六", "日"];
function fail() {
  throw new Error("重复规则格式不正确");
}
function isUnit(s) {
  return s === "D" || s === "W" || s === "M" || s === "Y";
}
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}
function parseList(text, min, max) {
  const out = [];
  for (const part of text.split(",")) {
    if (!/^\d+$/.test(part)) fail();
    const value = Number(part);
    if (value < min || value > max) fail();
    out.push(value);
  }
  return uniqueSorted(out);
}
function normalize(rule) {
  const s = (rule ?? "").trim().toUpperCase();
  if (s === "" || s === "DAILY") return "EVERY:1:D";
  if (s.startsWith("WEEKLY:")) return `EVERY:1:W:${s.slice("WEEKLY:".length)}`;
  return s;
}
function parseRepeatRule(rule) {
  const parts = normalize(rule).split(":");
  if (parts.length < 3 || parts.length > 4) fail();
  if (parts[0] !== "EVERY") fail();
  if (!/^\d+$/.test(parts[1])) fail();
  const unitText = parts[2];
  if (!isUnit(unitText)) fail();
  const unit = unitText;
  const n = Number(parts[1]);
  if (!Number.isInteger(n) || n < 1 || n > MAX_N[unit]) fail();
  const base = { n, unit, weekdays: [], monthDays: [], monthDay: null };
  const selector = parts.length === 4 ? parts[3] : void 0;
  if (unit === "D") {
    if (selector !== void 0) fail();
    return base;
  }
  if (unit === "W") {
    if (selector === void 0 || selector === "") fail();
    return { ...base, weekdays: parseList(selector, 1, 7) };
  }
  if (unit === "M") {
    if (selector === void 0 || selector === "") return base;
    return { ...base, monthDays: parseList(selector, 1, 31) };
  }
  if (selector === void 0 || selector === "") return base;
  const match = /^(\d{2})-(\d{2})$/.exec(selector);
  if (match === null) fail();
  const month = Number(match[1]);
  const date = Number(match[2]);
  if (month < 1 || month > 12 || date < 1 || date > lastDayOfMonth(2e3, month)) fail();
  return { ...base, monthDay: selector };
}
function serializeRepeatRule(r) {
  const head = `EVERY:${r.n}:${r.unit}`;
  if (r.unit === "D") return head;
  if (r.unit === "W") return `${head}:${uniqueSorted(r.weekdays).join(",")}`;
  if (r.unit === "M") {
    return r.monthDays.length === 0 ? `${head}:` : `${head}:${uniqueSorted(r.monthDays).join(",")}`;
  }
  return r.monthDay === null ? `${head}:` : `${head}:${r.monthDay}`;
}
function describeRepeatRule(rule) {
  const r = parseRepeatRule(rule);
  if (r.unit === "D") return r.n === 1 ? "每天" : `每 ${r.n} 天`;
  if (r.unit === "W") {
    const chars = r.weekdays.map((w) => WEEKDAY_CHAR[w - 1]).join("、");
    return r.n === 1 ? `每周${chars}` : `每 ${r.n} 周的周${chars}`;
  }
  if (r.unit === "M") {
    if (r.monthDays.length === 0) {
      return r.n === 1 ? "每月同日" : `每 ${r.n} 月的同日`;
    }
    const days = r.monthDays.join("、");
    return r.n === 1 ? `每月 ${days} 日` : `每 ${r.n} 月的 ${days} 日`;
  }
  if (r.monthDay === null) {
    return r.n === 1 ? "每年同日" : `每 ${r.n} 年的同日`;
  }
  const month = Number(r.monthDay.slice(0, 2));
  const date = Number(r.monthDay.slice(3));
  return r.n === 1 ? `每年 ${month} 月 ${date} 日` : `每 ${r.n} 年的 ${month} 月 ${date} 日`;
}
function visibleOn(plannedDay, today) {
  return plannedDay === null || plannedDay <= today;
}
function compareTasks(a, b) {
  const rank = (t) => t.status === "doing" ? 0 : 1;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.priority !== b.priority) return b.priority - a.priority;
  const at = dueInstant(a.dueAt);
  const bt = dueInstant(b.dueAt);
  if (at === null || bt === null) {
    if (at === null && bt === null) return a.sortKey - b.sortKey;
    return at === null ? 1 : -1;
  }
  if (at.getTime() !== bt.getTime()) return at.getTime() - bt.getTime();
  return a.sortKey - b.sortKey;
}
function isDoneToday(task, today) {
  return task.status === "done" && task.completedAt !== null && toLocalDay(new Date(task.completedAt)) === today;
}
function isMissedToday(task, today) {
  return task.status === "missed" && toLocalDay(new Date(task.updatedAt)) === today;
}
function groupTasks(tasks, occurrences, today = toLocalDay(/* @__PURE__ */ new Date())) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const daily = occurrences.filter((o) => o.day === today && (o.status === "pending" || o.status === "done")).map((o) => ({ occurrence: o, task: byId.get(o.taskId) ?? null })).sort((a, b) => {
    const rank = (r) => r.occurrence.status === "pending" ? 0 : 1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (a.task?.sortKey ?? 0) - (b.task?.sortKey ?? 0);
  });
  const topLevel = tasks.filter((t) => t.parentId === null);
  const byType = (type) => [
    ...topLevel.filter(
      (t) => t.type === type && t.status !== "done" && t.status !== "missed" && visibleOn(t.plannedDay, today)
    ).sort(compareTasks),
    ...topLevel.filter((t) => t.type === type && (isDoneToday(t, today) || isMissedToday(t, today))).sort(compareTasks)
  ];
  return {
    daily,
    deadline: byType("deadline"),
    event: byType("event")
  };
}
function remainingLabel(task, now) {
  return fmtRemaining(task.dueAt, task.type, now);
}
function dueEditKindOf(dueAt) {
  const precision = duePrecisionOf(dueAt);
  if (precision === "minute") return "minute";
  if (precision === "day") return "day";
  return null;
}
function dueDateValueOf(dueAt) {
  const precision = duePrecisionOf(dueAt);
  if (precision === "minute") return toDatetimeLocal(dueAt).slice(0, 10);
  if (precision === "day") return dueAt.slice(0, 10);
  return "";
}
function dueTimeValueOf(dueAt) {
  if (duePrecisionOf(dueAt) !== "minute") return "";
  return toDatetimeLocal(dueAt).slice(11, 16);
}
function duePatchOfParts(date, time) {
  if (date === "") return "";
  if (time === "") return date;
  return (/* @__PURE__ */ new Date(`${date}T${time}`)).toISOString();
}
function canEditDueOf(task) {
  if (task.type !== "event" && task.type !== "deadline") return false;
  if (task.status !== "todo" && task.status !== "doing") return false;
  return dueEditKindOf(task.dueAt) !== null;
}
function taskRightParts(task, now) {
  if (task.status === "done" || task.status === "missed") return { remaining: "", due: "" };
  return { remaining: remainingLabel(task, now), due: fmtDueLabel(task.dueAt) };
}
function isStepChecked(step) {
  return step.status !== "todo";
}
const DEFAULT_DIFFICULTY = "medium";
const PULSE_KIND = "pulse";
const PULSE_LABEL = "周期提醒";
function coerceDifficulty(type, current) {
  return ALLOWED_DIFFICULTIES[type].includes(current) ? current : DEFAULT_DIFFICULTY;
}
function NewTaskForm({ actions }) {
  const [open, setOpen] = reactExports.useState(false);
  const [type, setType] = reactExports.useState("deadline");
  const [title, setTitle] = reactExports.useState("");
  const [difficulty, setDifficulty] = reactExports.useState(DEFAULT_DIFFICULTY);
  const [estimate, setEstimate] = reactExports.useState("");
  const [when, setWhen] = reactExports.useState("");
  const [intervalText, setIntervalText] = reactExports.useState("30");
  const [unit, setUnit] = reactExports.useState("minute");
  const [start, setStart] = reactExports.useState("");
  const [end, setEnd] = reactExports.useState("");
  const reset = () => {
    setTitle("");
    setEstimate("");
    setWhen("");
    setDifficulty(DEFAULT_DIFFICULTY);
    setIntervalText("30");
    setUnit("minute");
    setStart("");
    setEnd("");
  };
  const close = () => {
    reset();
    setOpen(false);
  };
  const changeType = (next) => {
    setType(next);
    if (next !== PULSE_KIND) setDifficulty((prev) => coerceDifficulty(next, prev));
    setWhen("");
  };
  const intervalMinutes = () => {
    const n = Number(intervalText);
    if (!Number.isInteger(n)) return Number.NaN;
    return unit === "hour" ? n * 60 : n;
  };
  const windowPaired = start === "" === (end === "");
  const canSubmit = type === PULSE_KIND ? title.trim().length > 0 && Number.isInteger(intervalMinutes()) && intervalMinutes() >= 1 && intervalMinutes() <= 1440 && windowPaired : title.trim().length > 0;
  const submit = () => {
    if (!canSubmit) return;
    if (type === PULSE_KIND) {
      void actions.createPulse({
        title: title.trim(),
        intervalMinutes: intervalMinutes(),
        windowStart: start === "" ? null : start,
        windowEnd: end === "" ? null : end
      }).then((ok) => {
        if (ok) close();
      });
      return;
    }
    const patch = {
      difficulty,
      estimateMin: estimate === "" ? null : Number(estimate)
    };
    if (type === "daily") {
      patch.dailyTime = when === "" ? null : when;
    } else if (when !== "") {
      patch.dueAt = new Date(when).toISOString();
    }
    void actions.createManual({ type, title: title.trim(), patch }).then((ok) => {
      if (ok) close();
    });
  };
  if (!open) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "new-task", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      "button",
      {
        "aria-label": "新建任务",
        className: "new-task-toggle",
        onClick: () => setOpen(true),
        type: "button",
        children: "+"
      }
    ) });
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "new-task", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "new-task-types", children: [
      TYPE_ORDER.map((item) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          "aria-pressed": item === type,
          className: `new-task-type${item === type ? " new-task-type--on" : ""}`,
          onClick: () => changeType(item),
          type: "button",
          children: TYPE_LABEL[item]
        },
        item
      )),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          "aria-pressed": PULSE_KIND === type,
          className: `new-task-type${PULSE_KIND === type ? " new-task-type--on" : ""}`,
          onClick: () => changeType(PULSE_KIND),
          type: "button",
          children: PULSE_LABEL
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "input",
      {
        "aria-label": "标题",
        className: "new-task-title",
        onChange: (event) => setTitle(event.target.value),
        onKeyDown: (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        },
        value: title
      }
    ),
    type === PULSE_KIND ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "new-task-fields", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            "aria-label": "间隔",
            className: "new-task-num",
            min: 1,
            onChange: (event) => setIntervalText(event.target.value),
            step: 1,
            type: "number",
            value: intervalText
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "select",
          {
            "aria-label": "单位",
            className: "new-task-select",
            onChange: (event) => setUnit(event.target.value === "hour" ? "hour" : "minute"),
            value: unit,
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "minute", children: "分钟" }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "hour", children: "小时" })
            ]
          }
        )
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "new-task-fields", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            "aria-label": "开始",
            className: "new-task-time",
            onChange: (event) => setStart(event.target.value),
            type: "time",
            value: start
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            "aria-label": "结束",
            className: "new-task-time",
            onChange: (event) => setEnd(event.target.value),
            type: "time",
            value: end
          }
        )
      ] })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "new-task-fields", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "select",
        {
          "aria-label": "难度",
          className: "new-task-select",
          onChange: (event) => setDifficulty(event.target.value),
          value: difficulty,
          children: ALLOWED_DIFFICULTIES[type].map((item) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: item, children: DIFFICULTY_LABEL[item] }, item))
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          "aria-label": "时长",
          className: "new-task-num",
          min: 0,
          onChange: (event) => setEstimate(event.target.value),
          step: 5,
          type: "number",
          value: estimate
        }
      ),
      type === "daily" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          "aria-label": "每日时刻",
          className: "new-task-time",
          onChange: (event) => setWhen(event.target.value),
          type: "time",
          value: when
        }
      ) : /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          "aria-label": "时间",
          className: "new-task-time",
          onChange: (event) => setWhen(event.target.value),
          type: "datetime-local",
          value: when
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "new-task-actions", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "btn btn--ghost", onClick: close, type: "button", children: "丢弃" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "btn btn--primary", disabled: !canSubmit, onClick: submit, type: "button", children: "确认" })
    ] })
  ] });
}
const FOCUS_TASK_EVENT = "taskloop:focus-task";
function emitFocusTask(id) {
  window.dispatchEvent(new CustomEvent(FOCUS_TASK_EVENT, { detail: { id } }));
}
function onFocusTask(cb) {
  const listener = (event) => {
    const detail = event.detail;
    if (detail && typeof detail.id === "string" && detail.id !== "") cb(detail.id);
  };
  window.addEventListener(FOCUS_TASK_EVENT, listener);
  return () => window.removeEventListener(FOCUS_TASK_EVENT, listener);
}
const ACTIVE_STATUS = ["todo", "doing", "pending_review", "reviewing"];
const DONE_STATUS = ["done"];
const MISSED_STATUS = ["missed"];
function mergeTodayOccurrences(prev, incoming) {
  const today = toLocalDay(/* @__PURE__ */ new Date());
  const map = new Map(
    prev.filter((o) => o.day === today).map((o) => [o.id, o])
  );
  for (const o of incoming) {
    if (o.day !== today) continue;
    const prev2 = map.get(o.id);
    map.set(o.id, o.taskTitle === void 0 && prev2 ? { ...o, taskTitle: prev2.taskTitle } : o);
  }
  return [...map.values()];
}
const NOTICE_MS$1 = 2600;
function useTasksData() {
  const [tasks, setTasks] = reactExports.useState([]);
  const [pulses, setPulses] = reactExports.useState([]);
  const [doneTasks, setDoneTasks] = reactExports.useState([]);
  const [missedTasks, setMissedTasks] = reactExports.useState([]);
  const [reviewingIds, setReviewingIds] = reactExports.useState(() => /* @__PURE__ */ new Set());
  const [occurrences, setOccurrences] = reactExports.useState([]);
  const [expandedId, setExpandedId] = reactExports.useState(null);
  const [confirmId, setConfirmId] = reactExports.useState(null);
  const [focusId, setFocusId] = reactExports.useState(null);
  const [notice, setNotice] = reactExports.useState(null);
  const noticeTimer = reactExports.useRef(null);
  const reloadSeq = reactExports.useRef(0);
  const reloadTasks = reactExports.useCallback(() => {
    const seq = reloadSeq.current + 1;
    reloadSeq.current = seq;
    void window.api.task.list({ status: ACTIVE_STATUS, includeSubtasks: true }).then((res) => {
      if (!res.ok) {
        console.error("[tasks] task.list 失败", res.error);
        return;
      }
      if (seq === reloadSeq.current) setTasks(res.data);
    }).catch((e) => console.error("[tasks] task.list 调用失败", e));
  }, []);
  const reloadOccurrences = reactExports.useCallback(() => {
    void window.api.occurrence.today().then((res) => {
      if (!res.ok) {
        console.error("[tasks] occurrence.today 失败", res.error);
        return;
      }
      setOccurrences(res.data);
    }).catch((e) => console.error("[tasks] occurrence.today 调用失败", e));
  }, []);
  const reloadDoneTasks = reactExports.useCallback(() => {
    void window.api.task.list({ status: DONE_STATUS }).then((res) => {
      if (!res.ok) {
        console.error("[tasks] task.list(done) 失败", res.error);
        return;
      }
      const today = toLocalDay(/* @__PURE__ */ new Date());
      setDoneTasks(res.data.filter((t) => isDoneToday(t, today)));
    }).catch((e) => console.error("[tasks] task.list(done) 调用失败", e));
  }, []);
  const reloadMissedTasks = reactExports.useCallback(() => {
    void window.api.task.list({ status: MISSED_STATUS }).then((res) => {
      if (!res.ok) {
        console.error("[tasks] task.list(missed) 失败", res.error);
        return;
      }
      const today = toLocalDay(/* @__PURE__ */ new Date());
      setMissedTasks(res.data.filter((t) => isMissedToday(t, today)));
    }).catch((e) => console.error("[tasks] task.list(missed) 调用失败", e));
  }, []);
  const reloadPulses = reactExports.useCallback(() => {
    void window.api.pulse.list().then((res) => {
      if (!res.ok) {
        console.error("[tasks] pulse.list 调用失败", res.error);
        return;
      }
      setPulses(res.data);
    }).catch((e) => console.error("[tasks] pulse.list 调用失败", e));
  }, []);
  reactExports.useEffect(() => {
    reloadTasks();
    reloadOccurrences();
    reloadDoneTasks();
    reloadMissedTasks();
    reloadPulses();
    const off = window.api.onEvent((e) => {
      switch (e.type) {
        case "task.created":
          reloadTasks();
          reloadOccurrences();
          break;
        case "task.updated":
          reloadTasks();
          reloadDoneTasks();
          reloadMissedTasks();
          break;
        case "task.removed":
          reloadTasks();
          reloadDoneTasks();
          reloadMissedTasks();
          reloadOccurrences();
          break;
        case "occurrence.created":
          setOccurrences((prev) => mergeTodayOccurrences(prev, e.occurrences));
          break;
        case "occurrence.updated":
          setOccurrences((prev) => mergeTodayOccurrences(prev, [e.occurrence]));
          break;
      }
    });
    return off;
  }, [reloadTasks, reloadOccurrences, reloadDoneTasks, reloadMissedTasks, reloadPulses]);
  reactExports.useEffect(
    () => onFocusTask((id) => {
      setExpandedId(id);
      setConfirmId(null);
      setFocusId(id);
    }),
    []
  );
  reactExports.useEffect(() => {
    if (focusId === null) return;
    const target = document.querySelector(`[data-task-id="${focusId}"]`);
    if (target instanceof HTMLElement) target.scrollIntoView({ block: "nearest" });
    const timer = window.setTimeout(() => setFocusId(null), 1200);
    return () => window.clearTimeout(timer);
  }, [focusId]);
  reactExports.useEffect(() => {
    if (notice === null) return;
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, NOTICE_MS$1);
    return () => {
      if (noticeTimer.current !== null) {
        window.clearTimeout(noticeTimer.current);
        noticeTimer.current = null;
      }
    };
  }, [notice]);
  const subtasksByParent = reactExports.useMemo(() => {
    const map = /* @__PURE__ */ new Map();
    for (const t of tasks) {
      if (t.parentId === null) continue;
      const list = map.get(t.parentId) ?? [];
      list.push(t);
      map.set(t.parentId, list);
    }
    return map;
  }, [tasks]);
  const transition = reactExports.useCallback((id, to) => {
    void window.api.task.transition({ id, to }).then((res) => {
      if (!res.ok) console.error("[tasks] task.transition 失败", res.error);
    }).catch((e) => console.error("[tasks] task.transition 调用失败", e));
  }, []);
  const expand = reactExports.useCallback((taskId) => {
    setExpandedId((prev) => prev === taskId ? null : taskId);
    setConfirmId(null);
  }, []);
  const updateTask = reactExports.useCallback((taskId, patch) => {
    void window.api.task.update({ id: taskId, patch }).then((res) => {
      if (!res.ok) setNotice({ taskId, message: res.error.message });
    }).catch((e) => console.error("[tasks] task.update 调用失败", e));
  }, []);
  const removeTask = reactExports.useCallback((taskId) => {
    void window.api.task.remove({ id: taskId }).then((res) => {
      if (!res.ok) {
        setNotice({ taskId, message: res.error.message });
        return;
      }
      setExpandedId(null);
    }).catch((e) => console.error("[tasks] task.remove 调用失败", e));
  }, []);
  const submitAndComplete = reactExports.useCallback((task, noPoints) => {
    if (noPoints) {
      void window.api.task.transition({ id: task.id, to: "reviewing" }).then((res) => {
        if (!res.ok) {
          console.error("[tasks] 提交完成失败", res.error);
          setNotice({ taskId: task.id, message: res.error.message });
          return;
        }
        void window.api.task.complete({ id: task.id, noPoints: true }).then((done) => {
          if (!done.ok) {
            console.error("[tasks] task.complete(noPoints) 失败", done.error);
            setNotice({ taskId: task.id, message: done.error.message });
            void reviveToDoing(task.id);
          }
        }).catch((e) => {
          console.error("[tasks] task.complete 调用失败", e);
          void reviveToDoing(task.id);
        });
      }).catch((e) => console.error("[tasks] task.transition 调用失败", e));
      return;
    }
    setReviewingIds((prev) => {
      const next = new Set(prev);
      next.add(task.id);
      return next;
    });
    void window.api.task.transition({ id: task.id, to: "pending_review" }).then((res) => {
      if (!res.ok) {
        console.error("[tasks] 提交完成失败", res.error);
        setNotice({ taskId: task.id, message: res.error.message });
      }
    }).catch((e) => console.error("[tasks] task.transition 调用失败", e)).finally(() => {
      setReviewingIds((prev) => {
        if (!prev.has(task.id)) return prev;
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    });
  }, []);
  const completeTask = reactExports.useCallback(
    (task) => {
      const steps = subtasksByParent.get(task.id) ?? [];
      if (steps.some((s) => !isStepChecked(s))) {
        setConfirmId(task.id);
        return;
      }
      submitAndComplete(task, false);
    },
    [subtasksByParent, submitAndComplete]
  );
  const confirmComplete = reactExports.useCallback(
    (task) => {
      setConfirmId(null);
      submitAndComplete(task, false);
    },
    [submitAndComplete]
  );
  const confirmCompleteNoPoints = reactExports.useCallback(
    (task) => {
      setConfirmId(null);
      submitAndComplete(task, true);
    },
    [submitAndComplete]
  );
  const completeOccurrence = reactExports.useCallback((occurrenceId) => {
    void window.api.occurrence.complete({ id: occurrenceId }).then((res) => {
      if (!res.ok) console.error("[tasks] occurrence.complete 失败", res.error);
    }).catch((e) => console.error("[tasks] occurrence.complete 调用失败", e));
  }, []);
  const cancelComplete = reactExports.useCallback(() => {
    setConfirmId(null);
  }, []);
  const toggleStep = reactExports.useCallback(
    (step) => {
      transition(step.id, step.status === "todo" ? "doing" : "todo");
    },
    [transition]
  );
  const reorder = reactExports.useCallback((taskId, beforeId) => {
    void window.api.task.reorder({ id: taskId, beforeId }).then((res) => {
      if (!res.ok) console.error("[tasks] task.reorder 失败", res.error);
    }).catch((e) => console.error("[tasks] task.reorder 调用失败", e));
  }, []);
  const createManual = reactExports.useCallback(
    (input) => window.api.task.createManual(input).then((res) => {
      if (!res.ok) {
        console.error("[tasks] task.createManual 失败", res.error);
        return false;
      }
      return true;
    }).catch((e) => {
      console.error("[tasks] task.createManual 调用失败", e);
      return false;
    }),
    []
  );
  const createPulse = reactExports.useCallback(
    (input) => window.api.pulse.create(input).then((res) => {
      if (!res.ok) {
        console.error("[tasks] pulse 操作失败", res.error);
        return false;
      }
      setPulses((prev) => [...prev, res.data]);
      return true;
    }).catch((e) => {
      console.error("[tasks] pulse 操作失败", e);
      return false;
    }),
    []
  );
  const setPulseEnabled = reactExports.useCallback((input) => {
    void window.api.pulse.setEnabled(input).then((res) => {
      if (!res.ok) {
        console.error("[tasks] pulse 操作失败", res.error);
        return;
      }
      setPulses((prev) => prev.map((p) => p.id === res.data.id ? res.data : p));
    }).catch((e) => console.error("[tasks] pulse 操作失败", e));
  }, []);
  const removePulse = reactExports.useCallback((id) => {
    void window.api.pulse.remove({ id }).then((res) => {
      if (!res.ok) {
        console.error("[tasks] pulse 操作失败", res.error);
        return;
      }
      setPulses((prev) => prev.filter((p) => p.id !== id));
    }).catch((e) => console.error("[tasks] pulse 操作失败", e));
  }, []);
  const actions = reactExports.useMemo(
    () => ({
      expand,
      toggleStep,
      completeTask,
      confirmComplete,
      confirmCompleteNoPoints,
      completeOccurrence,
      cancelComplete,
      reorder,
      createManual,
      updateTask,
      removeTask,
      createPulse,
      setPulseEnabled,
      removePulse
    }),
    [
      expand,
      toggleStep,
      completeTask,
      confirmComplete,
      confirmCompleteNoPoints,
      completeOccurrence,
      cancelComplete,
      reorder,
      createManual,
      updateTask,
      removeTask,
      createPulse,
      setPulseEnabled,
      removePulse
    ]
  );
  return {
    tasks,
    pulses,
    doneTasks,
    missedTasks,
    reviewingIds,
    occurrences,
    subtasksByParent,
    expandedId,
    confirmId,
    focusId,
    notice,
    actions
  };
}
const REPEAT_KINDS = [
  { unit: "D", label: "每天" },
  { unit: "W", label: "每周" },
  { unit: "M", label: "每月" },
  { unit: "Y", label: "每年" }
];
const REPEAT_UNIT_LABEL = { D: "天", W: "周", M: "月", Y: "年" };
const REPEAT_WEEKDAY_LABEL = ["一", "二", "三", "四", "五", "六", "日"];
function dragIdOf(e) {
  return e.dataTransfer.getData("text/plain");
}
function DailyGroup({
  rows,
  expandedId,
  focusId,
  subtasksByParent,
  actions,
  onExpand,
  onComplete
}) {
  if (rows.length === 0) return null;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "task-group", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { className: "task-group-title", children: TYPE_LABEL.daily }),
    rows.map(({ occurrence, task }) => {
      const done = occurrence.status === "done";
      return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            className: [
              "task-row",
              done ? "task-row--done" : "",
              task && focusId === task.id ? "task-row--focus" : ""
            ].filter(Boolean).join(" "),
            "data-task-id": task?.id,
            onClick: () => task && onExpand(task.id),
            role: "presentation",
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                "button",
                {
                  "aria-label": occurrence.taskTitle ?? task?.title ?? "",
                  className: done ? "task-check task-check--on" : "task-check",
                  disabled: done,
                  onClick: (event) => {
                    event.stopPropagation();
                    onComplete(occurrence.id);
                  },
                  type: "button"
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "task-title", children: occurrence.taskTitle ?? task?.title ?? "" }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "task-streak", children: task?.streakCurrent ?? 0 })
            ]
          }
        ),
        task && expandedId === task.id ? /* @__PURE__ */ jsxRuntimeExports.jsx(
          TaskDetail,
          {
            actions,
            busy: false,
            confirming: false,
            subtasks: subtasksByParent.get(task.id) ?? [],
            task
          }
        ) : null
      ] }, occurrence.id);
    })
  ] });
}
function TaskRight({ task, now, actions }) {
  const [editing, setEditing] = reactExports.useState(false);
  const [draftDate, setDraftDate] = reactExports.useState("");
  const [draftTime, setDraftTime] = reactExports.useState("");
  const stop = (event) => {
    event.stopPropagation();
  };
  const commit = () => {
    if (draftDate === "") {
      setEditing(false);
      return;
    }
    if (draftDate === dueDateValueOf(task.dueAt) && draftTime === dueTimeValueOf(task.dueAt)) {
      setEditing(false);
      return;
    }
    actions.updateTask(task.id, { dueAt: duePatchOfParts(draftDate, draftTime) });
    setEditing(false);
  };
  const onPairBlur = (event) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    commit();
  };
  const onPairKeyDown = (event) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") setEditing(false);
  };
  if (editing) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "task-remaining", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "task-due-pair", onBlur: onPairBlur, onKeyDown: onPairKeyDown, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          "aria-label": "日期",
          autoFocus: true,
          className: "task-due-inline task-due-inline--date",
          draggable: false,
          type: "date",
          value: draftDate,
          onChange: (event) => setDraftDate(event.target.value),
          onClick: stop,
          onDragStart: (event) => event.preventDefault(),
          onMouseDown: stop
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          "aria-label": "时间",
          className: "task-due-inline task-due-inline--time",
          draggable: false,
          type: "time",
          value: draftTime,
          onChange: (event) => setDraftTime(event.target.value),
          onClick: stop,
          onDragStart: (event) => event.preventDefault(),
          onMouseDown: stop
        }
      )
    ] }) });
  }
  const { remaining, due } = taskRightParts(task, now);
  const editable = due !== "" && canEditDueOf(task);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "task-remaining", children: [
    remaining !== "" ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: remaining }) : null,
    remaining !== "" && due !== "" ? " · " : null,
    due === "" ? null : editable ? /* @__PURE__ */ jsxRuntimeExports.jsx(
      "button",
      {
        className: "task-due-btn",
        onClick: (event) => {
          event.stopPropagation();
          setDraftDate(dueDateValueOf(task.dueAt));
          setDraftTime(dueTimeValueOf(task.dueAt));
          setEditing(true);
        },
        type: "button",
        children: due
      }
    ) : /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: due })
  ] });
}
function TaskGroup({
  label,
  tasks,
  expandedId,
  confirmingId,
  focusId,
  notice,
  subtasksByParent,
  actions,
  now,
  reviewingIds,
  onExpand,
  onDropRow
}) {
  const [dragOverId, setDragOverId] = reactExports.useState(null);
  if (tasks.length === 0) return null;
  const dropBefore = (targetId) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const id = dragIdOf(e);
    setDragOverId(null);
    if (id) onDropRow(id, targetId);
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "task-group", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { className: "task-group-title", children: label }),
    tasks.map((task) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "div",
        {
          className: [
            "task-row",
            // v0.34：missed（审核驳回且已过截止）与 done **同档**——沉底、变淡、右列留空，
            // 复用同一个类名与样式，不新增视觉、不加任何文字
            task.status === "done" || task.status === "missed" ? "task-row--done" : "",
            dragOverId === task.id ? "task-row--drop" : "",
            focusId === task.id ? "task-row--focus" : ""
          ].filter(Boolean).join(" "),
          "data-task-id": task.id,
          draggable: true,
          onClick: () => onExpand(task.id),
          onDragEnd: () => setDragOverId(null),
          onDragOver: (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOverId(task.id);
          },
          onDrop: dropBefore(task.id),
          role: "presentation",
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "span",
              {
                "aria-hidden": true,
                className: `task-dot task-dot--${task.status === "pending_review" ? "reviewing" : task.status}`
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "task-title", children: task.title }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(TaskRight, { actions, now, task })
          ]
        }
      ),
      notice !== null && notice.taskId === task.id ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "task-notice", children: notice.message }) : null,
      expandedId === task.id ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        TaskDetail,
        {
          actions,
          busy: reviewingIds.has(task.id),
          confirming: confirmingId === task.id,
          subtasks: subtasksByParent.get(task.id) ?? [],
          task
        }
      ) : null
    ] }, task.id)),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "div",
      {
        className: "task-drop-tail",
        onDragOver: (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        },
        onDrop: dropBefore(null)
      }
    )
  ] });
}
function TaskDetail({ task, subtasks, confirming, busy, actions }) {
  const offsets = reminderSummary(task.type, task.dailyTime, task.reminderOffsets);
  const [repeatOpen, setRepeatOpen] = reactExports.useState(false);
  const [repeatUnit, setRepeatUnit] = reactExports.useState("D");
  const [repeatN, setRepeatN] = reactExports.useState("1");
  const [repeatWeekdays, setRepeatWeekdays] = reactExports.useState([1]);
  const [repeatMonthDay, setRepeatMonthDay] = reactExports.useState("");
  const [repeatYearMonth, setRepeatYearMonth] = reactExports.useState("");
  const [repeatYearDay, setRepeatYearDay] = reactExports.useState("");
  const [repeatTime, setRepeatTime] = reactExports.useState("");
  const [deleteConfirm, setDeleteConfirm] = reactExports.useState(false);
  const openRepeat = () => {
    const r = parseRepeatRule(task.repeatRule);
    setRepeatUnit(r.unit);
    setRepeatN(String(r.n));
    setRepeatWeekdays(r.weekdays.length > 0 ? r.weekdays : [1]);
    setRepeatMonthDay(r.monthDays.length > 0 ? String(r.monthDays[0]) : "");
    setRepeatYearMonth(r.monthDay === null ? "" : String(Number(r.monthDay.slice(0, 2))));
    setRepeatYearDay(r.monthDay === null ? "" : String(Number(r.monthDay.slice(3))));
    setRepeatTime(task.dailyTime ?? "");
    setRepeatOpen(true);
  };
  const ruleOfDraft = (unit, nText, weekdays, monthDayText, yearMonth, yearDay) => {
    const base = {
      n: Number(nText.trim()),
      unit,
      weekdays: [],
      monthDays: [],
      monthDay: null
    };
    if (unit === "W") return { ...base, weekdays };
    if (unit === "M") {
      if (monthDayText.trim() === "") return base;
      return { ...base, monthDays: [Number(monthDayText.trim())] };
    }
    if (unit === "Y") {
      const m = yearMonth.trim();
      const d = yearDay.trim();
      if (m === "" && d === "") return base;
      if (m === "" || d === "") return null;
      const pad = (v) => Number(v) < 10 ? `0${Number(v)}` : String(Number(v));
      return { ...base, monthDay: `${pad(m)}-${pad(d)}` };
    }
    return base;
  };
  const commitRepeat = (draft2, closeOnSuccess) => {
    let serialized;
    try {
      const r = ruleOfDraft(
        draft2.unit,
        draft2.nText,
        draft2.weekdays,
        draft2.monthDayText,
        draft2.yearMonth,
        draft2.yearDay
      );
      if (r === null) {
        setRepeatOpen(false);
        return;
      }
      serialized = serializeRepeatRule(r);
      parseRepeatRule(serialized);
    } catch {
      setRepeatOpen(false);
      return;
    }
    void window.api.task.update({
      id: task.id,
      patch: {
        repeatRule: serialized,
        // 时刻清空是合法操作：写 null，让 syncForTask 把旧时刻的提醒行全清掉
        dailyTime: draft2.timeText.trim() === "" ? null : draft2.timeText.trim()
      }
    }).then((res) => {
      if (!res.ok) {
        console.error("[tasks] task.update 失败", res.error.message);
        return;
      }
      if (closeOnSuccess) setRepeatOpen(false);
    }).catch((e) => console.error("[tasks] task.update 调用失败", e));
  };
  const commitCurrent = () => commitRepeat({
    unit: repeatUnit,
    nText: repeatN,
    weekdays: repeatWeekdays,
    monthDayText: repeatMonthDay,
    yearMonth: repeatYearMonth,
    yearDay: repeatYearDay,
    timeText: repeatTime
  }, true);
  const onRepeatKind = (next) => {
    setRepeatUnit(next);
    const weekdays = next === "W" && repeatWeekdays.length === 0 ? [1] : repeatWeekdays;
    if (next === "W" && repeatWeekdays.length === 0) setRepeatWeekdays([1]);
    commitRepeat({
      unit: next,
      nText: repeatN,
      weekdays,
      monthDayText: repeatMonthDay,
      yearMonth: repeatYearMonth,
      yearDay: repeatYearDay,
      timeText: repeatTime
    }, false);
  };
  const onRepeatBlur = (event) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    commitCurrent();
  };
  const onRepeatKeyDown = (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) commitCurrent();
  };
  const canEditDue = canEditDueOf(task);
  let repeatLabel = "";
  try {
    repeatLabel = describeRepeatRule(task.repeatRule);
  } catch {
    repeatLabel = "";
  }
  const repeatText = [repeatLabel, task.dailyTime ?? ""].filter(Boolean).join(" ");
  const canDelete = task.status === "todo" || task.status === "doing" || task.status === "pending_review" || task.status === "reviewing";
  const askDelete = () => {
    if (confirming) actions.cancelComplete();
    setDeleteConfirm(true);
  };
  const confirmDelete = () => {
    actions.removeTask(task.id);
    setDeleteConfirm(false);
  };
  const [dueDateDraft, setDueDateDraft] = reactExports.useState(() => dueDateValueOf(task.dueAt));
  const [dueTimeDraft, setDueTimeDraft] = reactExports.useState(() => dueTimeValueOf(task.dueAt));
  reactExports.useEffect(() => {
    setDueDateDraft(dueDateValueOf(task.dueAt));
    setDueTimeDraft(dueTimeValueOf(task.dueAt));
  }, [task.id, task.dueAt]);
  const commitDue = () => {
    if (dueDateDraft === "") {
      setDueDateDraft(dueDateValueOf(task.dueAt));
      setDueTimeDraft(dueTimeValueOf(task.dueAt));
      return;
    }
    if (dueDateDraft === dueDateValueOf(task.dueAt) && dueTimeDraft === dueTimeValueOf(task.dueAt)) {
      return;
    }
    actions.updateTask(task.id, { dueAt: duePatchOfParts(dueDateDraft, dueTimeDraft) });
  };
  const onEditBlur = (event) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    commitDue();
  };
  const onEditKeyDown = (event) => {
    if (event.key === "Enter") commitDue();
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "task-detail", children: [
    task.detailMd ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "task-detail-md", children: /* @__PURE__ */ jsxRuntimeExports.jsx(MarkdownText, { text: task.detailMd }) }) : null,
    subtasks.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "task-steps", children: subtasks.map((step) => {
      const checked = isStepChecked(step);
      return /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { className: "task-step", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            "aria-label": step.title,
            "aria-pressed": checked,
            className: `task-step-check ${checked ? "task-step-check--on" : ""}`,
            onClick: () => actions.toggleStep(step),
            type: "button"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: checked ? "task-step-title--on" : "task-step-title", children: step.title })
      ] }, step.id);
    }) }) : null,
    task.type !== "daily" && offsets ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "task-offsets", children: offsets }) : null,
    task.type === "daily" ? repeatOpen ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { onBlur: onRepeatBlur, onKeyDown: onRepeatKeyDown, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "task-repeat-kinds", children: REPEAT_KINDS.map((kind) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          "aria-pressed": repeatUnit === kind.unit,
          onClick: () => onRepeatKind(kind.unit),
          type: "button",
          children: kind.label
        },
        kind.unit
      )) }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "task-repeat-every", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "每" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            className: "task-due-edit-input task-repeat-num",
            type: "number",
            value: repeatN,
            onChange: (event) => setRepeatN(event.target.value)
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: REPEAT_UNIT_LABEL[repeatUnit] })
      ] }),
      repeatUnit === "W" ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "task-repeat-days", children: REPEAT_WEEKDAY_LABEL.map((label, index) => {
        const weekday = index + 1;
        const on = repeatWeekdays.includes(weekday);
        return /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            "aria-pressed": on,
            onClick: () => {
              if (on && repeatWeekdays.length === 1) return;
              setRepeatWeekdays(
                on ? repeatWeekdays.filter((w) => w !== weekday) : [...repeatWeekdays, weekday].sort((a, b) => a - b)
              );
            },
            type: "button",
            children: label
          },
          weekday
        );
      }) }) : null,
      repeatUnit === "M" ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "task-repeat-every", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "task-due-edit-input task-repeat-num",
          type: "number",
          value: repeatMonthDay,
          onChange: (event) => setRepeatMonthDay(event.target.value)
        }
      ) }) : null,
      repeatUnit === "Y" ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "task-repeat-every", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            className: "task-due-edit-input task-repeat-num",
            type: "number",
            value: repeatYearMonth,
            onChange: (event) => setRepeatYearMonth(event.target.value)
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "月" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            className: "task-due-edit-input task-repeat-num",
            type: "number",
            value: repeatYearDay,
            onChange: (event) => setRepeatYearDay(event.target.value)
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "日" })
      ] }) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "task-repeat-every", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "task-due-edit-input task-repeat-time",
          type: "time",
          value: repeatTime,
          onChange: (event) => setRepeatTime(event.target.value)
        }
      ) })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "task-repeat-row", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "重复" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "task-repeat-value", onClick: openRepeat, type: "button", children: repeatText })
    ] }) : null,
    canEditDue ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "task-due-edit", onBlur: onEditBlur, onKeyDown: onEditKeyDown, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          "aria-label": "日期",
          className: "task-due-edit-input task-due-edit-input--date",
          type: "date",
          value: dueDateDraft,
          onChange: (event) => setDueDateDraft(event.target.value)
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          "aria-label": "时间",
          className: "task-due-edit-input task-due-edit-input--time",
          type: "time",
          value: dueTimeDraft,
          onChange: (event) => setDueTimeDraft(event.target.value)
        }
      )
    ] }) : null,
    canDelete ? deleteConfirm ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "task-confirm-bar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "btn btn--primary", onClick: confirmDelete, type: "button", children: "删除" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "btn btn--ghost", onClick: () => setDeleteConfirm(false), type: "button", children: "取消" })
    ] }) : confirming ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "task-confirm-bar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "btn btn--primary",
          disabled: busy,
          onClick: () => actions.confirmComplete(task),
          type: "button",
          children: "完成"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "btn btn--faint",
          disabled: busy,
          onClick: () => actions.confirmCompleteNoPoints(task),
          type: "button",
          children: "直接标记完成（不计分）"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "btn btn--ghost", onClick: actions.cancelComplete, type: "button", children: "继续做" })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "task-detail-actions", children: [
      task.type !== "daily" && task.status !== "done" && task.status !== "missed" && task.status !== "pending_review" ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "btn btn--primary",
          disabled: busy,
          onClick: () => actions.completeTask(task),
          type: "button",
          children: "完成"
        }
      ) : null,
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "btn btn--ghost", onClick: askDelete, type: "button", children: "删除" })
    ] }) : null
  ] });
}
function PulseSection({ pulses, actions }) {
  const intervalLabel = (minutes) => minutes >= 60 && minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  const windowLabel = (item) => item.windowStart !== null && item.windowEnd !== null && item.windowStart !== "" && item.windowEnd !== "" ? `${item.windowStart}–${item.windowEnd}` : "";
  if (pulses.length === 0) return null;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "task-group", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { className: "task-group-title", children: "周期提醒" }),
    pulses.map((item) => {
      const win = windowLabel(item);
      return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "pulse-row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "task-title", children: item.title }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "pulse-meta", children: intervalLabel(item.intervalMinutes) }),
        win === "" ? null : /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "pulse-meta", children: win }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "pulse-btn",
            onClick: () => actions.setPulseEnabled({ id: item.id, enabled: !item.enabled }),
            type: "button",
            children: item.enabled ? "暂停" : "启用"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "pulse-btn", onClick: () => actions.removePulse(item.id), type: "button", children: "删除" })
      ] }, item.id);
    })
  ] });
}
function TasksPanel() {
  const {
    tasks,
    pulses,
    doneTasks,
    missedTasks,
    reviewingIds,
    occurrences,
    subtasksByParent,
    expandedId,
    confirmId,
    focusId,
    notice,
    actions
  } = useTasksData();
  const groups = reactExports.useMemo(
    // 活跃 + 今日已完成 + 今日判失败一起进模型：done / missed 沉底、变淡是模型层排好的（v0.27 / v0.34）
    () => groupTasks([...tasks, ...doneTasks, ...missedTasks], occurrences),
    [tasks, doneTasks, missedTasks, occurrences]
  );
  const now = /* @__PURE__ */ new Date();
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "tasks-panel", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(NewTaskForm, { actions }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(PulseSection, { actions, pulses }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      DailyGroup,
      {
        actions,
        expandedId,
        focusId,
        rows: groups.daily,
        subtasksByParent,
        onComplete: actions.completeOccurrence,
        onExpand: actions.expand
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      TaskGroup,
      {
        actions,
        expandedId,
        confirmingId: confirmId,
        focusId,
        label: TYPE_LABEL.deadline,
        notice,
        now,
        onDropRow: actions.reorder,
        onExpand: actions.expand,
        reviewingIds,
        subtasksByParent,
        tasks: groups.deadline
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      TaskGroup,
      {
        actions,
        expandedId,
        confirmingId: confirmId,
        focusId,
        label: TYPE_LABEL.event,
        notice,
        now,
        onDropRow: actions.reorder,
        onExpand: actions.expand,
        reviewingIds,
        subtasksByParent,
        tasks: groups.event
      }
    )
  ] });
}
const WEEKDAY_HEADERS = ["一", "二", "三", "四", "五", "六", "日"];
const CN_WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const pad2$2 = (n) => n < 10 ? `0${n}` : String(n);
function dayOf(year, month, day) {
  return `${year}-${pad2$2(month)}-${pad2$2(day)}`;
}
function monthKey(year, month) {
  return `${year}-${pad2$2(month)}`;
}
function monthTitle(year, month) {
  return `${year} 年 ${month} 月`;
}
function shiftMonth(year, month, delta) {
  const index = month - 1 + delta;
  return {
    year: year + Math.floor(index / 12),
    month: (index % 12 + 12) % 12 + 1
  };
}
function buildMonthGrid(year, month) {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const lead = (firstDow + 6) % 7;
  const daysInMonth2 = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth2; d += 1) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { weeks };
}
function dotStateOf(entry) {
  if (!entry || entry.total <= 0) return "none";
  return entry.doneCount >= entry.total ? "hollow" : "solid";
}
function indexByDay(entries) {
  const map = /* @__PURE__ */ new Map();
  for (const e of entries) map.set(e.day, e);
  return map;
}
function weekdayCnOfDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return CN_WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
function floorTitle(day) {
  const [, m, d] = day.split("-").map(Number);
  return `${m} 月 ${d} 日 周${weekdayCnOfDay(day)}`;
}
function sortDayDetail(items) {
  return [...items].sort((a, b) => {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
    if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
    if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
    return 0;
  });
}
const REFRESH_COALESCE_MS = 200;
function useCalendarData() {
  const [view, setView] = reactExports.useState(() => {
    const now = /* @__PURE__ */ new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [index, setIndex] = reactExports.useState(() => /* @__PURE__ */ new Map());
  const [rev, setRev] = reactExports.useState(0);
  const indexIssuedRef = reactExports.useRef("");
  const indexLatestRef = reactExports.useRef("");
  const key = monthKey(view.year, view.month);
  reactExports.useEffect(() => {
    const token = `${key}#${rev}`;
    indexLatestRef.current = token;
    if (indexIssuedRef.current === token) return;
    indexIssuedRef.current = token;
    void window.api.calendar.dayIndex({ year: view.year, month: view.month }).then((res) => {
      if (indexLatestRef.current !== token) return;
      if (!res.ok) {
        console.error("[calendar] calendar.dayIndex 失败", res.error);
        setIndex(/* @__PURE__ */ new Map());
        return;
      }
      setIndex(indexByDay(res.data));
    }).catch((e) => console.error("[calendar] calendar.dayIndex 调用失败", e));
  }, [key, rev, view.year, view.month]);
  reactExports.useEffect(() => {
    let timer = null;
    const off = window.api.onEvent((e) => {
      switch (e.type) {
        case "task.created":
        case "task.updated":
        case "task.removed":
          if (timer !== null) return;
          timer = setTimeout(() => {
            timer = null;
            setRev((r) => r + 1);
          }, REFRESH_COALESCE_MS);
          break;
      }
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      off();
    };
  }, []);
  const prevMonth = reactExports.useCallback(() => {
    setView((v) => shiftMonth(v.year, v.month, -1));
  }, []);
  const nextMonth = reactExports.useCallback(() => {
    setView((v) => shiftMonth(v.year, v.month, 1));
  }, []);
  const actions = reactExports.useMemo(() => ({ prevMonth, nextMonth }), [prevMonth, nextMonth]);
  return { year: view.year, month: view.month, index, actions };
}
function useDayTasks(day) {
  const [rows, setRows] = reactExports.useState([]);
  const [rev, setRev] = reactExports.useState(0);
  const issuedRef = reactExports.useRef("");
  const latestRef = reactExports.useRef("");
  reactExports.useEffect(() => {
    const token = `${day}#${rev}`;
    latestRef.current = token;
    if (issuedRef.current === token) return;
    issuedRef.current = token;
    void window.api.calendar.dayDetail({ day }).then((res) => {
      if (latestRef.current !== token) return;
      if (!res.ok) {
        console.error("[calendar] calendar.dayDetail 失败", res.error);
        setRows([]);
        return;
      }
      setRows(sortDayDetail(res.data));
    }).catch((e) => console.error("[calendar] calendar.dayDetail 调用失败", e));
  }, [day, rev]);
  reactExports.useEffect(() => {
    let timer = null;
    const off = window.api.onEvent((e) => {
      switch (e.type) {
        case "task.created":
        case "task.updated":
        case "task.removed":
          if (timer !== null) return;
          timer = setTimeout(() => {
            timer = null;
            setRev((r) => r + 1);
          }, REFRESH_COALESCE_MS);
          break;
      }
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      off();
    };
  }, []);
  return rows;
}
const COLLAPSED_KEY = "taskloop:calendar:collapsed";
function CalendarPanel({
  selectedDay,
  onSelectDay
}) {
  const { year, month, index, actions } = useCalendarData();
  const grid = reactExports.useMemo(() => buildMonthGrid(year, month), [year, month]);
  const today = toLocalDay(/* @__PURE__ */ new Date());
  const [collapsed, setCollapsed] = reactExports.useState(
    () => window.localStorage.getItem(COLLAPSED_KEY) === "1"
  );
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    window.localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: collapsed ? "calendar-panel calendar-panel--collapsed" : "calendar-panel", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "calendar-head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          "aria-label": "上个月",
          className: "calendar-nav",
          onClick: actions.prevMonth,
          type: "button",
          children: "‹"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "calendar-title", children: monthTitle(year, month) }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "calendar-head-right", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            "aria-label": "下个月",
            className: "calendar-nav",
            onClick: actions.nextMonth,
            type: "button",
            children: "›"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            "aria-label": collapsed ? "展开日历" : "折叠日历",
            className: "calendar-fold",
            onClick: () => toggle(),
            type: "button",
            children: /* @__PURE__ */ jsxRuntimeExports.jsx(
              "svg",
              {
                "aria-hidden": true,
                fill: "none",
                height: "10",
                stroke: "currentColor",
                strokeLinecap: "round",
                strokeWidth: "1.5",
                viewBox: "0 0 10 10",
                width: "10",
                children: /* @__PURE__ */ jsxRuntimeExports.jsx("path", { d: collapsed ? "M2 3.5 L5 6.5 L8 3.5" : "M2 6.5 L5 3.5 L8 6.5" })
              }
            )
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "calendar-weekdays", children: WEEKDAY_HEADERS.map((w) => /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: w }, w)) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "div",
      {
        className: "calendar-grid",
        style: { gridTemplateRows: `repeat(${grid.weeks.length}, 1fr)` },
        children: grid.weeks.map(
          (week, wi) => week.map((dayNum, di) => {
            const key = `${wi}-${di}`;
            if (dayNum === null)
              return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "calendar-cell calendar-cell--blank" }, key);
            const day = dayOf(year, month, dayNum);
            const dot = dotStateOf(index.get(day));
            const cls = [
              "calendar-cell",
              dot === "none" ? "" : "calendar-cell--marked",
              day === today ? "calendar-cell--today" : "",
              day === selectedDay ? "calendar-cell--open" : ""
            ].filter(Boolean).join(" ");
            return /* @__PURE__ */ jsxRuntimeExports.jsxs(
              "button",
              {
                "aria-pressed": day === selectedDay,
                className: cls,
                onClick: () => onSelectDay(day),
                type: "button",
                children: [
                  /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "calendar-daynum", children: dayNum }),
                  /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "calendar-dotrow", "aria-hidden": true, children: dot === "none" ? null : /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `calendar-dot calendar-dot--${dot}` }) })
                ]
              },
              key
            );
          })
        )
      }
    )
  ] });
}
function CalendarDayView({ day }) {
  const rows = useDayTasks(day);
  const focusTask = (taskId) => {
    window.dispatchEvent(new CustomEvent("taskloop:focus-task", { detail: { id: taskId } }));
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "calendar-dayview", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "calendar-dayview-head", children: floorTitle(day) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "ul",
      {
        className: `calendar-dayview-list${rows.length === 0 ? " calendar-dayview-list--empty" : ""}`,
        children: rows.map((row) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "button",
          {
            className: `calendar-row${row.status === "done" ? " calendar-row--done" : ""}`,
            onClick: () => focusTask(row.taskId),
            type: "button",
            children: [
              row.time !== "" && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "calendar-row-time", children: row.time }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "calendar-row-title", children: row.title }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "calendar-row-type", children: TYPE_LABEL[row.type] }),
              row.points !== null && /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "calendar-row-points", children: [
                fmtPoints(row.points),
                " 分"
              ] })
            ]
          }
        ) }, row.taskId))
      }
    )
  ] });
}
const RANGE_LABEL = {
  today: "今日",
  week: "本周",
  month: "本月"
};
const LEDGER_VIEW_LABEL = "明细";
const pad2$1 = (n) => n < 10 ? `0${n}` : String(n);
function localDayOf(d) {
  return `${d.getFullYear()}-${pad2$1(d.getMonth() + 1)}-${pad2$1(d.getDate())}`;
}
function shiftDay(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${pad2$1(dt.getUTCMonth() + 1)}-${pad2$1(dt.getUTCDate())}`;
}
function weekStartOf(day) {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const isoDow = dow === 0 ? 7 : dow;
  return shiftDay(day, -(isoDow - 1));
}
function monthStartOf(day) {
  return `${day.slice(0, 7)}-01`;
}
function rangeOf(range, today) {
  if (range === "today") return { from: today, to: today };
  if (range === "week") return { from: weekStartOf(today), to: today };
  return { from: monthStartOf(today), to: today };
}
function lastDays(today, count = 7) {
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) out.push(shiftDay(today, -i));
  return out;
}
function pointsByDay(stats) {
  const map = /* @__PURE__ */ new Map();
  for (const stat of stats) map.set(stat.day, stat.points);
  return map;
}
function sumPoints(stats, from, to) {
  let total = 0;
  for (const stat of stats) if (stat.day >= from && stat.day <= to) total += stat.points;
  return total;
}
function barsOf(stats, today, count = 7) {
  const byDay = pointsByDay(stats);
  const days = lastDays(today, count);
  const values = days.map((day) => byDay.get(day) ?? 0);
  const peak = Math.max(1, ...values.map((v) => v > 0 ? v : 0));
  return days.map((day, i) => {
    const points = values[i];
    const positive = points > 0 ? points : 0;
    return { day, points, ratio: positive === 0 ? 0.06 : Math.max(0.06, positive / peak) };
  });
}
function formatSigned(value) {
  const text = fmtPoints(value);
  return value > 0 ? `+${text}` : text === "0" ? "+0" : text;
}
function timeLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad2$1(d.getHours())}:${pad2$1(d.getMinutes())}`;
}
const pad2 = (n) => n < 10 ? `0${n}` : String(n);
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function monthEndOf(month) {
  const [year, mon] = month.split("-").map(Number);
  return `${month.slice(0, 7)}-${pad2(daysInMonth(year, mon))}`;
}
function monthRangeOf(month) {
  return { from: month, to: monthEndOf(month) };
}
function shiftMonthOf(month, delta) {
  const [year, mon] = month.split("-").map(Number);
  const index = year * 12 + (mon - 1) + delta;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return `${y}-${pad2(m)}-01`;
}
function monthLabelOf(month) {
  const [year, mon] = month.split("-").map(Number);
  return `${year}年${mon}月`;
}
function dayLabelOf(day) {
  const [, mon, d] = day.split("-").map(Number);
  return `${mon}月${d}日`;
}
function canGoNextMonth(month, today) {
  return month < monthStartOf(today);
}
function stepMonthOf(month, delta, today) {
  const next = shiftMonthOf(month, delta);
  return next <= monthStartOf(today) ? next : month;
}
function monthNetOf(stats) {
  let total = 0;
  for (const stat of stats) total += stat.points;
  return total;
}
function compareIsoDesc(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
  return a < b ? 1 : a > b ? -1 : 0;
}
function groupEntriesByDay(entries) {
  const map = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const list = map.get(entry.day);
    if (list) list.push(entry);
    else map.set(entry.day, [entry]);
  }
  return [...map.entries()].sort(([a], [b]) => a < b ? 1 : a > b ? -1 : 0).map(([day, list]) => {
    const sorted = [...list].sort(
      (x, y) => compareIsoDesc(x.createdAt, y.createdAt) || compareIsoDesc(x.id, y.id)
    );
    let net = 0;
    for (const entry of sorted) net += entry.delta;
    return { day, net, entries: sorted };
  });
}
function netLabel(value) {
  return fmtPoints(value) === "0" ? "0" : formatSigned(value);
}
const LEDGER_LIMIT$1 = 500;
function useLedgerView() {
  const [today, setToday] = reactExports.useState(() => toLocalDay(/* @__PURE__ */ new Date()));
  const [month, setMonth] = reactExports.useState(() => monthStartOf(today));
  const [entries, setEntries] = reactExports.useState([]);
  const [stats, setStats] = reactExports.useState([]);
  const seq = reactExports.useRef(0);
  const reload = reactExports.useCallback((target) => {
    seq.current += 1;
    const mine = seq.current;
    setToday(toLocalDay(/* @__PURE__ */ new Date()));
    const { from, to } = monthRangeOf(target);
    const [year, mon] = target.split("-").map(Number);
    void Promise.all([
      window.api.points.ledger({ from, to, limit: LEDGER_LIMIT$1 }),
      window.api.points.monthStats({ year, month: mon })
    ]).then(([ledgerRes, statsRes]) => {
      if (mine !== seq.current) return;
      if (!ledgerRes.ok || !statsRes.ok) {
        console.error("[ledger] 读取失败", ledgerRes, statsRes);
        setEntries([]);
        setStats([]);
        return;
      }
      setEntries(ledgerRes.data);
      setStats(statsRes.data);
    }).catch((e) => {
      console.error("[ledger] 读取失败", e);
      if (mine !== seq.current) return;
      setEntries([]);
      setStats([]);
    });
  }, []);
  reactExports.useEffect(() => {
    reload(month);
  }, [reload, month]);
  reactExports.useEffect(() => {
    const off = window.api.onEvent((e) => {
      if (e.type === "points.changed" || e.type === "daystats.changed") reload(month);
    });
    return off;
  }, [reload, month]);
  const shiftMonth2 = reactExports.useCallback((delta) => {
    setMonth((current) => stepMonthOf(current, delta, toLocalDay(/* @__PURE__ */ new Date())));
  }, []);
  const groups = reactExports.useMemo(() => groupEntriesByDay(entries), [entries]);
  const net = reactExports.useMemo(() => monthNetOf(stats), [stats]);
  const canGoNext = reactExports.useMemo(() => canGoNextMonth(month, today), [month, today]);
  return { month, net, groups, canGoNext, shiftMonth: shiftMonth2 };
}
function LedgerView({ onOpenTask }) {
  const { month, net, groups, canGoNext, shiftMonth: shiftMonth2 } = useLedgerView();
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ledger-view", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "ledger-nav", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          "aria-label": "上个月",
          className: "ledger-step",
          onClick: () => shiftMonth2(-1),
          type: "button",
          children: "‹"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ledger-nav-month", children: monthLabelOf(month) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          "aria-label": "下个月",
          className: "ledger-step",
          disabled: !canGoNext,
          onClick: () => shiftMonth2(1),
          type: "button",
          children: "›"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: net < 0 ? "ledger-nav-net ledger-nav-net--neg" : "ledger-nav-net", children: netLabel(net) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ledger-body", children: groups.map((group) => /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "ledger-group", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ledger-group-head", children: /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: dayLabelOf(group.day) }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "ledger-group-list", children: group.entries.map((entry) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "button",
        {
          className: entry.reversedAt === null ? "ledger-row" : "ledger-row ledger-row--reversed",
          onClick: () => {
            if (entry.taskId !== null) onOpenTask(entry.taskId);
          },
          type: "button",
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ledger-time", children: timeLabel(entry.createdAt) }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ledger-text", children: entry.reasonText }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "span",
              {
                className: entry.delta < 0 ? "ledger-delta ledger-delta--neg" : "ledger-delta",
                children: formatSigned(entry.delta)
              }
            )
          ]
        }
      ) }, entry.id)) })
    ] }, group.day)) })
  ] });
}
const MONTHLY_BUDGET_CENTS = 5e4;
const MAX_SPEND_CENTS = 1e5;
const SPEND_VIEW_LABEL = "支出";
function parseAmountToCents(raw) {
  const text = raw.trim();
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text)) return null;
  const [intPart, fracPart = ""] = text.split(".");
  const cents = parseInt(intPart, 10) * 100 + parseInt(fracPart.padEnd(2, "0"), 10);
  if (!Number.isInteger(cents) || cents <= 0 || cents > MAX_SPEND_CENTS) return null;
  return cents;
}
function spendHeaderParts(month, rate, spentCents) {
  return {
    prefix: `${month} 月 · 1 分 = ${fmtPoints(rate)} 元 · `,
    spent: `已花 ${fmtMoney(spentCents)} / ${fmtMoney(MONTHLY_BUDGET_CENTS)}`
  };
}
function isOverBudget(spentCents) {
  return spentCents > MONTHLY_BUDGET_CENTS;
}
function spendToday(now = /* @__PURE__ */ new Date()) {
  return localDayOf(now);
}
function spendTimeLabel(iso, today) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  const time = timeLabel(iso);
  const day = localDayOf(parsed);
  if (day === today) return time;
  if (day === shiftDay(today, -1)) return `昨天 ${time}`;
  return `${parsed.getMonth() + 1}月${parsed.getDate()}日 ${time}`;
}
function useSpendData() {
  const [entries, setEntries] = reactExports.useState([]);
  const [totalCents, setTotalCents] = reactExports.useState(0);
  const [rate, setRate] = reactExports.useState(1);
  const [submitting, setSubmitting] = reactExports.useState(false);
  const [undoingId, setUndoingId] = reactExports.useState(null);
  const [error, setError] = reactExports.useState(null);
  const reload = reactExports.useCallback(() => {
    void window.api.points.spendMonth().then((res) => {
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      setEntries(res.data.entries);
      setTotalCents(res.data.totalCents);
      setRate(res.data.rate);
    }).catch((e) => {
      console.error("[spend] 本月支出加载失败", e);
    });
  }, []);
  reactExports.useEffect(() => {
    reload();
  }, [reload]);
  reactExports.useEffect(() => {
    const off = window.api.onEvent((e) => {
      if (e.type === "points.changed" || e.type === "fx.changed") reload();
    });
    return off;
  }, [reload]);
  const submit = reactExports.useCallback(
    async (amountCents, note) => {
      setSubmitting(true);
      setError(null);
      try {
        const trimmed = note.trim();
        const res = await window.api.points.spend(
          trimmed === "" ? { amountCents } : { amountCents, note: trimmed }
        );
        if (!res.ok) {
          setError(res.error.message);
          return false;
        }
        reload();
        return true;
      } catch (e) {
        console.error("[spend] 记账失败", e);
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [reload]
  );
  const undo = reactExports.useCallback(
    async (entryId) => {
      setUndoingId(entryId);
      setError(null);
      try {
        const res = await window.api.points.spendUndo({ entryId });
        if (!res.ok) {
          setError(res.error.message);
          return;
        }
        reload();
      } catch (e) {
        console.error("[spend] 撤销失败", e);
      } finally {
        setUndoingId(null);
      }
    },
    [reload]
  );
  return { entries, totalCents, rate, submitting, undoingId, error, submit, undo };
}
function SpendView() {
  const { entries, totalCents, rate, submitting, undoingId, error, submit, undo } = useSpendData();
  const [amount, setAmount] = reactExports.useState("");
  const [note, setNote] = reactExports.useState("");
  const today = spendToday();
  const month = Number(today.slice(5, 7));
  const cents = parseAmountToCents(amount);
  const parts = spendHeaderParts(month, rate, totalCents);
  const over = isOverBudget(totalCents);
  const handleSubmit = async () => {
    if (cents === null) return;
    const ok = await submit(cents, note);
    if (ok) {
      setAmount("");
      setNote("");
    }
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "spend-view", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "spend-head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: parts.prefix }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "span",
        {
          className: over ? "spend-head-spent spend-head-spent--over" : "spend-head-spent",
          children: parts.spent
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "spend-list", children: entries.map((entry) => /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { className: "spend-row", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "spend-time", children: spendTimeLabel(entry.createdAt, today) }),
      entry.reasonText !== "" && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "spend-note", children: entry.reasonText }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "spend-amount", children: `-${fmtMoney(entry.amountCents ?? 0)} 元` }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "spend-undo",
          disabled: undoingId === entry.id,
          onClick: () => void undo(entry.id),
          type: "button",
          children: "撤销"
        }
      )
    ] }, entry.id)) }),
    error !== null && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "spend-error", children: error }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "spend-form", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "spend-amount-input",
          inputMode: "decimal",
          maxLength: 7,
          onChange: (e) => setAmount(e.target.value),
          value: amount
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "spend-unit", children: "元" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          "aria-label": "备注",
          className: "spend-note-input",
          maxLength: 40,
          onChange: (e) => setNote(e.target.value),
          value: note
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          className: "spend-submit",
          disabled: cents === null || submitting,
          onClick: () => void handleSubmit(),
          type: "button",
          children: "记一笔"
        }
      )
    ] })
  ] });
}
const LEDGER_LIMIT = 200;
function usePointsData() {
  const [balance, setBalance] = reactExports.useState(0);
  const [today, setToday] = reactExports.useState(() => localDayOf(/* @__PURE__ */ new Date()));
  const [stats, setStats] = reactExports.useState([]);
  const [entries, setEntries] = reactExports.useState([]);
  const [range, setRange] = reactExports.useState("today");
  const reloadSummary = reactExports.useCallback(() => {
    const day = localDayOf(/* @__PURE__ */ new Date());
    setToday(day);
    const [year, month] = day.split("-").map(Number);
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    void Promise.all([
      window.api.points.balance(),
      window.api.points.monthStats({ year, month }),
      window.api.points.monthStats({ year: prevYear, month: prevMonth })
    ]).then(([balanceRes, currentRes, previousRes]) => {
      if (!balanceRes.ok) {
        console.error("[points] balance 失败", balanceRes.error);
        return;
      }
      if (!currentRes.ok || !previousRes.ok) {
        console.error("[points] monthStats 失败", currentRes, previousRes);
        return;
      }
      setBalance(balanceRes.data);
      setStats([...previousRes.data, ...currentRes.data]);
    }).catch((e) => console.error("[points] 汇总加载失败", e));
  }, []);
  const reloadLedger = reactExports.useCallback((target) => {
    const { from, to } = rangeOf(target, localDayOf(/* @__PURE__ */ new Date()));
    void window.api.points.ledger({ from, to, limit: LEDGER_LIMIT }).then((res) => {
      if (!res.ok) {
        console.error("[points] ledger 失败", res.error);
        return;
      }
      setEntries(res.data);
    }).catch((e) => console.error("[points] 明细加载失败", e));
  }, []);
  reactExports.useEffect(() => {
    reloadSummary();
  }, [reloadSummary]);
  reactExports.useEffect(() => {
    reloadLedger(range);
  }, [reloadLedger, range]);
  reactExports.useEffect(() => {
    const off = window.api.onEvent((e) => {
      if (e.type === "points.changed" || e.type === "daystats.changed") {
        reloadSummary();
        reloadLedger(range);
      }
    });
    return off;
  }, [reloadSummary, reloadLedger, range]);
  const todayPoints = reactExports.useMemo(() => stats.find((s) => s.day === today)?.points ?? 0, [stats, today]);
  const weekPoints = reactExports.useMemo(() => sumPoints(stats, weekStartOf(today), today), [stats, today]);
  const bars = reactExports.useMemo(() => barsOf(stats, today), [stats, today]);
  return { balance, today, todayPoints, weekPoints, bars, entries, range, setRange };
}
const RANGES = ["today", "week", "month"];
function PointsPanel() {
  const { balance, todayPoints, weekPoints, bars, entries, range, setRange } = usePointsData();
  const [view, setView] = reactExports.useState("list");
  const showRange = (target) => {
    setView("list");
    setRange(target);
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "points-panel", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "points-summary", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "points-head", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: balance < 0 ? "points-total points-total--neg" : "points-total", children: fmtPoints(balance) }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "points-deltas", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "points-delta-line", children: `${RANGE_LABEL.today} ${formatSigned(todayPoints)}` }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "points-delta-line", children: `${RANGE_LABEL.week} ${formatSigned(weekPoints)}` })
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { "aria-hidden": true, className: "points-bars", children: bars.map((bar) => /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "points-bar", style: { height: `${bar.ratio * 100}%` } }, bar.day)) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "points-ledger", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "points-tabs", children: [
        RANGES.map((item) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            "aria-pressed": view === "list" && item === range,
            className: view === "list" && item === range ? "points-tab points-tab--on" : "points-tab",
            onClick: () => showRange(item),
            type: "button",
            children: RANGE_LABEL[item]
          },
          item
        )),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            "aria-pressed": view === "ledger",
            className: view === "ledger" ? "points-tab points-tab--on" : "points-tab",
            onClick: () => setView("ledger"),
            type: "button",
            children: LEDGER_VIEW_LABEL
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            "aria-pressed": view === "spend",
            className: view === "spend" ? "points-tab points-tab--on" : "points-tab",
            onClick: () => setView("spend"),
            type: "button",
            children: SPEND_VIEW_LABEL
          }
        )
      ] }),
      view === "ledger" ? /* @__PURE__ */ jsxRuntimeExports.jsx(LedgerView, { onOpenTask: emitFocusTask }) : view === "spend" ? /* @__PURE__ */ jsxRuntimeExports.jsx(SpendView, {}) : /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "ledger-list", children: entries.map((entry) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "button",
        {
          className: entry.reversedAt === null ? "ledger-row" : "ledger-row ledger-row--reversed",
          onClick: () => {
            if (entry.taskId !== null) emitFocusTask(entry.taskId);
          },
          type: "button",
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ledger-time", children: timeLabel(entry.createdAt) }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ledger-text", children: entry.reasonText }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "span",
              {
                className: entry.delta < 0 ? "ledger-delta ledger-delta--neg" : "ledger-delta",
                children: formatSigned(entry.delta)
              }
            )
          ]
        }
      ) }, entry.id)) })
    ] })
  ] });
}
function comparePlanRows(a, b) {
  if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
function groupByPlanDay(tasks) {
  const picked = tasks.filter((t) => t.plannedDay !== null && t.parentId === null);
  const byDay = /* @__PURE__ */ new Map();
  for (const task of picked) {
    const day = task.plannedDay;
    const bucket = byDay.get(day);
    if (bucket === void 0) byDay.set(day, [task]);
    else bucket.push(task);
  }
  return [...byDay.entries()].sort((a, b) => a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1).map(([day, list]) => ({ day, tasks: [...list].sort(comparePlanRows) }));
}
const PLAN_STATUS = [
  "todo",
  "doing",
  "pending_review",
  "reviewing",
  "done",
  "missed"
];
function usePlanData() {
  const [tasks, setTasks] = reactExports.useState([]);
  reactExports.useEffect(() => {
    let alive = true;
    const load = () => {
      void window.api.task.list({ status: PLAN_STATUS }).then((res) => {
        if (!alive) return;
        if (!res.ok) {
          console.error("[plan] task.list 失败", res.error);
          return;
        }
        setTasks(res.data);
      }).catch((e) => {
        if (alive) console.error("[plan] task.list 调用失败", e);
      });
    };
    load();
    const off = window.api.onEvent((event) => {
      if (event.type.startsWith("task.")) load();
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return { tasks };
}
function isDone(task) {
  return task.status === "done" || task.status === "missed";
}
function PlanView() {
  const { tasks } = usePlanData();
  const groups = groupByPlanDay(tasks);
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "plan-panel", children: groups.map((g) => /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "plan-day", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "plan-day-head", children: floorTitle(g.day) }),
    g.tasks.map((t) => /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: isDone(t) ? "plan-row plan-row--done" : "plan-row", children: t.title }, t.id))
  ] }, g.day)) });
}
const DEFAULT_SPLIT = 0.71;
const MIN_TOP_PX = 160;
const MIN_BOTTOM_PX = 360;
const SPLIT_STORAGE_KEY = "taskloop.rightSplit";
function clampBottomPx(bottomPx, containerHeight) {
  const maxBottom = Math.max(containerHeight - MIN_TOP_PX, 0);
  const minBottom = Math.min(MIN_BOTTOM_PX, maxBottom);
  return Math.min(Math.max(bottomPx, minBottom), maxBottom);
}
function ratioFromY(y, rect) {
  if (rect.height <= 0) return DEFAULT_SPLIT;
  const bottomPx = clampBottomPx(rect.top + rect.height - y, rect.height);
  return bottomPx / rect.height;
}
function parseSplit(raw) {
  if (raw === null) return DEFAULT_SPLIT;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return DEFAULT_SPLIT;
  return n;
}
function serializeSplit(ratio) {
  return String(ratio);
}
function RightSplit({ ratio, onChange, onCommit }) {
  const dragging = reactExports.useRef(false);
  const latest = reactExports.useRef(ratio);
  const report = reactExports.useCallback(
    (r) => {
      latest.current = r;
      onChange(r);
    },
    [onChange]
  );
  const handlePointerDown = reactExports.useCallback((e) => {
    const container2 = e.currentTarget.parentElement;
    if (!container2) return;
    dragging.current = true;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const handlePointerMove = reactExports.useCallback(
    (e) => {
      if (!dragging.current) return;
      const container2 = e.currentTarget.parentElement;
      if (!container2) return;
      const rect = container2.getBoundingClientRect();
      const band = e.currentTarget.offsetHeight;
      report(ratioFromY(e.clientY, { top: rect.top + band, height: rect.height - band }));
    },
    [report]
  );
  const handlePointerUp = reactExports.useCallback(
    (e) => {
      if (!dragging.current) return;
      dragging.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
      onCommit(latest.current);
    },
    [onCommit]
  );
  const handleLostCapture = reactExports.useCallback(() => {
    dragging.current = false;
  }, []);
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "div",
    {
      className: "right-split",
      role: "separator",
      "aria-orientation": "horizontal",
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onLostPointerCapture: handleLostCapture
    }
  );
}
const HEADER_HEIGHT = 56;
const headerStyle = {
  display: "flex",
  flex: `0 0 ${HEADER_HEIGHT}px`,
  alignItems: "center",
  justifyContent: "space-between",
  height: HEADER_HEIGHT,
  boxSizing: "border-box",
  padding: "0 16px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font)",
  fontSize: 14
};
const rightGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: 12
};
const settingsButtonStyle = {
  padding: "4px 10px",
  border: "none",
  borderRadius: "var(--r-sm)",
  background: "transparent",
  color: "var(--text-sub)",
  fontFamily: "var(--font)",
  fontSize: 13,
  cursor: "pointer"
};
function AppHeader({ onOpenSettings, planOpen, onTogglePlan }) {
  const [visible, setVisible] = reactExports.useState(null);
  const [settingsHover, setSettingsHover] = reactExports.useState(false);
  reactExports.useEffect(() => {
    let alive = true;
    void window.api.hud.getState().then((res) => {
      if (!alive) return;
      if (!res.ok) {
        console.error("[header] hud.getState 失败", res.error);
        return;
      }
      setVisible(res.data.visible);
    }).catch((e) => console.error("[header] hud.getState 调用失败", e));
    return () => {
      alive = false;
    };
  }, []);
  const on = visible !== false;
  reactExports.useEffect(() => {
    const off = window.api.onEvent((event) => {
      if (event.type === "hud.visible.changed") setVisible(event.visible);
    });
    return off;
  }, []);
  const toggle = () => {
    const next = !on;
    setVisible(next);
    void window.api.hud.setVisible({ visible: next }).then((res) => {
      if (!res.ok) {
        console.error("[header] hud.setVisible 失败", res.error);
        setVisible(!next);
      }
    }).catch((e) => {
      console.error("[header] hud.setVisible 调用失败", e);
      setVisible(!next);
    });
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { style: headerStyle, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "taskloop" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: rightGroupStyle, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          role: "switch",
          "aria-checked": on,
          "aria-label": "悬浮条开关",
          onClick: toggle,
          style: {
            position: "relative",
            width: 36,
            height: 20,
            padding: 0,
            border: "none",
            borderRadius: 10,
            background: on ? "var(--accent)" : "var(--border)",
            cursor: "pointer",
            transition: "background 150ms"
          },
          children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            "span",
            {
              style: {
                position: "absolute",
                top: 2,
                left: on ? 18 : 2,
                width: 16,
                height: 16,
                borderRadius: 8,
                background: "#ffffff",
                transition: "left 150ms"
              }
            }
          )
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          onClick: onTogglePlan,
          style: planOpen ? { ...settingsButtonStyle, color: "var(--text)" } : settingsButtonStyle,
          children: "计划"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          onClick: onOpenSettings,
          onMouseEnter: () => setSettingsHover(true),
          onMouseLeave: () => setSettingsHover(false),
          style: settingsHover ? { ...settingsButtonStyle, background: "var(--bg-hover)", color: "var(--text)" } : settingsButtonStyle,
          children: "设置"
        }
      )
    ] })
  ] });
}
const MEMORY_MAX_CHARS = 120;
const TONE_ORDER = ["warm", "plain", "playful"];
const KIND_ORDER = ["profile", "preference", "fact"];
const TONE_LABEL = {
  warm: "温柔",
  plain: "直率",
  playful: "活泼"
};
const KIND_LABEL = {
  profile: "身份",
  preference: "偏好",
  fact: "事实"
};
const SOURCE_LABEL = {
  auto: "自动",
  manual: "手动"
};
function toPersonaForm(persona) {
  return {
    name: persona.name,
    userCall: persona.userCall,
    personaMd: persona.personaMd,
    tone: persona.tone
  };
}
function diffPersona(form, saved) {
  const patch = {};
  if (form.name !== saved.name) patch.name = form.name;
  if (form.userCall !== saved.userCall) patch.userCall = form.userCall;
  if (form.personaMd !== saved.personaMd) patch.personaMd = form.personaMd;
  if (form.tone !== saved.tone) patch.tone = form.tone;
  return Object.keys(patch).length === 0 ? null : patch;
}
function canAddMemory(raw) {
  const chars = Array.from(raw.trim()).length;
  return chars >= 1 && chars <= MEMORY_MAX_CHARS;
}
const AI_VENDORS = ["zhipu", "deepseek"];
const AI_VENDOR_PRESETS = {
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    task: "glm-5.3-flash",
    chat: "glm-4.7-flashx"
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    task: "deepseek-flash",
    chat: "deepseek-flash"
  }
};
function vendorOf(baseUrl) {
  const s = baseUrl.trim().toLowerCase().replace(/\/+$/, "");
  if (s === "") return null;
  if (s.includes("open.bigmodel.cn")) return "zhipu";
  if (s.includes("api.deepseek.com")) return "deepseek";
  return null;
}
const EMPTY_FORM = { name: "", userCall: "", personaMd: "", tone: "warm" };
const NOTICE_MS = 1200;
const UPDATE_NOTE_MS = 2600;
const UPDATE_BUTTON_MS = 2e3;
const EMPTY_UPDATE = {
  version: "",
  latest: null,
  hasUpdate: false,
  checking: false,
  note: null,
  buttonNote: null
};
function useSettingsData() {
  const [form, setForm] = reactExports.useState(EMPTY_FORM);
  const [saved, setSaved] = reactExports.useState(null);
  const [memories, setMemories] = reactExports.useState([]);
  const [models, setModels] = reactExports.useState({ task: "", chat: "", baseUrl: "" });
  const [configured, setConfigured] = reactExports.useState(null);
  const [keySaving, setKeySaving] = reactExports.useState(false);
  const [aiSaving, setAiSaving] = reactExports.useState(false);
  const [saving, setSaving] = reactExports.useState(false);
  const [busyId, setBusyId] = reactExports.useState(null);
  const [personaError, setPersonaError] = reactExports.useState(null);
  const [memoryError, setMemoryError] = reactExports.useState(null);
  const [aiError, setAiError] = reactExports.useState(null);
  const [notice, setNotice] = reactExports.useState(false);
  const [update, setUpdate] = reactExports.useState(EMPTY_UPDATE);
  const mounted = reactExports.useRef(true);
  const noticeTimer = reactExports.useRef(null);
  const updateNoteTimer = reactExports.useRef(null);
  const buttonNoteTimer = reactExports.useRef(null);
  reactExports.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  reactExports.useEffect(
    () => () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
      if (updateNoteTimer.current !== null) clearTimeout(updateNoteTimer.current);
      if (buttonNoteTimer.current !== null) clearTimeout(buttonNoteTimer.current);
    },
    []
  );
  const flashNotice = reactExports.useCallback(() => {
    setNotice(true);
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null;
      if (mounted.current) setNotice(false);
    }, NOTICE_MS);
  }, []);
  const flashUpdateNote = reactExports.useCallback((note) => {
    setUpdate((prev) => ({ ...prev, note }));
    if (updateNoteTimer.current !== null) clearTimeout(updateNoteTimer.current);
    updateNoteTimer.current = setTimeout(() => {
      updateNoteTimer.current = null;
      if (mounted.current) setUpdate((prev) => ({ ...prev, note: null }));
    }, UPDATE_NOTE_MS);
  }, []);
  const refreshUpdate = reactExports.useCallback(async () => {
    if (buttonNoteTimer.current !== null) {
      clearTimeout(buttonNoteTimer.current);
      buttonNoteTimer.current = null;
    }
    setUpdate((prev) => ({ ...prev, checking: true, buttonNote: null }));
    try {
      const res = await window.api.app.checkUpdate();
      if (!mounted.current) return;
      if (!res.ok) {
        setUpdate((prev) => ({ ...prev, checking: false }));
        flashUpdateNote(res.error.message);
        return;
      }
      setUpdate((prev) => ({
        ...prev,
        version: res.data.current,
        latest: res.data.latest,
        hasUpdate: res.data.hasUpdate,
        checking: false,
        buttonNote: res.data.hasUpdate ? "正在更新" : "已是最新"
      }));
      buttonNoteTimer.current = setTimeout(() => {
        buttonNoteTimer.current = null;
        if (mounted.current) setUpdate((prev) => ({ ...prev, buttonNote: null }));
      }, UPDATE_BUTTON_MS);
    } catch (e) {
      console.error("[settings] app.checkUpdate 调用失败", e);
      if (!mounted.current) return;
      setUpdate((prev) => ({ ...prev, checking: false }));
      flashUpdateNote(e instanceof Error ? e.message : String(e));
    }
  }, [flashUpdateNote]);
  reactExports.useEffect(() => {
    void Promise.all([
      window.api.persona.get(),
      window.api.memory.list({}),
      window.api.ai.keyStatus(),
      window.api.app.getBootstrap()
    ]).then(([personaRes, memoryRes, keyRes, bootstrapRes]) => {
      if (!mounted.current) return;
      if (personaRes.ok) {
        const next = toPersonaForm(personaRes.data);
        setForm(next);
        setSaved(next);
      } else {
        setPersonaError(personaRes.error.message);
      }
      if (memoryRes.ok) setMemories(memoryRes.data);
      else setMemoryError(memoryRes.error.message);
      if (keyRes.ok) setConfigured(keyRes.data.configured);
      else setAiError((prev) => prev ?? keyRes.error.message);
      if (bootstrapRes.ok) {
        setModels({
          task: bootstrapRes.data.settings["ai.provider"].model,
          chat: bootstrapRes.data.settings["ai.chat.model"],
          baseUrl: bootstrapRes.data.settings["ai.baseUrl"]
        });
      } else {
        setAiError((prev) => prev ?? bootstrapRes.error.message);
      }
    }).catch((e) => console.error("[settings] 打开时拉数据失败", e));
  }, []);
  reactExports.useEffect(() => {
    void refreshUpdate();
  }, [refreshUpdate]);
  const dirty = saved !== null && diffPersona(form, saved) !== null;
  const setField = reactExports.useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);
  const save = reactExports.useCallback(() => {
    const patch = saved === null ? null : diffPersona(form, saved);
    if (patch === null || saving) return;
    setSaving(true);
    setPersonaError(null);
    void window.api.persona.update(patch).then((res) => {
      if (!mounted.current) return;
      if (!res.ok) {
        setPersonaError(res.error.message);
        return;
      }
      const next = toPersonaForm(res.data);
      setForm(next);
      setSaved(next);
      flashNotice();
    }).catch((e) => {
      console.error("[settings] persona.update 调用失败", e);
      if (mounted.current) setPersonaError(e instanceof Error ? e.message : String(e));
    }).finally(() => {
      if (mounted.current) setSaving(false);
    });
  }, [form, saved, saving, flashNotice]);
  const updateMemory = reactExports.useCallback(async (id, contentMd) => {
    setMemoryError(null);
    try {
      const res = await window.api.memory.update({ id, contentMd });
      if (!mounted.current) return false;
      if (!res.ok) {
        setMemoryError(res.error.message);
        return false;
      }
      const next = res.data;
      setMemories((prev) => prev.map((m) => m.id === next.id ? next : m));
      return true;
    } catch (e) {
      console.error("[settings] memory.update 调用失败", e);
      if (mounted.current) setMemoryError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);
  const removeMemory = reactExports.useCallback((id) => {
    setMemoryError(null);
    setBusyId(id);
    void window.api.memory.remove({ id }).then((res) => {
      if (!mounted.current) return;
      if (!res.ok) {
        setMemoryError(res.error.message);
        return;
      }
      setMemories((prev) => prev.filter((m) => m.id !== id));
    }).catch((e) => {
      console.error("[settings] memory.remove 调用失败", e);
      if (mounted.current) setMemoryError(e instanceof Error ? e.message : String(e));
    }).finally(() => {
      if (mounted.current) setBusyId(null);
    });
  }, []);
  const addMemory = reactExports.useCallback(async (contentMd, kind) => {
    setMemoryError(null);
    try {
      const res = await window.api.memory.add({ contentMd, kind });
      if (!mounted.current) return false;
      if (!res.ok) {
        setMemoryError(res.error.message);
        return false;
      }
      const created = res.data;
      setMemories((prev) => prev.some((m) => m.id === created.id) ? prev : [created, ...prev]);
      return true;
    } catch (e) {
      console.error("[settings] memory.add 调用失败", e);
      if (mounted.current) setMemoryError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);
  const saveKey = reactExports.useCallback(async (key) => {
    setAiError(null);
    setKeySaving(true);
    try {
      const res = await window.api.ai.setKey(key);
      if (!mounted.current) return false;
      if (!res.ok) {
        setAiError(res.error.message);
        return false;
      }
      setConfigured(res.data.configured);
      return true;
    } catch (e) {
      console.error("[settings] ai.setKey 调用失败", e);
      if (mounted.current) setAiError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (mounted.current) setKeySaving(false);
    }
  }, []);
  const saveAiConfig = reactExports.useCallback(
    async (next) => {
      setAiError(null);
      setAiSaving(true);
      try {
        if (next.baseUrl !== models.baseUrl) {
          const res = await window.api.app.setSetting({ key: "ai.baseUrl", value: next.baseUrl });
          if (!mounted.current) return false;
          if (!res.ok) {
            setAiError(res.error.message);
            return false;
          }
        }
        if (next.task !== models.task) {
          const res = await window.api.app.setSetting({
            key: "ai.provider",
            value: { name: "zhipu", model: next.task }
          });
          if (!mounted.current) return false;
          if (!res.ok) {
            setAiError(res.error.message);
            return false;
          }
        }
        if (next.chat !== models.chat) {
          const res = await window.api.app.setSetting({
            key: "ai.chat.model",
            value: next.chat
          });
          if (!mounted.current) return false;
          if (!res.ok) {
            setAiError(res.error.message);
            return false;
          }
        }
        if (!mounted.current) return false;
        setModels(next);
        flashNotice();
        return true;
      } catch (e) {
        console.error("[settings] app.setSetting 调用失败", e);
        if (mounted.current) setAiError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        if (mounted.current) setAiSaving(false);
      }
    },
    [models, flashNotice]
  );
  const quit = reactExports.useCallback(() => {
    void window.api.app.quit().catch((e) => {
      console.error("[settings] app.quit 调用失败", e);
    });
  }, []);
  return reactExports.useMemo(
    () => ({
      form,
      saved,
      memories,
      models,
      configured,
      keySaving,
      aiSaving,
      saving,
      busyId,
      personaError,
      memoryError,
      aiError,
      notice,
      update,
      dirty,
      canSave: dirty && !saving,
      setField,
      save,
      updateMemory,
      removeMemory,
      addMemory,
      saveKey,
      saveAiConfig,
      refreshUpdate,
      quit
    }),
    [
      form,
      saved,
      memories,
      models,
      configured,
      keySaving,
      aiSaving,
      saving,
      busyId,
      personaError,
      memoryError,
      aiError,
      notice,
      update,
      dirty,
      setField,
      save,
      updateMemory,
      removeMemory,
      addMemory,
      saveKey,
      saveAiConfig,
      refreshUpdate,
      quit
    ]
  );
}
function SettingsDrawer({ onClose }) {
  const data = useSettingsData();
  const panelRef = reactExports.useRef(null);
  reactExports.useEffect(() => {
    panelRef.current?.focus();
  }, []);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-mask", onClick: onClose }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "div",
      {
        className: "settings-drawer",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "设置",
        tabIndex: -1,
        ref: panelRef,
        onKeyDown: (event) => {
          if (event.key === "Escape") onClose();
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-head", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-title", children: "设置" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "settings-close", "aria-label": "关闭", onClick: onClose, children: "×" })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-body", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(PersonaBlock, { data }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(MemoryBlock, { data }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(AiBlock, { data }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("section", { className: "settings-block", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-kv", children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-kv-key", children: "版本" }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "settings-kv-value", children: [
                "v",
                data.update.version
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                "button",
                {
                  type: "button",
                  className: "settings-add",
                  disabled: data.update.checking,
                  onClick: () => void data.refreshUpdate(),
                  children: data.update.checking ? "检查中…" : data.update.buttonNote !== null ? data.update.buttonNote : "检查更新"
                }
              ),
              data.update.note !== null && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-notice", children: data.update.note })
            ] }) }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("section", { className: "settings-block settings-quit-block", children: /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "settings-quit", onClick: data.quit, children: "退出程序" }) })
          ] })
        ]
      }
    )
  ] });
}
function PersonaBlock({ data }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "settings-block", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { className: "settings-block-title", children: "人物卡" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "settings-field", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-label", children: "名字" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "settings-input",
          maxLength: 20,
          value: data.form.name,
          onChange: (event) => data.setField("name", event.target.value)
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "settings-field", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-label", children: "怎么称呼我" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "settings-input",
          maxLength: 20,
          value: data.form.userCall,
          onChange: (event) => data.setField("userCall", event.target.value)
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { className: "settings-field", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-label", children: "人设" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "textarea",
        {
          className: "settings-textarea",
          rows: 5,
          maxLength: 800,
          value: data.form.personaMd,
          onChange: (event) => data.setField("personaMd", event.target.value)
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-field", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-label", children: "语气" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-tones", children: TONE_ORDER.map((tone) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          className: "settings-tone",
          "aria-pressed": data.form.tone === tone,
          onClick: () => data.setField("tone", tone),
          children: TONE_LABEL[tone]
        },
        tone
      )) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-save-row", children: [
      data.personaError !== null && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-error", children: data.personaError }),
      data.notice && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-notice", children: "已保存" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          className: "settings-save",
          disabled: !data.canSave,
          onClick: data.save,
          children: "保存"
        }
      )
    ] })
  ] });
}
function MemoryBlock({ data }) {
  const [editingId, setEditingId] = reactExports.useState(null);
  const [draft2, setDraft] = reactExports.useState("");
  const [addText, setAddText] = reactExports.useState("");
  const [addKind, setAddKind] = reactExports.useState("profile");
  const closing = reactExports.useRef(false);
  const editIdRef = reactExports.useRef(null);
  const focusEnd = reactExports.useCallback((node) => {
    if (node === null) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);
  const endEdit = reactExports.useCallback(() => {
    closing.current = true;
    editIdRef.current = null;
    setEditingId(null);
    setDraft("");
  }, []);
  const beginEdit = reactExports.useCallback((memory) => {
    closing.current = false;
    editIdRef.current = memory.id;
    setDraft(memory.contentMd);
    setEditingId(memory.id);
  }, []);
  const commitEdit = reactExports.useCallback(
    (memory) => {
      if (closing.current) return;
      const text = draft2.trim();
      if (text === "" || text === memory.contentMd) {
        endEdit();
        return;
      }
      closing.current = true;
      void data.updateMemory(memory.id, text).then((ok) => {
        if (ok) {
          if (editIdRef.current === memory.id) endEdit();
          return;
        }
        closing.current = false;
      });
    },
    [draft2, data, endEdit]
  );
  const submitAdd = reactExports.useCallback(() => {
    if (!canAddMemory(addText)) return;
    void data.addMemory(addText, addKind).then((ok) => {
      if (ok) setAddText("");
    });
  }, [addText, addKind, data]);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "settings-block", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { className: "settings-block-title", children: "记忆" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-memories", children: data.memories.map((memory) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-memory-row", children: [
      editingId === memory.id ? /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "settings-memory-input",
          maxLength: 120,
          value: draft2,
          ref: focusEnd,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitEdit(memory);
            } else if (event.key === "Escape") {
              event.stopPropagation();
              endEdit();
            }
          },
          onBlur: () => {
            if (closing.current) {
              closing.current = false;
              return;
            }
            commitEdit(memory);
          }
        }
      ) : /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          className: "settings-memory-text",
          onClick: () => beginEdit(memory),
          children: memory.contentMd
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "settings-badge", children: [
        KIND_LABEL[memory.kind],
        " · ",
        SOURCE_LABEL[memory.source]
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          className: "settings-del",
          disabled: data.busyId === memory.id,
          onClick: () => data.removeMemory(memory.id),
          children: "删除"
        }
      )
    ] }, memory.id)) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-add-row", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "settings-input",
          maxLength: 120,
          "aria-label": "新的记忆",
          value: addText,
          onChange: (event) => setAddText(event.target.value)
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "select",
        {
          className: "settings-select",
          "aria-label": "记忆类型",
          value: addKind,
          onChange: (event) => setAddKind(event.target.value),
          children: KIND_ORDER.map((kind) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: kind, children: KIND_LABEL[kind] }, kind))
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          className: "settings-add",
          disabled: !canAddMemory(addText),
          onClick: submitAdd,
          children: "添加"
        }
      )
    ] }),
    data.memoryError !== null && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-error settings-error--block", children: data.memoryError })
  ] });
}
function AiBlock({ data }) {
  const [keyDraft, setKeyDraft] = reactExports.useState("");
  const [draft2, setDraft] = reactExports.useState(data.models);
  const modelsRef = reactExports.useRef(data.models);
  reactExports.useEffect(() => {
    modelsRef.current = data.models;
    setDraft(data.models);
  }, [data.models]);
  const dirty = draft2.task !== data.models.task || draft2.chat !== data.models.chat || draft2.baseUrl !== data.models.baseUrl;
  let keyText = "";
  if (data.configured !== null) keyText = data.configured ? "已配置" : "未配置";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "settings-block", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { className: "settings-block-title", children: "AI" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-kv", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-kv-key", children: "接口" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-vendor-row", children: AI_VENDORS.map((v) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          className: vendorOf(draft2.baseUrl) === v ? "settings-vendor settings-vendor--on" : "settings-vendor",
          onClick: () => setDraft(AI_VENDOR_PRESETS[v]),
          children: v === "zhipu" ? "智谱" : "DeepSeek"
        },
        v
      )) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-kv", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-kv-key", children: "任务模型" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "settings-input",
          type: "text",
          autoComplete: "off",
          spellCheck: false,
          value: draft2.task,
          onChange: (event) => setDraft((prev) => ({ ...prev, task: event.target.value }))
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-kv", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-kv-key", children: "聊天模型" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "settings-input",
          type: "text",
          autoComplete: "off",
          spellCheck: false,
          value: draft2.chat,
          onChange: (event) => setDraft((prev) => ({ ...prev, chat: event.target.value }))
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-kv", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-kv-key", children: "接口地址" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "settings-input",
          type: "text",
          autoComplete: "off",
          spellCheck: false,
          value: draft2.baseUrl,
          onChange: (event) => setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))
        }
      )
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-save-row", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      "button",
      {
        type: "button",
        className: "settings-save",
        disabled: !dirty || data.aiSaving,
        onClick: () => {
          void data.saveAiConfig(draft2).then((ok) => {
            if (ok) setDraft(modelsRef.current);
          });
        },
        children: "保存"
      }
    ) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-kv", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-kv-key", children: "API Key" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "settings-kv-value", children: keyText })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "settings-add-row", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          className: "settings-input",
          type: "password",
          autoComplete: "off",
          spellCheck: false,
          value: keyDraft,
          onChange: (e) => setKeyDraft(e.target.value)
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          className: "settings-add",
          disabled: keyDraft.trim().length === 0 || data.keySaving,
          onClick: () => {
            void data.saveKey(keyDraft).then((ok) => {
              if (ok) setKeyDraft("");
            });
          },
          children: "保存"
        }
      )
    ] }),
    data.aiError !== null && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "settings-error settings-error--block", children: data.aiError })
  ] });
}
const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());
function App() {
  const [dayDetail, setDayDetail] = reactExports.useState(null);
  const [planOpen, setPlanOpen] = reactExports.useState(false);
  const [settingsOpen, setSettingsOpen] = reactExports.useState(false);
  const [ratio, setRatio] = reactExports.useState(
    () => parseSplit(window.localStorage.getItem(SPLIT_STORAGE_KEY))
  );
  const toggleDay = reactExports.useCallback((day) => {
    setPlanOpen(false);
    setDayDetail((prev) => prev === day ? null : day);
  }, []);
  const togglePlan = reactExports.useCallback(() => {
    setDayDetail(null);
    setPlanOpen((v) => !v);
  }, []);
  const commitSplit = reactExports.useCallback((r) => {
    window.localStorage.setItem(SPLIT_STORAGE_KEY, serializeSplit(r));
  }, []);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", flexDirection: "column", height: "100%" }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      AppHeader,
      {
        planOpen,
        onTogglePlan: togglePlan,
        onOpenSettings: () => setSettingsOpen(true)
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "app-shell", style: { flex: "1 1 auto", minHeight: 0, height: "auto" }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(ChatPanel, {}),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { className: "right-col", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "right-half", style: { flexGrow: 1 - ratio }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(TasksPanel, {}) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(RightSplit, { ratio, onChange: setRatio, onCommit: commitSplit }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "right-half", style: { flexGrow: ratio }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(CalendarPanel, { selectedDay: dayDetail, onSelectDay: toggleDay }),
          planOpen ? /* @__PURE__ */ jsxRuntimeExports.jsx(PlanView, {}) : dayDetail ? /* @__PURE__ */ jsxRuntimeExports.jsx(CalendarDayView, { day: dayDetail }) : /* @__PURE__ */ jsxRuntimeExports.jsx(PointsPanel, {})
        ] })
      ] })
    ] }),
    settingsOpen && /* @__PURE__ */ jsxRuntimeExports.jsx(SettingsDrawer, { onClose: () => setSettingsOpen(false) })
  ] });
}
createRoot(container).render(
  /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.StrictMode, { children: /* @__PURE__ */ jsxRuntimeExports.jsx(App, {}) })
);
console.log(`[renderer:main] RUBRIC_VERSION=${RUBRIC_VERSION}`);
