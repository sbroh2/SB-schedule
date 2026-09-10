/* =========================================================================
   utils.js — pure helpers (no DOM state, no app logic)
   ========================================================================= */
(function () {
  "use strict";

  window.TP = window.TP || {};

  var WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

  function pad(n) { return String(n).padStart(2, "0"); }

  function uid() {
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /* ---- dates ---- */
  function dateKey(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function parseKey(key) {
    var parts = String(key).split("-").map(Number);
    return new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  }

  function isKey(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v || ""); }

  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

  function addDays(d, n) {
    var c = new Date(d.getTime());
    c.setDate(c.getDate() + n);
    return c;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }

  function formatDateKorean(d) {
    d = d || new Date();
    return d.getFullYear() + "년 " + (d.getMonth() + 1) + "월 " + d.getDate() + "일 " +
      WEEKDAYS[d.getDay()] + "요일";
  }

  function formatDateShort(key) {
    var d = parseKey(key);
    return (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + WEEKDAYS[d.getDay()] + ")";
  }

  function formatClock(d, withSeconds) {
    d = d || new Date();
    var h = d.getHours();
    var ampm = h < 12 ? "오전" : "오후";
    h = h % 12 || 12;
    var s = ampm + " " + h + ":" + pad(d.getMinutes());
    return withSeconds ? s + ":" + pad(d.getSeconds()) : s;
  }

  function greeting(d) {
    var h = (d || new Date()).getHours();
    if (h < 5) return "늦은 밤이에요, 무리하지 마세요 🌙";
    if (h < 12) return "좋은 아침이에요! 👋";
    if (h < 17) return "활기찬 오후예요 ☀️";
    if (h < 21) return "수고한 저녁이에요 🌆";
    return "하루를 마무리할 시간이에요 🌙";
  }

  /* ---- time strings "HH:MM" ---- */
  function isHHMM(v) { return /^\d{1,2}:\d{2}$/.test(v || ""); }

  function toMinutes(hhmm) {
    if (!isHHMM(hhmm)) return null;
    var p = hhmm.split(":").map(Number);
    return p[0] * 60 + p[1];
  }

  function nowMinutes(d) {
    d = d || new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  /* ---- misc ---- */
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function pct(part, total) {
    if (!total) return 0;
    return Math.round((part / total) * 100);
  }

  function debounce(fn, wait) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* Tiny hyperscript helper.
     el("div", {class:"x", onclick:fn, dataset:{id:1}}, [child, "text"]) */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "dataset") Object.keys(v).forEach(function (dk) { node.dataset[dk] = v[dk]; });
      else if (k.slice(0, 2) === "on" && typeof v === "function") {
        node.addEventListener(k.slice(2), v);
      } else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, v);
    });
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    if (children == null) return;
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c == null || c === false) return;
      node.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    });
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function relTimeKo(iso) {
    if (!iso) return "";
    var then = new Date(iso).getTime();
    if (isNaN(then)) return "";
    var diff = Math.round((Date.now() - then) / 1000);
    if (diff < 10) return "방금";
    if (diff < 60) return diff + "초 전";
    if (diff < 3600) return Math.floor(diff / 60) + "분 전";
    if (diff < 86400) return Math.floor(diff / 3600) + "시간 전";
    return Math.floor(diff / 86400) + "일 전";
  }

  /* ---- recurrence ---- */
  var RECURRENCE_LABEL = {
    none: "반복 안 함", daily: "매일", weekdays: "평일", weekly: "매주", monthly: "매월"
  };

  /* Next date (YYYY-MM-DD) for a recurrence type, relative to `from` (default
     today). Returns "" for "none" / unknown types. Month clamps to the last
     day for short months (e.g. Jan 31 -> Feb 28). */
  function nextRecurrenceDate(type, from) {
    from = from || new Date();
    var d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    if (type === "daily") return dateKey(addDays(d, 1));
    if (type === "weekdays") {
      do { d = addDays(d, 1); } while (d.getDay() === 0 || d.getDay() === 6);
      return dateKey(d);
    }
    if (type === "weekly") return dateKey(addDays(d, 7));
    if (type === "monthly") {
      var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
      var last = new Date(y, m + 1, 0).getDate();
      return dateKey(new Date(y, m, Math.min(day, last)));
    }
    return "";
  }

  /* Deadline status of a task relative to `ref` (default now), keyed on the
     task's own work date (taskDate):
       "scheduled" taskDate is in the future            🔁 예정
       "overdue"   taskDate is in the past, OR today's due time has passed  🔴 마감
       "soon"      taskDate is today and due within 60m  🟡 마감 임박
       "today"     taskDate is today with a later due time 🟠 오늘 마감
       "none"      done, or today with no due time                        */
  function taskDueStatus(t, ref) {
    if (!t || t.done) return "none";
    var now = ref || new Date();
    var todayKey = dateKey(now);
    var td = isKey(t.taskDate) ? t.taskDate
      : (isKey(t.nextOccurrence) ? t.nextOccurrence : todayKey);
    if (td > todayKey) return "scheduled";
    if (td < todayKey) return "overdue";
    if (!isHHMM(t.due)) return "none";
    var dueMin = toMinutes(t.due);
    if (dueMin == null) return "none";
    var cur = nowMinutes(now);
    if (cur >= dueMin) return "overdue";
    if (dueMin - cur <= 60) return "soon";
    return "today";
  }

  TP.utils = {
    WEEKDAYS: WEEKDAYS,
    pad: pad,
    uid: uid,
    dateKey: dateKey,
    parseKey: parseKey,
    isKey: isKey,
    firstOfMonth: firstOfMonth,
    addMonths: addMonths,
    addDays: addDays,
    sameDay: sameDay,
    formatDateKorean: formatDateKorean,
    formatDateShort: formatDateShort,
    formatClock: formatClock,
    greeting: greeting,
    isHHMM: isHHMM,
    toMinutes: toMinutes,
    nowMinutes: nowMinutes,
    clamp: clamp,
    pct: pct,
    debounce: debounce,
    escapeHTML: escapeHTML,
    el: el,
    append: appendChildren,
    clear: clear,
    relTimeKo: relTimeKo,
    RECURRENCE_LABEL: RECURRENCE_LABEL,
    nextRecurrenceDate: nextRecurrenceDate,
    taskDueStatus: taskDueStatus
  };
})();
