/* =========================================================================
   store.js — single source of truth
   - LocalStorage persistence with defensive parsing / normalization
   - CRUD for tasks / events / notes / settings
   - daily rollover (midnight or reopen) + 7-day history
   - derived selectors
   Emits a "tp:change" DOM event after every mutation (except silent note saves,
   which emit "tp:note").
   ========================================================================= */
(function () {
  "use strict";

  var U = TP.utils;
  var KEY = "today-planner:v1";
  var PRIORITIES = ["top", "high", "normal"];
  var RECURRENCES = ["none", "daily", "weekdays", "weekly", "monthly"];
  var BACKUP_APP = "Today Planner";
  var HISTORY_LIMIT = 90;

  var hadStoredData = false;
  var state = null;

  /* ------------------------------- defaults ------------------------------ */
  function defaults() {
    return {
      version: 1,
      tasks: [],
      events: [],
      notes: "",
      noteSavedAt: null,
      history: {},                 // { "YYYY-MM-DD": { completed, total } }
      lastActiveDate: U.dateKey(),
      settings: { theme: "light" }
    };
  }

  /* --------------------------- normalization --------------------------- */
  function normTask(raw) {
    if (!raw || typeof raw !== "object") return null;
    var title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) return null;
    var done = !!raw.done;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : U.uid(),
      title: title.slice(0, 200),
      priority: PRIORITIES.indexOf(raw.priority) >= 0 ? raw.priority : "normal",
      done: done,
      due: U.isHHMM(raw.due) ? raw.due : "",
      note: typeof raw.note === "string" ? raw.note.slice(0, 500) : "",
      // Recurrence (added in Phase 1). Older records simply lack these keys and
      // fall back to the safe defaults below.
      recurrence: RECURRENCES.indexOf(raw.recurrence) >= 0 ? raw.recurrence : "none",
      recurrenceId: typeof raw.recurrenceId === "string" ? raw.recurrenceId.slice(0, 40) : "",
      nextOccurrence: U.isKey(raw.nextOccurrence) ? raw.nextOccurrence : "",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      completedAt: done
        ? (typeof raw.completedAt === "string" ? raw.completedAt : new Date().toISOString())
        : null
    };
  }

  function normEvent(raw) {
    if (!raw || typeof raw !== "object") return null;
    var title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) return null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : U.uid(),
      title: title.slice(0, 200),
      date: U.isKey(raw.date) ? raw.date : U.dateKey(),
      start: U.isHHMM(raw.start) ? raw.start : "",
      end: U.isHHMM(raw.end) ? raw.end : "",
      place: typeof raw.place === "string" ? raw.place.slice(0, 200) : "",
      memo: typeof raw.memo === "string" ? raw.memo.slice(0, 1000) : ""
    };
  }

  function normHistory(raw) {
    var out = {};
    if (!raw || typeof raw !== "object") return out;
    Object.keys(raw).forEach(function (k) {
      if (!U.isKey(k)) return;
      var v = raw[k];
      if (!v || typeof v !== "object") return;
      var total = Math.max(0, parseInt(v.total, 10) || 0);
      var completed = U.clamp(parseInt(v.completed, 10) || 0, 0, total);
      out[k] = { completed: completed, total: total };
    });
    return out;
  }

  function coerce(data) {
    var d = defaults();
    if (!data || typeof data !== "object") return d;
    d.tasks = Array.isArray(data.tasks) ? data.tasks.map(normTask).filter(Boolean) : [];
    d.events = Array.isArray(data.events) ? data.events.map(normEvent).filter(Boolean) : [];
    d.notes = typeof data.notes === "string" ? data.notes.slice(0, 8000) : "";
    d.noteSavedAt = typeof data.noteSavedAt === "string" ? data.noteSavedAt : null;
    d.history = normHistory(data.history);
    d.lastActiveDate = U.isKey(data.lastActiveDate) ? data.lastActiveDate : U.dateKey();
    d.settings = {
      theme: (data.settings && data.settings.theme === "dark") ? "dark" : "light"
    };
    return d;
  }

  /* ---------------------------- persistence --------------------------- */
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }
    hadStoredData = !!raw;
    if (!raw) { state = defaults(); return state; }
    try {
      state = coerce(JSON.parse(raw));
    } catch (e) {
      console.warn("[Today Planner] 저장 데이터를 해석하지 못해 초기화합니다.", e);
      state = defaults();
    }
    return state;
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error("[Today Planner] 저장 실패", e);
      if (TP.ui && TP.ui.toast) {
        TP.ui.toast("저장 공간이 부족해 변경사항을 저장하지 못했어요.", "danger");
      }
      return false;
    }
  }

  function get() { return state || load(); }

  function commit(mutator, eventName) {
    mutator(state);
    persist();
    document.dispatchEvent(new CustomEvent(eventName || "tp:change"));
  }

  /* ------------------------------ rollover --------------------------- */
  /* Called on startup and every clock tick. When the calendar day has moved
     past lastActiveDate we archive that day's numbers, drop finished tasks,
     carry incomplete ones forward, and stamp the new day. */
  function rolloverIfNeeded() {
    var today = U.dateKey();
    if (state.lastActiveDate === today) return false;

    var prev = state.lastActiveDate;
    var total = state.tasks.length;
    var completed = state.tasks.filter(function (t) { return t.done; }).length;
    if (total > 0) state.history[prev] = { completed: completed, total: total };

    state.tasks = state.tasks.filter(function (t) { return !t.done; });
    state.lastActiveDate = today;
    pruneHistory();
    persist();
    document.dispatchEvent(new CustomEvent("tp:change"));
    return true;
  }

  function pruneHistory() {
    var keys = Object.keys(state.history).sort();
    while (keys.length > HISTORY_LIMIT) delete state.history[keys.shift()];
  }

  /* -------------------------------- tasks --------------------------- */
  function addTask(data) {
    var t = normTask({
      title: data.title,
      priority: data.priority,
      due: data.due,
      note: data.note,
      recurrence: data.recurrence,
      recurrenceId: data.recurrenceId
    });
    if (!t) return null;
    if (t.recurrence !== "none" && !t.recurrenceId) t.recurrenceId = U.uid();
    commit(function (s) { s.tasks.unshift(t); });
    return t;
  }

  function updateTask(id, patch) {
    commit(function (s) {
      var t = s.tasks.find(function (x) { return x.id === id; });
      if (!t) return;
      if (patch.title != null) t.title = String(patch.title).trim().slice(0, 200) || t.title;
      if (patch.priority && PRIORITIES.indexOf(patch.priority) >= 0) t.priority = patch.priority;
      if (patch.due != null) t.due = U.isHHMM(patch.due) ? patch.due : "";
      if (patch.note != null) t.note = String(patch.note).slice(0, 500);
      if (patch.recurrence != null) {
        t.recurrence = RECURRENCES.indexOf(patch.recurrence) >= 0 ? patch.recurrence : "none";
        if (t.recurrence !== "none" && !t.recurrenceId) t.recurrenceId = U.uid();
      }
      if (patch.done != null) {
        var wasDone = t.done;
        t.done = !!patch.done;
        t.completedAt = t.done ? new Date().toISOString() : null;
        if (t.done && !wasDone && t.recurrence && t.recurrence !== "none") {
          spawnNextOccurrence(s, t);
        }
      }
    });
  }

  /* When a repeating task is completed, drop in the next occurrence — but only
     if one isn't already waiting. This guard means a page refresh or an
     un-check / re-check never piles up duplicates: at most one open task per
     recurrence chain exists at any time. */
  function spawnNextOccurrence(s, parent) {
    if (!parent.recurrenceId) parent.recurrenceId = U.uid();
    var pending = s.tasks.some(function (x) {
      return x.id !== parent.id && x.recurrenceId === parent.recurrenceId && !x.done;
    });
    if (pending) return;
    var todayKey = U.dateKey();
    var next = U.nextRecurrenceDate(parent.recurrence, new Date());
    var child = normTask({
      title: parent.title,
      priority: parent.priority,
      due: parent.due,
      note: parent.note,
      recurrence: parent.recurrence,
      recurrenceId: parent.recurrenceId,
      nextOccurrence: (next && next > todayKey) ? next : ""
    });
    if (child) s.tasks.unshift(child);
  }

  function toggleTask(id) {
    var t = state.tasks.find(function (x) { return x.id === id; });
    if (t) updateTask(id, { done: !t.done });
  }

  function removeTask(id) {
    commit(function (s) {
      s.tasks = s.tasks.filter(function (x) { return x.id !== id; });
    });
  }

  /* ------------------------------- events -------------------------- */
  function addEvent(data) {
    var e = normEvent(data);
    if (!e) return null;
    commit(function (s) { s.events.push(e); });
    return e;
  }

  function updateEvent(id, patch) {
    commit(function (s) {
      var e = s.events.find(function (x) { return x.id === id; });
      if (!e) return;
      var merged = normEvent(Object.assign({}, e, patch));
      if (merged) Object.assign(e, merged, { id: e.id });
    });
  }

  function removeEvent(id) {
    commit(function (s) {
      s.events = s.events.filter(function (x) { return x.id !== id; });
    });
  }

  /* -------------------------------- notes ------------------------- */
  function setNotes(text) {
    state.notes = String(text == null ? "" : text).slice(0, 8000);
    state.noteSavedAt = new Date().toISOString();
    persist();
    document.dispatchEvent(new CustomEvent("tp:note"));
  }

  /* ------------------------------ settings ----------------------- */
  function setTheme(theme) {
    commit(function (s) { s.settings.theme = theme === "dark" ? "dark" : "light"; });
  }

  function resetAll() {
    state = defaults();
    persist();
    document.dispatchEvent(new CustomEvent("tp:change"));
  }

  function exportJSON() {
    return JSON.stringify({
      app: BACKUP_APP,
      version: 1,
      exportedAt: new Date().toISOString(),
      data: state
    }, null, 2);
  }

  /* Accepts the wrapped backup { app, version, exportedAt, data } and, for
     backward compatibility, a bare state object from older exports. Throws
     Error("BAD_BACKUP") when the file is clearly not a Today Planner backup. */
  function readBackup(parsed) {
    if (!parsed || typeof parsed !== "object") throw new Error("BAD_BACKUP");
    if (parsed.app === BACKUP_APP && parsed.data && typeof parsed.data === "object") {
      return parsed.data;
    }
    var looksLikePlanner =
      Array.isArray(parsed.tasks) || Array.isArray(parsed.events) ||
      typeof parsed.notes === "string" ||
      (parsed.settings && typeof parsed.settings === "object" && "theme" in parsed.settings);
    if (looksLikePlanner) return parsed;
    throw new Error("BAD_BACKUP");
  }

  function importJSON(text) {
    var parsed = JSON.parse(text);      // SyntaxError on bad JSON — caller handles
    var payload = readBackup(parsed);   // Error("BAD_BACKUP")    — caller handles
    state = coerce(payload);
    state.lastActiveDate = U.dateKey();
    persist();
    document.dispatchEvent(new CustomEvent("tp:change"));
  }

  function storageBytes() {
    try { return new Blob([localStorage.getItem(KEY) || ""]).size; }
    catch (e) { return (localStorage.getItem(KEY) || "").length; }
  }

  /* ---------------------------- selectors ----------------------- */
  function tasksSorted() {
    var order = { top: 0, high: 1, normal: 2 };
    // Deadline pressure outranks priority so overdue / imminent work floats up,
    // then the original priority + due-time ordering applies unchanged.
    var urgency = { overdue: 0, soon: 1, today: 2, none: 3, scheduled: 4 };
    var now = new Date();
    return state.tasks.slice().sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      var ua = urgency[U.taskDueStatus(a, now)];
      var ub = urgency[U.taskDueStatus(b, now)];
      if (ua !== ub) return ua - ub;
      if (order[a.priority] !== order[b.priority]) return order[a.priority] - order[b.priority];
      var am = U.toMinutes(a.due), bm = U.toMinutes(b.due);
      if (am != null && bm != null && am !== bm) return am - bm;
      if (am != null && bm == null) return -1;
      if (am == null && bm != null) return 1;
      return 0;
    });
  }

  function topTasks() {
    return tasksSorted().filter(function (t) { return t.priority === "top"; });
  }

  function taskStats() {
    var ts = state.tasks;
    var done = ts.filter(function (t) { return t.done; }).length;
    var remaining = ts.filter(function (t) { return !t.done; });
    var by = { top: 0, high: 0, normal: 0 };
    remaining.forEach(function (t) { by[t.priority]++; });
    var byAll = { top: 0, high: 0, normal: 0 };
    var byDone = { top: 0, high: 0, normal: 0 };
    ts.forEach(function (t) {
      byAll[t.priority]++;
      if (t.done) byDone[t.priority]++;
    });
    return {
      total: ts.length,
      done: done,
      remaining: remaining.length,
      byRemaining: by,
      byAll: byAll,
      byDone: byDone,
      percent: U.pct(done, ts.length)
    };
  }

  function eventsOn(key) {
    return state.events
      .filter(function (e) { return e.date === key; })
      .sort(function (a, b) {
        var am = U.toMinutes(a.start), bm = U.toMinutes(b.start);
        if (am == null && bm == null) return a.title.localeCompare(b.title);
        if (am == null) return 1;
        if (bm == null) return -1;
        return am - bm;
      });
  }

  function eventDaysInMonth(year, month) {
    var set = {};
    state.events.forEach(function (e) {
      var d = U.parseKey(e.date);
      if (d.getFullYear() === year && d.getMonth() === month) set[e.date] = true;
    });
    return set;
  }

  /* status of an event relative to a reference Date (default: now) */
  function eventStatus(e, ref) {
    ref = ref || new Date();
    if (e.date !== U.dateKey(ref)) {
      return U.parseKey(e.date) < U.parseKey(U.dateKey(ref)) ? "past" : "upcoming";
    }
    var cur = U.nowMinutes(ref);
    var s = U.toMinutes(e.start);
    var en = U.toMinutes(e.end);
    if (s == null) return "upcoming";
    if (en != null && cur >= s && cur < en) return "live";
    if (en == null && cur >= s && cur < s + 60) return "live";
    if (cur >= (en != null ? en : s + 60)) return "past";
    return "upcoming";
  }

  /* completion rate for the last N days (oldest -> newest), today live */
  function recentRates(days) {
    var out = [];
    var todayKey = U.dateKey();
    var live = taskStats();
    for (var i = days - 1; i >= 0; i--) {
      var d = U.addDays(new Date(), -i);
      var key = U.dateKey(d);
      var rec;
      if (key === todayKey) rec = { completed: live.done, total: live.total };
      else rec = state.history[key] || null;
      out.push({
        key: key,
        date: d,
        isToday: key === todayKey,
        completed: rec ? rec.completed : 0,
        total: rec ? rec.total : 0,
        hasData: !!rec && rec.total > 0,
        rate: rec ? U.pct(rec.completed, rec.total) : 0
      });
    }
    return out;
  }

  TP.store = {
    load: load,
    get: get,
    hadStoredData: function () { return hadStoredData; },
    rolloverIfNeeded: rolloverIfNeeded,

    addTask: addTask,
    updateTask: updateTask,
    toggleTask: toggleTask,
    removeTask: removeTask,

    addEvent: addEvent,
    updateEvent: updateEvent,
    removeEvent: removeEvent,

    setNotes: setNotes,
    setTheme: setTheme,
    resetAll: resetAll,
    exportJSON: exportJSON,
    importJSON: importJSON,
    storageBytes: storageBytes,

    tasksSorted: tasksSorted,
    topTasks: topTasks,
    taskStats: taskStats,
    eventsOn: eventsOn,
    eventDaysInMonth: eventDaysInMonth,
    eventStatus: eventStatus,
    recentRates: recentRates,

    PRIORITIES: PRIORITIES
  };
})();
