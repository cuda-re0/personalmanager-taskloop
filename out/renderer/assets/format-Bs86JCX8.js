const RUBRIC_VERSION = "v0.9";
const DEFAULT_CONFIG = {
  difficultyBase: { trivial: 5, easy: 10, medium: 20, hard: 35, epic: 50 },
  deadlineBase: { easy: 2, medium: 3, hard: 5 },
  dailyBase: 1,
  streakBonus: [
    { days: 7, bonus: 5 },
    { days: 30, bonus: 10 }
  ],
  dailyCap: null
};
const QUALITY_FACTOR = {
  partial: 0.6,
  met: 1,
  exceeded: 1.15
};
function efficiencyFactor(leadHours) {
  if (leadHours === null) return 1;
  if (leadHours < 24) return 1;
  if (leadHours < 72) return 1.1;
  return 1.2;
}
function resultFactor(result) {
  if (result === "exceeded") return 1.2;
  if (result === "below") return 1;
  return 1;
}
function roundPoints(v) {
  return Math.round(v * 100) / 100;
}
function computePlannedPoints(type, difficulty, cfg = DEFAULT_CONFIG) {
  const base = type === "deadline" ? cfg.deadlineBase?.[difficulty] ?? cfg.difficultyBase[difficulty] : cfg.difficultyBase[difficulty];
  return clamp(roundPoints(base), 1, 100);
}
function computeAwardedPoints(input) {
  const { type, planned, quality, overdueDays } = input;
  const q = type === "event" ? 1 : QUALITY_FACTOR[quality];
  const typeCoeff = type === "deadline" ? efficiencyFactor(input.leadHours ?? null) : type === "event" ? resultFactor(input.result ?? null) : 1;
  const penalty = type === "deadline" ? Math.min(overdueDays * 2, 20) : 0;
  return clamp(roundPoints(planned * q * typeCoeff - penalty), 1, roundPoints(planned * 1.4));
}
function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}
const dayFormatters = /* @__PURE__ */ new Map();
function dayFormatter(timeZone) {
  const key = "";
  let f = dayFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    dayFormatters.set(key, f);
  }
  return f;
}
function partOf(parts, type) {
  for (const p of parts) if (p.type === type) return p.value;
  return "";
}
function toLocalDay(d, timeZone) {
  const parts = dayFormatter(timeZone).formatToParts(d);
  return `${partOf(parts, "year")}-${partOf(parts, "month")}-${partOf(parts, "day")}`;
}
const MINUTE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}/;
const DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_SHAPE = /^(\d{4})-(\d{2})$/;
function isMonthNumber(month) {
  return Number.isInteger(month) && month >= 1 && month <= 12;
}
function daysInMonth(year, month) {
  if (!isMonthNumber(month)) return 0;
  return new Date(year, month, 0).getDate();
}
function isCalendarDay(year, month, day) {
  if (!isMonthNumber(month)) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= daysInMonth(year, month);
}
function duePrecisionOf(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const minute = MINUTE_SHAPE.exec(raw);
  if (minute) {
    if (!isCalendarDay(Number(minute[1]), Number(minute[2]), Number(minute[3]))) return null;
    return Number.isNaN(new Date(raw).getTime()) ? null : "minute";
  }
  const day = DAY_SHAPE.exec(raw);
  if (day) return isCalendarDay(Number(day[1]), Number(day[2]), Number(day[3])) ? "day" : null;
  const month = MONTH_SHAPE.exec(raw);
  if (month) return isMonthNumber(Number(month[2])) ? "month" : null;
  return null;
}
function dueInstant(raw) {
  const precision = duePrecisionOf(raw);
  if (precision === null) return null;
  const value = raw;
  if (precision === "minute") {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  const [year, month, day] = value.split("-").map(Number);
  if (precision === "day") return new Date(year, month - 1, day, 23, 59, 59, 999);
  return new Date(year, month, 0, 23, 59, 59, 999);
}
function dueLocalDay(raw, timeZone) {
  const precision = duePrecisionOf(raw);
  if (precision === null) return null;
  const value = raw;
  if (precision === "day") return value.slice(0, 10);
  if (precision === "month") {
    const [year, month] = value.split("-").map(Number);
    return `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
  }
  return toLocalDay(new Date(value), timeZone);
}
function dueHasTime(raw) {
  return duePrecisionOf(raw) === "minute";
}
function fmtPoints(v) {
  return String(roundPoints(v));
}
function fmtMoney(cents) {
  const total = cents < 0 ? -Math.trunc(cents) : Math.trunc(cents);
  const yuan = (total - total % 100) / 100;
  const fen = total % 100;
  if (fen === 0) return String(yuan);
  if (fen % 10 === 0) return `${yuan}.${fen / 10}`;
  return `${yuan}.${String(fen).padStart(2, "0")}`;
}
function fmtRemaining(dueAt, type, now) {
  if (type !== "deadline" && type !== "event") return "";
  if (!dueAt) return "";
  const due = dueInstant(dueAt);
  if (due === null) return "";
  const diffHours = (due.getTime() - now.getTime()) / 36e5;
  if (diffHours < 0) return "逾期";
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = type === "deadline" && toLocalDay(due) === toLocalDay(tomorrow);
  if (dueHasTime(dueAt)) {
    if (diffHours < 24) return `${Math.max(1, Math.floor(diffHours))}h`;
    if (isTomorrow) return "明天";
    return `${Math.floor(diffHours / 24)}d`;
  }
  if (isTomorrow) return "明天";
  return `${Math.max(1, Math.ceil(diffHours / 24))}d`;
}
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}
function fmtDueLabel(dueAt) {
  const precision = duePrecisionOf(dueAt);
  if (precision === null) return "";
  const at = dueInstant(dueAt);
  if (at === null) return "";
  if (precision === "month") return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}`;
  const head = `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  return precision === "minute" ? `${head} ${pad2(at.getHours())}:${pad2(at.getMinutes())}` : head;
}
function toDatetimeLocal(dueAt) {
  const at = dueInstant(dueAt);
  if (at === null) return "";
  const day = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  return `${day}T${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
}
export {
  DEFAULT_CONFIG as D,
  RUBRIC_VERSION as R,
  dueInstant as a,
  duePrecisionOf as b,
  computePlannedPoints as c,
  dueLocalDay as d,
  computeAwardedPoints as e,
  fmtPoints as f,
  toDatetimeLocal as g,
  fmtDueLabel as h,
  fmtRemaining as i,
  fmtMoney as j,
  toLocalDay as t
};
