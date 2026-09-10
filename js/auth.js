/* =========================================================================
   auth.js — client-side access lock (no DB, no server)

   A lightweight gate that hides the dashboard until the correct id / password
   is entered. This is NOT a real authentication system: everything runs in the
   browser, so treat it only as a convenience lock for a personal dashboard.

   Public API (TP.auth):
     isAuthenticated()            -> boolean
     login(username, password, remember) -> boolean   (true on success)
     logout()                     -> void   (clears state and reloads)
     onLogin(fn)                  -> void   (run fn once, after a successful login)
     showLogin() / showDashboard()-> void   (toggle the <html data-auth> gate)

   Storage keys (kept separate from the planner data key "today-planner:v1",
   so existing to-dos / events / notes are never touched):
     sessionStorage "todayPlannerAuthenticated" = "true"   (default session)
     localStorage   "todayPlannerAuthenticated" = "true"   (when "remember" on)
     localStorage   "todayPlannerRemembered"    = "true"   (remember-me marker)
   ========================================================================= */
(function () {
  "use strict";

  window.TP = window.TP || {};

  /* -----------------------------------------------------------------------
     Admin account.
     The password is never stored in plain text here — only a short hash of
     "<SALT><value>" is kept, and the entered value is hashed the same way for
     comparison. To change the credentials, run this in any browser console
     with auth.js loaded and paste the results below:
        TP.auth._hash("your-id")        // -> usernameHash
        TP.auth._hash("your-password")  // -> passwordHash
     Defaults (change these): id "admin", password "1234".
     ----------------------------------------------------------------------- */
  var AUTH_CONFIG = {
    usernameHash: "f8a5ed799a90b",
    passwordHash: "1bb9e5602b061f"
  };

  var SALT = "today-planner::";
  var AUTH_KEY = "todayPlannerAuthenticated";
  var REMEMBER_KEY = "todayPlannerRemembered";
  var THEME_KEY = "today-planner:v1"; // planner data — read-only, for theme sync

  /* ------------------------------- hashing ------------------------------ */
  /* cyrb53 — a compact, well-distributed non-cryptographic string hash.
     Enough to keep the password out of the source as readable text; it is
     not, and is not meant to be, a secure password digest. */
  function cyrb53(str, seed) {
    seed = seed >>> 0;
    var h1 = 0xdeadbeef ^ seed;
    var h2 = 0x41c6ce57 ^ seed;
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  function hash(value) {
    return cyrb53(SALT + String(value == null ? "" : value));
  }

  /* --------------------------- storage helpers ------------------------- */
  function safeGet(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }
  function safeSet(store, key, val) {
    try { store.setItem(key, val); } catch (e) { /* private mode / quota */ }
  }
  function safeRemove(store, key) {
    try { store.removeItem(key); } catch (e) { /* ignore */ }
  }

  /* ------------------------------- state ------------------------------- */
  function isAuthenticated() {
    return safeGet(sessionStorage, AUTH_KEY) === "true" ||
           safeGet(localStorage, AUTH_KEY) === "true";
  }

  function setGate(mode) {
    document.documentElement.setAttribute("data-auth", mode);
  }
  function showDashboard() { setGate("in"); }
  function showLogin() { setGate("out"); }

  var loginCallbacks = [];
  function onLogin(fn) {
    if (typeof fn !== "function") return;
    if (isAuthenticated()) { fn(); return; }
    loginCallbacks.push(fn);
  }
  function fireLogin() {
    var fns = loginCallbacks.slice();
    loginCallbacks.length = 0;
    fns.forEach(function (fn) {
      try { fn(); } catch (e) { /* keep going */ }
    });
  }

  function login(username, password, remember) {
    var ok = hash(String(username).trim()) === AUTH_CONFIG.usernameHash &&
             hash(password) === AUTH_CONFIG.passwordHash;
    if (!ok) return false;

    if (remember) {
      safeSet(localStorage, AUTH_KEY, "true");
      safeSet(localStorage, REMEMBER_KEY, "true");
    } else {
      safeSet(sessionStorage, AUTH_KEY, "true");
      safeRemove(localStorage, AUTH_KEY);
      safeRemove(localStorage, REMEMBER_KEY);
    }
    return true;
  }

  function logout() {
    safeRemove(sessionStorage, AUTH_KEY);
    safeRemove(localStorage, AUTH_KEY);
    safeRemove(localStorage, REMEMBER_KEY);
    showLogin();
    // Full reload: drops the in-memory dashboard so Back / bfcache cannot
    // resurface it, and resets the login form to its initial state.
    location.reload();
  }

  /* --------------------- theme sync for the login screen --------------- */
  /* The planner stores its light/dark choice inside "today-planner:v1".
     Mirror it onto <html> now so the login card matches the last used theme
     even before app.js runs. Read-only — nothing is written back. */
  function applyStoredTheme() {
    try {
      var raw = localStorage.getItem(THEME_KEY);
      if (!raw) return;
      var settings = JSON.parse(raw).settings || {};
      document.documentElement.setAttribute(
        "data-theme", settings.theme === "dark" ? "dark" : "light"
      );
    } catch (e) { /* leave the markup default */ }
  }

  /* ------------------------------ login UI ---------------------------- */
  function wireLoginForm() {
    var form = document.getElementById("loginForm");
    if (!form) return;

    var userInput = document.getElementById("loginUsername");
    var passInput = document.getElementById("loginPassword");
    var remember = document.getElementById("loginRemember");
    var reveal = document.getElementById("loginReveal");
    var errorEl = document.getElementById("loginError");
    var submitBtn = document.getElementById("loginSubmit");
    var submitting = false;

    function clearError() {
      form.classList.remove("login--error");
      if (errorEl) errorEl.hidden = true;
    }
    function showError() {
      form.classList.add("login--error");
      if (errorEl) errorEl.hidden = false;
    }

    userInput.addEventListener("input", clearError);
    passInput.addEventListener("input", clearError);

    reveal.addEventListener("click", function () {
      var show = passInput.type === "password";
      passInput.type = show ? "text" : "password";
      reveal.setAttribute("aria-pressed", show ? "true" : "false");
      reveal.setAttribute("aria-label", show ? "비밀번호 숨기기" : "비밀번호 표시");
      passInput.focus();
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (submitting) return;          // ignore rapid repeat clicks / Enter
      submitting = true;
      submitBtn.disabled = true;

      var ok = login(userInput.value, passInput.value, remember && remember.checked);

      if (ok) {
        passInput.value = "";
        clearError();
        showDashboard();
        fireLogin();
      } else {
        showError();
        passInput.value = "";
        passInput.focus();
        submitting = false;
        submitBtn.disabled = false;
      }
    });
  }

  /* ------------------------------ bootstrap -------------------------- */
  applyStoredTheme();
  if (isAuthenticated()) showDashboard();
  else showLogin();
  wireLoginForm();

  // Re-check on every show, including Back / forward bfcache restores, so a
  // logged-out state can never be bypassed by returning to a cached page.
  window.addEventListener("pageshow", function () {
    if (isAuthenticated()) showDashboard();
    else showLogin();
  });

  TP.auth = {
    isAuthenticated: isAuthenticated,
    login: login,
    logout: logout,
    onLogin: onLogin,
    showLogin: showLogin,
    showDashboard: showDashboard,
    _hash: hash // exposed only so new credentials can be generated in-console
  };
})();
