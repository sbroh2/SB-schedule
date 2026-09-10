/* =========================================================================
   ui.js — reusable, feature-agnostic UI primitives
   - modal / drawer (same API, CSS decides the presentation per breakpoint)
   - confirm() promise dialog
   - toast() notifications
   Handles focus trapping, Escape-to-close, scroll lock and focus restore.
   ========================================================================= */
(function () {
  "use strict";

  var U = TP.utils;
  var root = function () { return document.getElementById("modalRoot"); };
  var toastRoot = function () { return document.getElementById("toastRoot"); };

  var stack = []; // open modal descriptors

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function lockScroll(lock) {
    document.body.style.overflow = lock ? "hidden" : "";
  }

  function openModal(opts) {
    opts = opts || {};
    var host = root();
    var prevFocus = document.activeElement;

    var overlay = U.el("div", { class: "modal-overlay" });
    var closeBtn = U.el("button", {
      class: "modal__close", type: "button", "aria-label": "닫기", html: "&times;"
    });
    var titleId = "modal-title-" + U.uid();
    var modal = U.el("div", {
      class: "modal" + (opts.size === "sm" ? " modal--sm" : ""),
      role: "dialog", "aria-modal": "true", "aria-labelledby": titleId
    }, [
      U.el("div", { class: "modal__head" }, [
        U.el("h2", { class: "modal__title", id: titleId, text: opts.title || "" }),
        closeBtn
      ]),
      U.el("div", { class: "modal__body" }, [opts.content]),
      opts.footer ? U.el("div", { class: "modal__foot" }, opts.footer) : null
    ]);

    host.appendChild(overlay);
    host.appendChild(modal);
    host.hidden = false;
    lockScroll(true);

    var descriptor = { overlay: overlay, modal: modal, prevFocus: prevFocus, onClose: opts.onClose, closed: false };

    function close() {
      if (descriptor.closed) return;
      descriptor.closed = true;
      overlay.remove();
      modal.remove();
      stack = stack.filter(function (d) { return d !== descriptor; });
      if (!stack.length) { host.hidden = true; lockScroll(false); }
      if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
      if (typeof descriptor.onClose === "function") descriptor.onClose();
    }
    descriptor.close = close;

    function onKeydown(e) {
      if (stack[stack.length - 1] !== descriptor) return;
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      if (e.key === "Tab") trapTab(e, modal);
    }
    modal.addEventListener("keydown", onKeydown);
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) close();
    });
    closeBtn.addEventListener("click", close);

    stack.push(descriptor);

    // initial focus: first field, else the modal itself
    var first = modal.querySelector(opts.initialFocus || "input, textarea, select, button.btn--primary");
    (first || closeBtn).focus();

    return descriptor;
  }

  function trapTab(e, container) {
    var items = Array.prototype.filter.call(
      container.querySelectorAll(FOCUSABLE),
      function (n) { return n.offsetParent !== null; }
    );
    if (!items.length) return;
    var firstEl = items[0];
    var lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault(); lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault(); firstEl.focus();
    }
  }

  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var settled = false;
      function done(val) {
        if (settled) return;
        settled = true;
        resolve(val);
        d.close();
      }

      var cancelBtn = U.el("button", {
        class: "btn btn--ghost", type: "button", text: opts.cancelText || "취소",
        onclick: function () { done(false); }
      });
      var okBtn = U.el("button", {
        class: "btn " + (opts.danger ? "btn--danger" : "btn--primary"), type: "button",
        text: opts.confirmText || "확인",
        onclick: function () { done(true); }
      });

      var d = openModal({
        title: opts.title || "확인",
        size: "sm",
        content: U.el("p", { class: "confirm__msg", text: opts.message || "" }),
        footer: [cancelBtn, okBtn],
        initialFocus: opts.danger ? ".btn--ghost" : ".btn--primary",
        onClose: function () { if (!settled) { settled = true; resolve(false); } }
      });
    });
  }

  function toast(message, type, timeout) {
    var host = toastRoot();
    if (!host) return;
    var node = U.el("div", {
      class: "toast" + (type ? " toast--" + type : ""),
      role: "status", text: message
    });
    host.appendChild(node);
    requestAnimationFrame(function () { node.classList.add("is-in"); });
    var remove = function () {
      node.classList.remove("is-in");
      setTimeout(function () { node.remove(); }, 220);
    };
    var t = setTimeout(remove, timeout || 3000);
    node.addEventListener("click", function () { clearTimeout(t); remove(); });
  }

  TP.ui = {
    openModal: openModal,
    confirm: confirmDialog,
    toast: toast
  };
})();
