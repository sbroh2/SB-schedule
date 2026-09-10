/* =========================================================================
   app.js — bootstrap, hash routing, live clock, theme, mobile navigation
   ========================================================================= */
(function () {
  "use strict";

  // Everything below is the original bootstrap, wrapped so it only runs once
  // the user is authenticated (see js/auth.js). Nothing else changed.
  function boot() {

  var U = TP.utils;
  var S = TP.store;
  var V = TP.views;

  var ROUTES = ["dashboard", "tasks", "events", "stats", "settings"];
  var TITLES = {
    dashboard: "대시보드", tasks: "할 일 관리", events: "일정 관리",
    stats: "통계", settings: "설정"
  };
  var QUOTES = [
    "작은 한 걸음이 하루를 바꿔요.",
    "지금 할 수 있는 하나에 집중해요.",
    "완벽보다 완료가 낫습니다.",
    "오늘의 나를 믿어요.",
    "천천히, 그러나 꾸준히."
  ];

  /* --------------------------- initial load ------------------------- */
  var state = S.load();

  // First run with no stored data: follow the OS colour scheme.
  if (!S.hadStoredData() &&
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches) {
    state.settings.theme = "dark";
    S.setTheme("dark");
  }
  applyTheme(state.settings.theme);
  S.rolloverIfNeeded();

  /* ------------------------------ refs ---------------------------- */
  var mainEl = document.getElementById("main");
  var sidebar = document.getElementById("sidebar");
  var scrim = document.getElementById("navScrim");
  var navToggle = document.getElementById("navToggle");
  var themeToggle = document.getElementById("themeToggle");
  var topbarTheme = document.getElementById("topbarTheme");
  var quoteEl = document.getElementById("sidebarQuote");

  quoteEl.textContent = QUOTES[Math.floor(Math.random() * QUOTES.length)];

  // Re-sync now that the header controls exist (the very first applyTheme call
  // during bootstrap ran before these refs were assigned).
  applyTheme(S.get().settings.theme);

  /* ------------------------------ theme -------------------------- */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
    var dark = theme === "dark";
    if (themeToggle) {
      themeToggle.setAttribute("aria-pressed", dark ? "true" : "false");
      themeToggle.querySelector(".theme-toggle__label").textContent = dark ? "라이트 모드" : "다크 모드";
    }
    if (topbarTheme) topbarTheme.querySelector(".theme-glyph").textContent = dark ? "☀️" : "🌙";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#0e1320" : "#f4f5f7");
  }
  TP.applyTheme = applyTheme; // used by settings view

  function toggleTheme() {
    var next = S.get().settings.theme === "dark" ? "light" : "dark";
    S.setTheme(next);
    applyTheme(next);
  }
  themeToggle.addEventListener("click", toggleTheme);
  topbarTheme.addEventListener("click", toggleTheme);

  // Keep header controls in sync when the theme changes from elsewhere
  // (settings view, data import, reset).
  document.addEventListener("tp:change", function () {
    applyTheme(S.get().settings.theme);
  });

  /* --------------------------- mobile nav ------------------------ */
  function openNav() {
    sidebar.classList.add("is-open");
    scrim.hidden = false;
    navToggle.setAttribute("aria-expanded", "true");
    navToggle.setAttribute("aria-label", "메뉴 닫기");
    var first = sidebar.querySelector(".nav__item");
    if (first) first.focus();
  }
  function closeNav() {
    if (!sidebar.classList.contains("is-open")) return;
    sidebar.classList.remove("is-open");
    scrim.hidden = true;
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "메뉴 열기");
  }
  navToggle.addEventListener("click", function () {
    sidebar.classList.contains("is-open") ? closeNav() : openNav();
  });
  scrim.addEventListener("click", closeNav);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeNav();
  });

  /* ---------------------------- routing ------------------------- */
  function currentRoute() {
    var h = (location.hash || "").replace(/^#\/?/, "").trim();
    return ROUTES.indexOf(h) >= 0 ? h : "dashboard";
  }

  function syncNav(route) {
    var items = document.querySelectorAll(".nav__item");
    Array.prototype.forEach.call(items, function (a) {
      var on = a.getAttribute("data-view") === route;
      a.classList.toggle("is-active", on);
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }

  function navigate() {
    var route = currentRoute();
    syncNav(route);
    V.render(route, mainEl);
    document.title = "Today Planner · " + (TITLES[route] || "");
    closeNav();
    // move focus to content for keyboard/screen-reader users, without scroll jump
    try { mainEl.focus({ preventScroll: true }); } catch (e) { mainEl.focus(); }
  }

  window.addEventListener("hashchange", navigate);

  if (ROUTES.indexOf((location.hash || "").replace(/^#\/?/, "")) < 0) {
    location.replace("#/dashboard");
  }
  navigate();

  /* ------------------------- live clock -------------------------- */
  // One interval drives both the on-screen clock and the midnight rollover.
  setInterval(function () {
    if (S.rolloverIfNeeded()) {
      // rollover already dispatched tp:change -> active view re-rendered
      TP.ui.toast("날짜가 바뀌어 오늘 목록을 정리했어요.");
      return;
    }
    V.tick(new Date());
  }, 1000);

  // Re-check the day whenever the tab regains focus (laptop wake, etc.)
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      if (!S.rolloverIfNeeded()) V.tick(new Date());
    }
  });

  } // end boot()

  // Run now if already signed in, otherwise wait for a successful login.
  if (TP.auth) TP.auth.onLogin(boot);
  else boot();
})();
