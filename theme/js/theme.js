/* Jellyfin Elevate Docs — theme behaviors (no dependencies).
   Theme toggle, mobile drawer, code copy buttons, TOC scroll-spy,
   table wrapping, heading anchors, screenshot framing. */
(function () {
  "use strict";

  var STORAGE_KEY = "elevate-theme";

  /* ------------------------------------------------------------------
     Theme toggle (initial attribute is set inline in <head>)
     ------------------------------------------------------------------ */
  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    updateToggleLabel();
  }

  function updateToggleLabel() {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    var next = currentTheme() === "dark" ? "light" : "dark";
    btn.setAttribute("aria-label", "Switch to " + next + " mode");
    btn.setAttribute("title", "Switch to " + next + " mode");
  }

  function initThemeToggle() {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    updateToggleLabel();
    btn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch (e) {
        /* storage unavailable — theme still applies for this page */
      }
    });

    // Follow OS changes while the user has no explicit preference.
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function (e) {
        var stored = null;
        try {
          stored = localStorage.getItem(STORAGE_KEY);
        } catch (err) {
          /* ignore */
        }
        if (stored !== "light" && stored !== "dark") {
          applyTheme(e.matches ? "dark" : "light");
        }
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* ------------------------------------------------------------------
     Mobile navigation drawer
     ------------------------------------------------------------------ */
  function initDrawer() {
    var btn = document.getElementById("menu-btn");
    var sidebar = document.getElementById("site-nav");
    var backdrop = document.getElementById("drawer-backdrop");
    if (!btn || !sidebar) return;

    function isOpen() {
      return document.body.classList.contains("nav-open");
    }

    function setOpen(open) {
      document.body.classList.toggle("nav-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
      if (open) {
        var first = sidebar.querySelector("a, summary");
        if (first) first.focus();
      }
    }

    btn.addEventListener("click", function () {
      setOpen(!isOpen());
      if (!isOpen()) btn.focus();
    });
    if (backdrop) {
      backdrop.addEventListener("click", function () {
        setOpen(false);
        btn.focus();
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen()) {
        setOpen(false);
        btn.focus();
      }
    });
    // Close the drawer when a nav link is chosen.
    sidebar.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
  }

  /* ------------------------------------------------------------------
     Scroll the active sidebar link into view
     ------------------------------------------------------------------ */
  function revealActiveNav() {
    var sidebar = document.getElementById("site-nav");
    var active = sidebar && sidebar.querySelector(".nav-link.is-active");
    if (!sidebar || !active) return;
    var target = active.offsetTop - sidebar.clientHeight / 2;
    if (target > 0) sidebar.scrollTop = target;
  }

  /* ------------------------------------------------------------------
     Code blocks: copy button + language label
     ------------------------------------------------------------------ */
  function initCodeBlocks() {
    var blocks = document.querySelectorAll(".doc-body .highlight");
    Array.prototype.forEach.call(blocks, function (block) {
      var pre = block.querySelector("pre");
      var code = block.querySelector("pre > code") || pre;
      if (!pre || block.querySelector(".code-copy")) return;

      var meta = document.createElement("div");
      meta.className = "code-meta";

      var langMatch = code.className && code.className.match(/language-([\w#+-]+)/);
      if (langMatch && langMatch[1] !== "text") {
        var lang = document.createElement("span");
        lang.className = "code-lang";
        lang.textContent = langMatch[1];
        meta.appendChild(lang);
      }

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy";
      btn.setAttribute("aria-label", "Copy code to clipboard");
      btn.innerHTML =
        '<svg class="icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>' +
        '<svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

      btn.addEventListener("click", function () {
        var text = code.innerText.replace(/\n$/, "");
        var done = function () {
          btn.classList.add("is-copied");
          btn.setAttribute("aria-label", "Copied");
          setTimeout(function () {
            btn.classList.remove("is-copied");
            btn.setAttribute("aria-label", "Copy code to clipboard");
          }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () {
            legacyCopy(text) && done();
          });
        } else if (legacyCopy(text)) {
          done();
        }
      });

      meta.appendChild(btn);
      block.appendChild(meta);
    });
  }

  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  /* ------------------------------------------------------------------
     Wrap wide tables so they scroll inside a framed container
     ------------------------------------------------------------------ */
  function initTables() {
    var tables = document.querySelectorAll(".doc-body table");
    Array.prototype.forEach.call(tables, function (table) {
      if (table.parentElement.classList.contains("table-wrap")) return;
      var wrap = document.createElement("div");
      wrap.className = "table-wrap";
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }

  /* ------------------------------------------------------------------
     Heading anchor links (h2-h4 with ids)
     ------------------------------------------------------------------ */
  function initHeadingAnchors() {
    var headings = document.querySelectorAll(
      ".doc-body h2[id], .doc-body h3[id], .doc-body h4[id]"
    );
    Array.prototype.forEach.call(headings, function (h) {
      if (h.querySelector(".h-anchor")) return;
      var a = document.createElement("a");
      a.className = "h-anchor";
      a.href = "#" + h.id;
      a.textContent = "#";
      a.setAttribute("aria-label", "Link to this section");
      h.appendChild(a);
    });
  }

  /* ------------------------------------------------------------------
     Frame content screenshots (skip badges/small inline images)
     ------------------------------------------------------------------ */
  function initImageFrames() {
    var imgs = document.querySelectorAll(".doc-body img");
    Array.prototype.forEach.call(imgs, function (img) {
      var mark = function () {
        if (img.naturalHeight > 60 && img.naturalWidth > 120) {
          img.classList.add("img-framed");
        }
      };
      if (img.complete && img.naturalHeight) mark();
      else img.addEventListener("load", mark);
    });
  }

  /* ------------------------------------------------------------------
     "On this page" scroll-spy
     ------------------------------------------------------------------ */
  function initScrollSpy() {
    var tocLinks = document.querySelectorAll("#page-toc .toc-list a[href^='#']");
    if (!tocLinks.length || !("IntersectionObserver" in window)) return;

    var map = {};
    var targets = [];
    Array.prototype.forEach.call(tocLinks, function (link) {
      var id = decodeURIComponent(link.getAttribute("href").slice(1));
      var el = document.getElementById(id);
      if (el) {
        map[id] = link;
        targets.push(el);
      }
    });
    if (!targets.length) return;

    var setActive = function (id) {
      Array.prototype.forEach.call(tocLinks, function (l) {
        l.classList.remove("is-active");
      });
      if (map[id]) map[id].classList.add("is-active");
    };

    var visible = [];
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var id = entry.target.id;
          if (entry.isIntersecting) {
            if (visible.indexOf(id) === -1) visible.push(id);
          } else {
            var i = visible.indexOf(id);
            if (i !== -1) visible.splice(i, 1);
          }
        });
        if (visible.length) {
          // highlight the top-most visible heading
          var top = targets.filter(function (t) {
            return visible.indexOf(t.id) !== -1;
          })[0];
          if (top) setActive(top.id);
        }
      },
      { rootMargin: "-70px 0px -66% 0px", threshold: 0 }
    );
    targets.forEach(function (t) {
      observer.observe(t);
    });
  }

  /* ------------------------------------------------------------------ */
  function init() {
    initThemeToggle();
    initDrawer();
    revealActiveNav();
    initCodeBlocks();
    initTables();
    initHeadingAnchors();
    initImageFrames();
    initScrollSpy();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
