/* =========================================================================
   views.js — screen rendering + feature dialogs
   Each view renders into #main. Data mutations happen only through TP.store,
   which fires "tp:change"; this module re-paints the active view in response
   (a per-view partial handler is used where a full rebuild would be wasteful
   or would steal focus, e.g. the dashboard quick-memo box).
   ========================================================================= */
(function () {
  "use strict";

  var U = TP.utils;
  var S = TP.store;
  var UI = TP.ui;
  var el = U.el;

  var P_LABEL = { top: "최우선", high: "중요", normal: "일반" };
  var FILTERS = [["all", "전체"], ["active", "진행 중"], ["done", "완료"]];

  var current = "dashboard";
  var mountRef = null;
  var partialHandler = null; // fn | null (null => full re-render on tp:change)
  var noteHandler = null;    // fn | null (called on tp:note)
  var dashTick = null;       // fn(now) | null

  var tasksFilter = "all";   // persists across re-renders of the tasks view
  var tasksSearch = "";      // search query for the tasks view (persists too)
  var eventsSelectedDate = null;

  /* =====================================================================
     Shared builders
     ===================================================================== */
  function emptyState(icon, title, hint) {
    return el("div", { class: "empty" }, [
      el("div", { class: "empty__icon", "aria-hidden": "true", text: icon }),
      el("p", { class: "empty__title", text: title }),
      hint ? el("p", { class: "empty__hint", text: hint }) : null
    ]);
  }

  function priorityChip(p) {
    return el("span", { class: "chip chip--" + p, text: (p === "top" ? "🔥 " : "") + P_LABEL[p] });
  }

  function iconButton(glyph, label, onClick, danger) {
    return el("button", {
      class: "mini-btn" + (danger ? " mini-btn--danger" : ""),
      type: "button", "aria-label": label, html: glyph, onclick: onClick
    });
  }

  function panelHeader(titleText, countText, actionNode) {
    var title = el("h2", { class: "section-title" }, [titleText]);
    if (countText != null && countText !== "") {
      title.appendChild(el("span", { class: "section-title__count", text: countText }));
    }
    return el("div", { class: "panel__head" }, [title, actionNode || null]);
  }

  function filterBar(active, onPick) {
    var bar = el("div", { class: "filters", role: "group", "aria-label": "필터" });
    FILTERS.forEach(function (f) {
      bar.appendChild(el("button", {
        type: "button",
        class: "filters__btn" + (active === f[0] ? " is-active" : ""),
        "aria-pressed": active === f[0] ? "true" : "false",
        text: f[1],
        onclick: function () { onPick(f[0]); }
      }));
    });
    return bar;
  }

  function applyTaskFilter(list, f) {
    if (f === "active") return list.filter(function (t) { return !t.done; });
    if (f === "done") return list.filter(function (t) { return t.done; });
    return list;
  }

  function deadlineChip(t) {
    switch (U.taskDueStatus(t)) {
      case "overdue": return el("span", { class: "chip chip--overdue", text: "🔴 마감" });
      case "soon": return el("span", { class: "chip chip--soon", text: "🟡 마감 임박" });
      case "today": return el("span", { class: "chip chip--today", text: "🟠 오늘 마감" });
      case "scheduled": {
        var when = U.isKey(t.taskDate) ? t.taskDate : t.nextOccurrence;
        // 🔁 for a repeating occurrence, 📅 for a one-off task simply dated ahead.
        var icon = (t.recurrence && t.recurrence !== "none") ? "🔁 " : "📅 ";
        return el("span", {
          class: "chip chip--recur",
          text: icon + U.formatDateShort(when) + " 예정"
        });
      }
      default: return null;
    }
  }

  function taskRow(t) {
    var check = el("input", {
      type: "checkbox", class: "check", "aria-label": t.title + " 완료 표시",
      onchange: function () { S.toggleTask(t.id); }
    });
    check.checked = t.done;

    var meta = el("div", { class: "task__meta" }, [priorityChip(t.priority)]);
    if (t.due) meta.appendChild(el("span", { class: "task__time", text: "⏰ " + t.due }));

    var due = deadlineChip(t);
    if (due) meta.appendChild(due);

    if (t.recurrence && t.recurrence !== "none") {
      meta.appendChild(el("span", {
        class: "chip chip--recur",
        text: "🔁 " + (U.RECURRENCE_LABEL[t.recurrence] || "반복")
      }));
    }

    var main = el("div", { class: "task__main" }, [
      el("span", { class: "task__title", text: t.title }),
      meta,
      t.note ? el("span", { class: "task__note", text: t.note }) : null
    ]);

    return el("li", {
      class: "task" + (t.done ? " is-done" : "") + (t.priority === "top" ? " task--top" : "") +
        (U.taskDueStatus(t) === "overdue" ? " task--overdue" : "")
    }, [
      check, main,
      el("div", { class: "task__actions" }, [
        iconButton("&#9998;", "할 일 수정", function () { openTaskForm(t); }),
        iconButton("&#128465;", "할 일 삭제", function () { confirmDeleteTask(t); }, true)
      ])
    ]);
  }

  function eventRow(e, ref) {
    var status = S.eventStatus(e, ref || new Date());
    var timeBlock = el("div", { class: "event__time" }, [
      e.start || "종일",
      e.end ? el("small", { text: "~ " + e.end }) : null
    ]);

    var subParts = [];
    if (e.place) subParts.push("📍 " + e.place);
    if (status === "live") subParts.push("진행 중");
    else if (status === "past") subParts.push("종료");

    var body = el("div", { class: "event__body" }, [
      el("span", { class: "event__title", text: e.title }),
      subParts.length ? el("span", { class: "event__sub", text: subParts.join("  ·  ") }) : null,
      e.memo ? el("span", { class: "event__sub", text: e.memo }) : null
    ]);

    return el("li", {
      class: "event" + (status === "live" ? " is-live" : "") + (status === "past" ? " is-past" : "")
    }, [
      timeBlock, body,
      el("div", { class: "event__actions" }, [
        iconButton("&#9998;", "일정 수정", function () { openEventForm(e); }),
        iconButton("&#128465;", "일정 삭제", function () { confirmDeleteEvent(e); }, true)
      ])
    ]);
  }

  function confirmDeleteTask(t) {
    UI.confirm({
      title: "할 일 삭제",
      message: "“" + t.title + "” 항목을 삭제할까요? 삭제한 항목은 되돌릴 수 없어요.",
      confirmText: "삭제", danger: true
    }).then(function (ok) {
      if (ok) { S.removeTask(t.id); UI.toast("할 일을 삭제했어요."); }
    });
  }

  function confirmDeleteEvent(e) {
    UI.confirm({
      title: "일정 삭제",
      message: "“" + e.title + "” 일정을 삭제할까요? 삭제한 일정은 되돌릴 수 없어요.",
      confirmText: "삭제", danger: true
    }).then(function (ok) {
      if (ok) { S.removeEvent(e.id); UI.toast("일정을 삭제했어요."); }
    });
  }

  function shake(node) {
    node.classList.remove("shake");
    void node.offsetWidth; // restart animation
    node.classList.add("shake");
  }

  /* =====================================================================
     Dialogs — task / event forms with validation
     ===================================================================== */
  function openTaskForm(existing, preset) {
    var isEdit = !!existing;
    var data = existing || Object.assign({ title: "", priority: "normal", due: "", note: "", recurrence: "none" }, preset || {});

    var titleInput = el("input", {
      type: "text", id: "tf-title", maxlength: "200", autocomplete: "off",
      placeholder: "예: 기획서 초안 작성"
    });
    titleInput.value = data.title;
    var titleField = el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "tf-title", html: '제목 <span class="req">*</span>' }),
      titleInput,
      el("p", { class: "field__error", text: "제목을 입력해 주세요." })
    ]);

    var prio = el("div", { class: "pill-group" });
    [["top", "🔥 최우선"], ["high", "중요"], ["normal", "일반"]].forEach(function (o) {
      var id = "tf-p-" + o[0];
      var input = el("input", { type: "radio", name: "tf-priority", id: id, value: o[0] });
      input.checked = data.priority === o[0];
      prio.appendChild(input);
      prio.appendChild(el("label", { for: id, text: o[1] }));
    });

    // 업무 날짜 (Phase 1.5) — HTML date input, defaults to today. On edit it
    // shows the task's saved taskDate; legacy tasks without one fall back to
    // today (store already backfills taskDate on load, so this is belt-and-braces).
    var dateInput = el("input", { type: "date", id: "tf-date" });
    dateInput.value = U.isKey(data.taskDate) ? data.taskDate : U.dateKey();
    var dateField = el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "tf-date", text: "업무 날짜" }),
      dateInput
    ]);

    var dueInput = el("input", { type: "time", id: "tf-due" });
    dueInput.value = data.due;
    var noteInput = el("textarea", { id: "tf-note", maxlength: "500", placeholder: "메모 (선택)" });
    noteInput.value = data.note;

    var recGroup = el("div", { class: "pill-group pill-group--wrap", role: "radiogroup", "aria-label": "반복" });
    [["none", "반복 안 함"], ["daily", "매일"], ["weekdays", "평일"], ["weekly", "매주"], ["monthly", "매월"]].forEach(function (o) {
      var id = "tf-r-" + o[0];
      var input = el("input", { type: "radio", name: "tf-recurrence", id: id, value: o[0] });
      input.checked = (data.recurrence || "none") === o[0];
      recGroup.appendChild(input);
      recGroup.appendChild(el("label", { for: id, text: o[1] }));
    });

    var form = el("form", { novalidate: "novalidate" }, [
      titleField,
      dateField,
      el("div", { class: "field" }, [el("label", { class: "field__label", text: "우선순위" }), prio]),
      el("div", { class: "field" }, [
        el("label", { class: "field__label", for: "tf-due", text: "마감 시간 (선택)" }), dueInput
      ]),
      el("div", { class: "field" }, [
        el("label", { class: "field__label", text: "반복" }), recGroup
      ]),
      el("div", { class: "field" }, [
        el("label", { class: "field__label", for: "tf-note", text: "메모 (선택)" }), noteInput
      ])
    ]);

    titleInput.addEventListener("input", function () {
      if (titleInput.value.trim()) titleField.classList.remove("has-error");
    });

    function submit(ev) {
      if (ev) ev.preventDefault();
      var title = titleInput.value.trim();
      if (!title) {
        titleField.classList.add("has-error");
        shake(titleInput);
        titleInput.focus();
        return;
      }
      var checked = form.querySelector('input[name="tf-priority"]:checked');
      var recChecked = form.querySelector('input[name="tf-recurrence"]:checked');
      var payload = {
        title: title,
        taskDate: U.isKey(dateInput.value) ? dateInput.value : U.dateKey(),
        priority: checked ? checked.value : "normal",
        due: dueInput.value,
        note: noteInput.value.trim(),
        recurrence: recChecked ? recChecked.value : "none"
      };
      if (isEdit) { S.updateTask(existing.id, payload); UI.toast("할 일을 수정했어요.", "success"); }
      else { S.addTask(payload); UI.toast("할 일을 추가했어요.", "success"); }
      modal.close();
    }
    form.addEventListener("submit", submit);

    var modal = UI.openModal({
      title: isEdit ? "할 일 수정" : "새 할 일",
      content: form,
      initialFocus: "#tf-title",
      footer: [
        el("button", { class: "btn btn--ghost", type: "button", text: "취소", onclick: function () { modal.close(); } }),
        el("button", { class: "btn btn--primary", type: "button", text: isEdit ? "수정 저장" : "추가", onclick: submit })
      ]
    });
  }

  function openEventForm(existing, presetDate) {
    var isEdit = !!existing;
    var data = existing || {
      title: "", date: U.isKey(presetDate) ? presetDate : U.dateKey(),
      start: "", end: "", place: "", memo: ""
    };

    var titleInput = el("input", { type: "text", id: "ef-title", maxlength: "200", autocomplete: "off", placeholder: "예: 팀 회의" });
    titleInput.value = data.title;
    var titleField = el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "ef-title", html: '제목 <span class="req">*</span>' }),
      titleInput, el("p", { class: "field__error", text: "제목을 입력해 주세요." })
    ]);

    var dateInput = el("input", { type: "date", id: "ef-date" });
    dateInput.value = data.date;
    var dateField = el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "ef-date", html: '날짜 <span class="req">*</span>' }),
      dateInput, el("p", { class: "field__error", text: "날짜를 선택해 주세요." })
    ]);

    var startInput = el("input", { type: "time", id: "ef-start" });
    startInput.value = data.start;
    var endInput = el("input", { type: "time", id: "ef-end" });
    endInput.value = data.end;
    var endField = el("div", { class: "field" }, [
      el("label", { class: "field__label", for: "ef-end", text: "종료" }), endInput,
      el("p", { class: "field__error", text: "종료 시간은 시작 시간보다 늦어야 해요." })
    ]);

    var placeInput = el("input", { type: "text", id: "ef-place", maxlength: "200", placeholder: "장소 (선택)" });
    placeInput.value = data.place;
    var memoInput = el("textarea", { id: "ef-memo", maxlength: "1000", placeholder: "메모 (선택)" });
    memoInput.value = data.memo;

    var form = el("form", { novalidate: "novalidate" }, [
      titleField, dateField,
      el("div", { class: "field-row" }, [
        el("div", { class: "field" }, [el("label", { class: "field__label", for: "ef-start", text: "시작" }), startInput]),
        endField
      ]),
      el("div", { class: "field" }, [el("label", { class: "field__label", for: "ef-place", text: "장소 (선택)" }), placeInput]),
      el("div", { class: "field" }, [el("label", { class: "field__label", for: "ef-memo", text: "메모 (선택)" }), memoInput])
    ]);

    titleInput.addEventListener("input", function () {
      if (titleInput.value.trim()) titleField.classList.remove("has-error");
    });
    dateInput.addEventListener("input", function () {
      if (U.isKey(dateInput.value)) dateField.classList.remove("has-error");
    });
    function clearEndErr() { endField.classList.remove("has-error"); }
    startInput.addEventListener("input", clearEndErr);
    endInput.addEventListener("input", clearEndErr);

    function submit(ev) {
      if (ev) ev.preventDefault();
      var okAll = true;
      if (!titleInput.value.trim()) { titleField.classList.add("has-error"); okAll = false; }
      if (!U.isKey(dateInput.value)) { dateField.classList.add("has-error"); okAll = false; }
      var s = U.toMinutes(startInput.value), e2 = U.toMinutes(endInput.value);
      if (s != null && e2 != null && e2 <= s) { endField.classList.add("has-error"); okAll = false; }
      if (!okAll) {
        var bad = form.querySelector(".has-error input");
        if (bad) { shake(bad); bad.focus(); }
        return;
      }
      var payload = {
        title: titleInput.value.trim(), date: dateInput.value,
        start: startInput.value, end: endInput.value,
        place: placeInput.value.trim(), memo: memoInput.value.trim()
      };
      if (isEdit) { S.updateEvent(existing.id, payload); UI.toast("일정을 수정했어요.", "success"); }
      else { S.addEvent(payload); UI.toast("일정을 추가했어요.", "success"); }
      modal.close();
    }
    form.addEventListener("submit", submit);

    var modal = UI.openModal({
      title: isEdit ? "일정 수정" : "새 일정",
      content: form,
      initialFocus: "#ef-title",
      footer: [
        el("button", { class: "btn btn--ghost", type: "button", text: "취소", onclick: function () { modal.close(); } }),
        el("button", { class: "btn btn--primary", type: "button", text: isEdit ? "수정 저장" : "추가", onclick: submit })
      ]
    });
  }

  /* =====================================================================
     View: Dashboard
     ===================================================================== */
  function renderDashboard(mount) {
    var dateEl = el("p", { class: "dash-head__date" });
    var greetEl = el("h1", { class: "dash-head__greet" });
    var clockEl = el("p", { class: "dash-head__clock" });
    mount.appendChild(el("header", { class: "dash-head" }, [
      el("div", {}, [dateEl, greetEl]), clockEl
    ]));

    var summary = el("section", { class: "summary", "aria-label": "오늘 요약" });
    mount.appendChild(summary);

    var priHead = el("div"), priBody = el("div", { class: "panel__body" });
    var schHead = el("div"), schBody = el("div", { class: "panel__body" });
    var todoHead = el("div"), todoBody = el("div", { class: "panel__body" });
    var memoBody = el("div", { class: "panel__body" });

    var grid = el("div", { class: "dash-grid" }, [
      el("section", { class: "panel" }, [priHead, priBody]),
      el("section", { class: "panel" }, [schHead, schBody]),
      el("section", { class: "panel" }, [todoHead, todoBody]),
      el("section", { class: "panel memo" }, [
        panelHeader("📝 빠른 메모"), memoBody
      ])
    ]);
    mount.appendChild(grid);

    var dashTodoFilter = "all";
    var refocusQuick = false;

    /* ----- head ----- */
    function paintHead(now) {
      now = now || new Date();
      dateEl.textContent = U.formatDateKorean(now);
      greetEl.textContent = U.greeting(now);
      clockEl.textContent = U.formatClock(now, true);
    }

    /* ----- summary cards ----- */
    function statCard(label, valueNodes, metaNodes) {
      return el("article", { class: "stat" }, [
        el("span", { class: "stat__label", text: label }),
        el("div", { style: "display:flex;flex-direction:column;gap:8px" }, valueNodes),
        metaNodes && metaNodes.length ? el("div", { class: "stat__meta" }, metaNodes) : null
      ]);
    }

    function paintSummary() {
      U.clear(summary);
      var st = S.taskStats();
      var evs = S.eventsOn(U.dateKey());
      var now = new Date();
      var live = 0, upcoming = 0, past = 0;
      evs.forEach(function (e) {
        var s = S.eventStatus(e, now);
        if (s === "live") live++; else if (s === "past") past++; else upcoming++;
      });
      var d = S.get();

      summary.appendChild(statCard("✅ 오늘 완료율", [
        el("div", { class: "stat__value", html: st.done + " / " + st.total + " <small>(" + st.percent + "%)</small>" }),
        el("div", {
          class: "progress", role: "progressbar", style: "--v:" + st.percent,
          "aria-valuenow": st.percent, "aria-valuemin": "0", "aria-valuemax": "100",
          "aria-label": "오늘 완료율 " + st.percent + "퍼센트",
          html: '<span class="progress__fill"></span>'
        })
      ]));

      var pressing = S.tasksToday().filter(function (t) {
        var s = U.taskDueStatus(t, now);
        return s === "overdue" || s === "soon";
      }).length;
      var remainMeta = [
        el("span", { class: "chip chip--top", text: "최우선 " + st.byRemaining.top }),
        el("span", { class: "chip chip--high", text: "중요 " + st.byRemaining.high }),
        el("span", { class: "chip chip--normal", text: "일반 " + st.byRemaining.normal })
      ];
      if (pressing) {
        remainMeta.push(el("span", { class: "chip chip--overdue", text: "마감 임박 " + pressing }));
      }
      summary.appendChild(statCard("📌 남은 할 일", [
        el("div", { class: "stat__value", text: st.remaining + "개" })
      ], remainMeta));

      summary.appendChild(statCard("📅 오늘 일정", [
        el("div", { class: "stat__value", text: evs.length + "개" })
      ], [
        el("span", { class: "chip chip--live", text: "진행 중 " + live }),
        el("span", { class: "chip", text: "예정 " + upcoming }),
        el("span", { class: "chip", text: "종료 " + past })
      ]));

      var hasNote = d.notes.trim().length > 0;
      summary.appendChild(statCard("📝 오늘 메모", [
        el("div", { class: "stat__value", text: hasNote ? d.notes.trim().length + "자" : "비어 있음" })
      ], [
        el("span", { class: "chip", text: d.noteSavedAt ? "저장 " + U.relTimeKo(d.noteSavedAt) : "저장 기록 없음" })
      ]));
    }

    /* ----- priority panel ----- */
    function paintPriority() {
      var tops = S.topTasks();
      U.clear(priHead).appendChild(panelHeader(
        "🔥 최우선 작업", String(tops.length),
        el("button", {
          class: "btn btn--ghost btn--sm", type: "button", text: "+ 추가",
          onclick: function () { openTaskForm(null, { priority: "top" }); }
        })
      ));
      U.clear(priBody);
      if (!tops.length) {
        priBody.appendChild(emptyState("🎯", "최우선 작업이 없어요", "가장 중요한 일을 최우선으로 지정해 보세요."));
        return;
      }
      var ul = el("ul", { class: "panel__body" });
      tops.forEach(function (t) { ul.appendChild(taskRow(t)); });
      priBody.appendChild(ul);
    }

    /* ----- schedule panel ----- */
    function paintSchedule() {
      var evs = S.eventsOn(U.dateKey());
      U.clear(schHead).appendChild(panelHeader(
        "📅 오늘의 일정", String(evs.length),
        el("button", {
          class: "btn btn--ghost btn--sm", type: "button", text: "+ 추가",
          onclick: function () { openEventForm(null, U.dateKey()); }
        })
      ));
      U.clear(schBody);
      if (!evs.length) {
        schBody.appendChild(emptyState("🗓️", "오늘 일정이 없어요", "일정을 추가하면 시간순으로 정리돼요."));
        return;
      }
      var now = new Date();
      var ul = el("ul", { class: "panel__body" });
      evs.forEach(function (e) { ul.appendChild(eventRow(e, now)); });
      schBody.appendChild(ul);
    }

    /* ----- todo panel ----- */
    function paintTodo() {
      var all = S.tasksToday();
      U.clear(todoHead).appendChild(panelHeader(
        "📋 오늘의 할 일", all.length ? S.taskStats().done + " / " + all.length : "0",
        el("button", {
          class: "btn btn--ghost btn--sm", type: "button", text: "+ 추가",
          onclick: function () { openTaskForm(null); }
        })
      ));

      U.clear(todoBody);
      todoBody.appendChild(filterBar(dashTodoFilter, function (f) { dashTodoFilter = f; paintTodo(); }));

      var quickInput = el("input", {
        type: "text", maxlength: "200", "aria-label": "빠른 할 일 추가",
        placeholder: "빠르게 할 일 추가…"
      });
      function quickAdd() {
        var v = quickInput.value.trim();
        if (!v) { shake(quickInput); quickInput.focus(); return; }
        refocusQuick = true;
        S.addTask({ title: v, priority: "normal", due: "", note: "" });
      }
      quickInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); quickAdd(); }
      });
      todoBody.appendChild(el("div", { class: "quick-add" }, [
        quickInput,
        el("button", { class: "btn btn--primary btn--sm", type: "button", text: "추가", onclick: quickAdd })
      ]));
      if (refocusQuick) { quickInput.focus(); refocusQuick = false; }

      var list = applyTaskFilter(all, dashTodoFilter);
      if (!list.length) {
        todoBody.appendChild(emptyState(
          "🌱",
          dashTodoFilter === "done" ? "완료한 일이 아직 없어요"
            : dashTodoFilter === "active" ? "진행 중인 일이 없어요" : "할 일이 없어요",
          "위 입력창에 오늘 할 일을 적어보세요."
        ));
        return;
      }
      var ul = el("ul", { class: "panel__body" });
      list.forEach(function (t) { ul.appendChild(taskRow(t)); });
      todoBody.appendChild(ul);
    }

    /* ----- memo panel ----- */
    var memoTextarea = el("textarea", {
      "aria-label": "빠른 메모", placeholder: "머릿속 생각을 빠르게 적어두세요. 입력을 멈추면 자동 저장돼요."
    });
    memoTextarea.value = S.get().notes;
    var memoMeta = el("p", { class: "memo__meta" });
    var typing = false;
    var saveMemo = U.debounce(function () { typing = false; S.setNotes(memoTextarea.value); }, 500);
    memoTextarea.addEventListener("input", function () {
      typing = true;
      memoMeta.innerHTML = "";
      memoMeta.appendChild(el("span", { class: "dot dot--idle" }));
      memoMeta.appendChild(document.createTextNode("입력 중…"));
      saveMemo();
    });

    function paintMemoMeta() {
      if (typing) return;
      var savedAt = S.get().noteSavedAt;
      U.clear(memoMeta);
      memoMeta.appendChild(el("span", { class: "dot" + (savedAt ? "" : " dot--idle") }));
      memoMeta.appendChild(document.createTextNode(
        savedAt ? "저장됨 · " + U.relTimeKo(savedAt) : "아직 저장된 메모가 없어요"
      ));
    }

    memoBody.appendChild(memoTextarea);
    memoBody.appendChild(memoMeta);

    /* ----- wire up ----- */
    paintHead();
    paintSummary();
    paintPriority();
    paintSchedule();
    paintTodo();
    paintMemoMeta();

    var lastMinute = new Date().getMinutes();
    dashTick = function (now) {
      clockEl.textContent = U.formatClock(now, true);
      if (now.getMinutes() !== lastMinute) {
        lastMinute = now.getMinutes();
        paintHead(now);
        paintSummary();
        paintSchedule();
        paintPriority();
        paintMemoMeta();
      }
    };
    partialHandler = function () {
      paintSummary();
      paintPriority();
      paintSchedule();
      paintTodo();
      paintMemoMeta();
    };
    noteHandler = function () {
      paintMemoMeta();
      paintSummary();
    };
  }

  /* =====================================================================
     View: 할 일 관리  (search + filter)
     ===================================================================== */
  var TASK_FILTERS = [
    ["all", "전체"], ["active", "미완료"], ["done", "완료"],
    ["top", "최우선"], ["high", "중요"], ["normal", "일반"],
    ["today", "오늘"], ["due-soon", "마감 임박"]
  ];

  // "오늘" filter: exactly today's work (taskDate === 오늘). Past still-open
  // tasks are NOT pulled in here — use the "미완료" filter for those — and
  // future-dated (recurrence) occurrences are excluded too. Legacy tasks with
  // no taskDate are treated as today's.
  function isToday(t) {
    return U.isKey(t.taskDate) ? t.taskDate === U.dateKey() : true;
  }

  /* filter + free-text search over title and note (case-insensitive) */
  function filterTasks(list, f, search) {
    var out = list;
    if (f === "active") out = out.filter(function (t) { return !t.done; });
    else if (f === "done") out = out.filter(function (t) { return t.done; });
    else if (f === "top" || f === "high" || f === "normal") {
      out = out.filter(function (t) { return t.priority === f; });
    } else if (f === "today") {
      out = out.filter(function (t) { return !t.done && isToday(t); });
    } else if (f === "due-soon") {
      out = out.filter(function (t) {
        var s = U.taskDueStatus(t);
        return s === "overdue" || s === "soon";
      });
    }
    var q = (search || "").trim().toLowerCase();
    if (q) {
      out = out.filter(function (t) {
        return (t.title && t.title.toLowerCase().indexOf(q) >= 0) ||
          (t.note && t.note.toLowerCase().indexOf(q) >= 0);
      });
    }
    return out;
  }

  function emptyFilterTitle(f) {
    return f === "done" ? "완료한 할 일이 없어요"
      : f === "active" ? "진행 중인 할 일이 없어요"
      : f === "top" ? "최우선 할 일이 없어요"
      : f === "high" ? "중요 할 일이 없어요"
      : f === "normal" ? "일반 할 일이 없어요"
      : f === "today" ? "오늘 할 일이 없어요"
      : f === "due-soon" ? "마감 임박한 할 일이 없어요"
      : "등록된 할 일이 없어요";
  }

  function renderTasks(mount) {
    mount.appendChild(el("header", { class: "view-head" }, [
      el("h1", { class: "view-head__title", text: "할 일 관리" }),
      el("p", { class: "view-head__sub", text: "검색과 필터로 원하는 할 일만 빠르게 찾아보세요." })
    ]));

    var searchInput = el("input", {
      type: "search", class: "search__input", id: "taskSearch",
      placeholder: "업무 검색...", "aria-label": "업무 검색", autocomplete: "off"
    });
    searchInput.value = tasksSearch;
    var searchWrap = el("div", { class: "search" }, [
      el("span", { class: "search__icon", "aria-hidden": "true", text: "🔍" }),
      searchInput
    ]);

    var filterWrap = el("div", { class: "filters filters--scroll", role: "group", "aria-label": "할 일 필터" });
    function paintFilters() {
      U.clear(filterWrap);
      TASK_FILTERS.forEach(function (f) {
        filterWrap.appendChild(el("button", {
          type: "button",
          class: "filters__btn" + (tasksFilter === f[0] ? " is-active" : ""),
          "aria-pressed": tasksFilter === f[0] ? "true" : "false",
          text: f[1],
          onclick: function () { tasksFilter = f[0]; paintFilters(); paintList(); }
        }));
      });
    }

    var countEl = el("span", { class: "view-head__sub" });
    var toolbar = el("div", { class: "tasks-toolbar" }, [
      searchWrap,
      filterWrap,
      el("div", { class: "tasks-toolbar__actions" }, [
        countEl,
        el("button", {
          class: "btn btn--primary btn--sm", type: "button", text: "+ 새 할 일",
          onclick: function () { openTaskForm(null); }
        })
      ])
    ]);
    mount.appendChild(toolbar);

    var card = el("div", { class: "card card--pad" });
    mount.appendChild(card);

    function paintList() {
      U.clear(card);
      var list = filterTasks(S.tasksSorted(), tasksFilter, tasksSearch);
      var doneN = list.filter(function (t) { return t.done; }).length;
      countEl.textContent = "완료 " + doneN + " · 남음 " + (list.length - doneN);
      if (!list.length) {
        if (tasksSearch.trim()) {
          card.appendChild(emptyState(
            "🔍", "검색 결과가 없습니다.",
            "다른 검색어를 입력하거나 필터를 변경해 주세요."
          ));
        } else {
          card.appendChild(emptyState(
            "🗒️", emptyFilterTitle(tasksFilter),
            "‘+ 새 할 일’ 버튼으로 할 일을 추가해 보세요."
          ));
        }
        return;
      }
      var ul = el("ul", { style: "display:flex;flex-direction:column;gap:10px" });
      list.forEach(function (t) { ul.appendChild(taskRow(t)); });
      card.appendChild(ul);
    }

    var onSearch = U.debounce(function () {
      tasksSearch = searchInput.value;
      paintList();
    }, 120);
    searchInput.addEventListener("input", onSearch);
    searchInput.addEventListener("search", function () {
      tasksSearch = searchInput.value;
      paintList();
    });

    paintFilters();
    paintList();

    // Repaint only the list on data changes so the search box keeps focus.
    partialHandler = paintList;
  }

  /* =====================================================================
     View: 일정 관리
     ===================================================================== */
  function renderEvents(mount) {
    mount.appendChild(el("header", { class: "view-head" }, [
      el("h1", { class: "view-head__title", text: "일정 관리" }),
      el("p", { class: "view-head__sub", text: "날짜별 일정을 관리하고, 미니 캘린더에서 원하는 날을 골라 보세요." })
    ]));

    var listPanel = el("section", { class: "panel" });
    var listHead = el("div"), listBody = el("div", { class: "panel__body" });
    listPanel.appendChild(listHead);
    listPanel.appendChild(listBody);

    var cal = TP.createCalendar({
      selected: eventsSelectedDate,
      getMarks: function (y, m) { return S.eventDaysInMonth(y, m); },
      onSelect: function (key) { eventsSelectedDate = key; paintList(); }
    });

    var leftPanel = el("section", { class: "panel" }, [
      cal.root,
      el("button", {
        class: "btn btn--primary btn--block", type: "button", text: "+ 새 일정",
        onclick: function () { openEventForm(null, eventsSelectedDate || U.dateKey()); }
      })
    ]);

    mount.appendChild(el("div", { class: "stats-lower" }, [leftPanel, listPanel]));

    function paintList() {
      U.clear(listHead);
      U.clear(listBody);

      if (eventsSelectedDate) {
        listHead.appendChild(panelHeader(
          "🗓️ " + U.formatDateShort(eventsSelectedDate), null,
          el("button", {
            class: "btn btn--ghost btn--sm", type: "button", text: "전체 보기",
            onclick: function () { eventsSelectedDate = null; cal.setSelected(null); paintList(); }
          })
        ));
        var dayEvents = S.eventsOn(eventsSelectedDate);
        if (!dayEvents.length) {
          listBody.appendChild(emptyState("📭", "이 날은 일정이 없어요", "‘+ 새 일정’으로 추가할 수 있어요."));
        } else {
          var ul = el("ul", { class: "panel__body" });
          var ref = U.parseKey(eventsSelectedDate);
          dayEvents.forEach(function (e) { ul.appendChild(eventRow(e, ref)); });
          listBody.appendChild(ul);
        }
        return;
      }

      listHead.appendChild(panelHeader("📅 다가오는 일정", null));
      var todayKey = U.dateKey();
      var upcoming = S.get().events
        .filter(function (e) { return e.date >= todayKey; })
        .sort(function (a, b) {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          return (U.toMinutes(a.start) == null ? 1e9 : U.toMinutes(a.start)) -
            (U.toMinutes(b.start) == null ? 1e9 : U.toMinutes(b.start));
        })
        .slice(0, 40);

      if (!upcoming.length) {
        listBody.appendChild(emptyState("🌤️", "예정된 일정이 없어요", "미니 캘린더에서 날짜를 골라 일정을 추가해 보세요."));
        return;
      }
      var wrap = el("ul", { class: "panel__body" });
      var lastDate = null;
      var now = new Date();
      upcoming.forEach(function (e) {
        if (e.date !== lastDate) {
          lastDate = e.date;
          wrap.appendChild(el("li", {
            style: "list-style:none;font-weight:700;font-size:12px;color:var(--text-muted);margin:14px 0 2px",
            text: U.formatDateShort(e.date) + (e.date === todayKey ? " · 오늘" : "")
          }));
        }
        wrap.appendChild(eventRow(e, now));
      });
      listBody.appendChild(wrap);
    }

    paintList();
  }

  /* =====================================================================
     View: 통계
     ===================================================================== */
  function renderStats(mount) {
    var st = S.taskStats();

    mount.appendChild(el("header", { class: "view-head" }, [
      el("h1", { class: "view-head__title", text: "통계" }),
      el("p", { class: "view-head__sub", text: "오늘의 성과와 최근 7일 흐름을 확인하세요." })
    ]));

    function bigStat(label, value, sub) {
      return el("article", { class: "stat" }, [
        el("span", { class: "stat__label", text: label }),
        el("div", { class: "stat__value", text: value }),
        sub ? el("div", { class: "stat__meta" }, [el("span", { class: "chip", text: sub })]) : null
      ]);
    }

    mount.appendChild(el("div", { class: "stats-grid" }, [
      bigStat("오늘 완료", String(st.done), null),
      bigStat("오늘 남음", String(st.remaining), null),
      bigStat("전체 할 일", String(st.total), null),
      bigStat("완료율", st.percent + "%", st.done + " / " + st.total)
    ]));

    /* ring + priority distribution */
    var ring = el("div", { class: "ring", style: "--v:" + st.percent }, [
      el("div", { class: "ring__label", text: st.percent + "%" })
    ]);
    var ringPanel = el("section", { class: "panel" }, [
      panelHeader("🎯 오늘 완료율"),
      el("div", { class: "ring-wrap" }, [
        ring,
        el("div", {}, [
          el("div", { class: "stat__value", text: st.done + " / " + st.total }),
          el("p", { class: "view-head__sub", text: st.remaining + "개 남았어요" })
        ])
      ])
    ]);

    var maxByAll = Math.max(1, st.byAll.top, st.byAll.high, st.byAll.normal);
    function bar(pKey, label) {
      return el("div", { class: "bar-row" }, [
        el("span", { class: "bar-row__label", text: label }),
        el("div", { class: "bar-row__track" }, [
          el("div", {
            class: "bar-row__fill bar-row__fill--" + pKey,
            style: "width:" + Math.round((st.byAll[pKey] / maxByAll) * 100) + "%"
          })
        ]),
        el("span", { class: "bar-row__val", text: st.byDone[pKey] + "/" + st.byAll[pKey] })
      ]);
    }
    var prioPanel = el("section", { class: "panel" }, [
      panelHeader("📊 우선순위별 분포"),
      el("div", { class: "panel__body" }, [
        bar("top", "최우선"), bar("high", "중요"), bar("normal", "일반"),
        el("p", { class: "view-head__sub", text: "숫자는 ‘완료 / 전체’ 기준이에요." })
      ])
    ]);

    mount.appendChild(el("div", { class: "stats-lower" }, [ringPanel, prioPanel]));

    /* last 7 days */
    var rates = S.recentRates(7);
    var avg = Math.round(
      rates.reduce(function (a, r) { return a + (r.hasData ? r.rate : 0); }, 0) /
      Math.max(1, rates.filter(function (r) { return r.hasData; }).length)
    );
    var chart = el("div", { class: "week-chart" });
    rates.forEach(function (r) {
      var barCls = "week-col__bar" + (r.isToday ? " is-today" : "") + (r.hasData ? "" : " is-empty");
      chart.appendChild(el("div", { class: "week-col" }, [
        el("div", { class: "week-col__bar-wrap" }, [
          el("div", {
            class: barCls,
            style: "height:" + (r.hasData ? Math.max(4, r.rate) : 4) + "%",
            title: r.hasData ? r.rate + "% (" + r.completed + "/" + r.total + ")" : "기록 없음"
          })
        ]),
        el("div", { class: "week-col__cap" }, [
          (r.hasData ? r.rate + "%" : "–"),
          el("small", { text: U.WEEKDAYS[r.date.getDay()] + " " + (r.date.getMonth() + 1) + "/" + r.date.getDate() })
        ])
      ]));
    });

    mount.appendChild(el("section", { class: "panel", style: "margin-top:20px" }, [
      panelHeader("📈 최근 7일 완료율", "평균 " + (isFinite(avg) ? avg : 0) + "%"),
      chart
    ]));
  }

  /* =====================================================================
     View: 설정
     ===================================================================== */
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  function renderSettings(mount) {
    var d = S.get();

    mount.appendChild(el("header", { class: "view-head" }, [
      el("h1", { class: "view-head__title", text: "설정" }),
      el("p", { class: "view-head__sub", text: "테마와 데이터를 관리하세요. 모든 데이터는 이 브라우저에만 저장됩니다." })
    ]));

    /* theme */
    var seg = el("div", { class: "seg", role: "group", "aria-label": "테마 선택" });
    [["light", "라이트"], ["dark", "다크"]].forEach(function (o) {
      seg.appendChild(el("button", {
        type: "button", text: o[1],
        class: d.settings.theme === o[0] ? "is-active" : "",
        onclick: function () { S.setTheme(o[0]); if (TP.applyTheme) TP.applyTheme(o[0]); }
      }));
    });

    mount.appendChild(el("section", { class: "card card--pad" }, [
      el("h2", { class: "section-title", text: "🎨 테마" }),
      el("div", { class: "setting-row" }, [
        el("div", { class: "setting-row__text" }, [
          el("span", { class: "setting-row__title", text: "화면 모드" }),
          el("span", { class: "setting-row__desc", text: "라이트 / 다크 모드를 선택하세요. 새로고침 후에도 유지됩니다." })
        ]),
        seg
      ])
    ]));

    /* data management — export / import / wipe */
    var fileInput = el("input", { type: "file", accept: "application/json,.json", style: "display:none" });
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onerror = function () {
        fileInput.value = "";
        UI.toast("파일을 읽지 못했어요.", "danger");
      };
      reader.onload = function () {
        var text = String(reader.result);
        UI.confirm({
          title: "데이터 복원",
          message: "현재 데이터가 백업 파일의 데이터로 변경됩니다. 계속하시겠습니까?",
          confirmText: "복원하기", cancelText: "취소"
        }).then(function (ok) {
          fileInput.value = "";
          if (!ok) return;
          try {
            S.importJSON(text);
            if (TP.applyTheme) TP.applyTheme(S.get().settings.theme);
            UI.toast("데이터가 성공적으로 복원되었습니다.", "success");
          } catch (err) {
            UI.toast("잘못된 백업 파일입니다. Today Planner 백업 파일을 선택해주세요.", "danger");
          }
        });
      };
      reader.readAsText(f);
    });

    function exportBackup() {
      try {
        var blob = new Blob([S.exportJSON()], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = el("a", { href: url, download: "today-planner-backup-" + U.dateKey() + ".json" });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        UI.toast("백업 파일을 저장했어요.", "success");
      } catch (e) {
        UI.toast("내보내기에 실패했어요.", "danger");
      }
    }

    function wipeAll() {
      UI.confirm({
        title: "⚠️ 전체 데이터 삭제",
        message: "모든 업무, 일정, 메모 및 저장된 데이터가 삭제됩니다. 이 작업은 되돌릴 수 없습니다. 정말 삭제하시겠습니까?",
        confirmText: "전체 삭제", cancelText: "취소", danger: true
      }).then(function (ok) {
        if (!ok) return;
        S.resetAll();
        if (TP.applyTheme) TP.applyTheme("light");
        UI.toast("모든 데이터를 삭제했어요.");
        location.hash = "#/dashboard";
      });
    }

    mount.appendChild(el("section", { class: "card card--pad" }, [
      el("h2", { class: "section-title", text: "🗂️ 데이터 관리" }),
      el("p", {
        class: "setting-row__desc", style: "padding-top:8px",
        text: "내 업무 데이터를 파일로 백업하거나 이전에 백업한 데이터를 복원할 수 있습니다."
      }),
      el("div", { class: "data-actions" }, [
        el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "📥 데이터 내보내기", onclick: exportBackup }),
        el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "📤 데이터 가져오기", onclick: function () { fileInput.click(); } }),
        el("button", { class: "btn btn--danger btn--sm", type: "button", text: "🗑 전체 데이터 삭제", onclick: wipeAll })
      ]),
      el("div", { class: "setting-row" }, [
        el("div", { class: "setting-row__text" }, [
          el("span", { class: "setting-row__title", text: "저장 용량" }),
          el("span", { class: "setting-row__desc", text: "이 브라우저 LocalStorage 사용량" })
        ]),
        el("span", { class: "chip", text: fmtBytes(S.storageBytes()) })
      ]),
      el("p", {
        class: "setting-row__desc", style: "padding-top:8px",
        text: "데이터는 이 브라우저에만 저장됩니다. 브라우저 데이터를 지우면 사라질 수 있으니 정기적으로 내보내기로 백업하세요."
      }),
      fileInput
    ]));

    /* account */
    function doLogout() {
      UI.confirm({
        title: "로그아웃",
        message: "로그아웃할까요? 저장된 할 일·일정·메모는 그대로 유지됩니다.",
        confirmText: "로그아웃"
      }).then(function (ok) {
        if (ok && TP.auth) TP.auth.logout();
      });
    }

    if (TP.auth) {
      mount.appendChild(el("section", { class: "card card--pad" }, [
        el("h2", { class: "section-title", text: "🔒 계정" }),
        el("div", { class: "setting-row" }, [
          el("div", { class: "setting-row__text" }, [
            el("span", { class: "setting-row__title", text: "로그아웃" }),
            el("span", { class: "setting-row__desc", text: "이 브라우저에서 로그아웃하고 로그인 화면으로 돌아갑니다." })
          ]),
          el("button", { class: "btn btn--ghost btn--sm", type: "button", text: "로그아웃", onclick: doLogout })
        ])
      ]));
    }

    /* about */
    mount.appendChild(el("section", { class: "card card--pad" }, [
      el("h2", { class: "section-title", text: "ℹ️ 정보" }),
      el("div", { class: "setting-row" }, [
        el("div", { class: "setting-row__text" }, [
          el("span", { class: "setting-row__title", text: "Today Planner" }),
          el("span", { class: "setting-row__desc", text: "오늘을 위한 작은 습관 · v1.0" })
        ]),
        el("span", { class: "chip", text: "오프라인 지원" })
      ])
    ]));
  }

  /* =====================================================================
     Router hooks
     ===================================================================== */
  var RENDERERS = {
    dashboard: renderDashboard,
    tasks: renderTasks,
    events: renderEvents,
    stats: renderStats,
    settings: renderSettings
  };

  function render(name, mount) {
    current = RENDERERS[name] ? name : "dashboard";
    mountRef = mount;
    partialHandler = null;
    noteHandler = null;
    dashTick = null;
    U.clear(mount);
    RENDERERS[current](mount);
    mount.scrollTop = 0;
  }

  function handleChange() {
    if (partialHandler) partialHandler();
    else if (mountRef) render(current, mountRef);
  }

  function tick(now) {
    if (dashTick) dashTick(now || new Date());
  }

  document.addEventListener("tp:change", handleChange);
  document.addEventListener("tp:note", function () { if (noteHandler) noteHandler(); });

  TP.views = {
    render: render,
    tick: tick,
    current: function () { return current; }
  };
})();
