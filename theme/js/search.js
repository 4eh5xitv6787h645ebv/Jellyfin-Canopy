/* Jellyfin Elevate Docs — client-side search.
   Uses the mkdocs `search` plugin index (search/search_index.json) with a
   locally vendored lunr.js. All result rendering uses DOM APIs + textContent
   (never HTML strings), so index content is inert. */
(function () {
  "use strict";

  var overlay = document.getElementById("search-overlay");
  var input = document.getElementById("search-input");
  var resultsEl = document.getElementById("search-results");
  var statusEl = document.getElementById("search-status");
  var openBtn = document.getElementById("search-btn");
  var closeBtn = document.getElementById("search-close");
  if (!overlay || !input || !resultsEl) return;

  var root = document.body.getAttribute("data-root") || ".";
  var indexPromise = null;
  var lastFocus = null;
  var activeIndex = -1;
  var resultLinks = [];
  var debounceTimer = null;

  /* ------------------------------------------------------------------
     Index loading
     ------------------------------------------------------------------ */
  function loadIndex() {
    if (indexPromise) return indexPromise;
    indexPromise = fetch(root + "/search/search_index.json")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var docs = data.docs || [];
        var byLocation = {};
        docs.forEach(function (d) {
          byLocation[d.location] = d;
        });
        if (data.config && data.config.separator) {
          try {
            lunr.tokenizer.separator = new RegExp(data.config.separator);
          } catch (e) {
            /* keep lunr's default separator */
          }
        }
        var idx = lunr(function () {
          this.ref("location");
          this.field("title", { boost: 10 });
          this.field("text");
          this.metadataWhitelist = [];
          docs.forEach(function (d) {
            this.add(d);
          }, this);
        });
        return { idx: idx, byLocation: byLocation };
      });
    indexPromise.catch(function () {
      indexPromise = null;
      setStatus("Search index could not be loaded. Please try again.");
    });
    return indexPromise;
  }

  /* ------------------------------------------------------------------
     Modal open / close
     ------------------------------------------------------------------ */
  function openSearch() {
    lastFocus = document.activeElement;
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    input.value = "";
    clearResults();
    setStatus("Type to search the documentation.");
    input.focus();
    loadIndex();
  }

  function closeSearch() {
    overlay.hidden = true;
    document.body.style.overflow = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function setStatus(msg) {
    statusEl.hidden = !msg;
    statusEl.textContent = msg || "";
  }

  function clearResults() {
    resultsEl.textContent = "";
    resultLinks = [];
    activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-activedescendant", "");
  }

  /* ------------------------------------------------------------------
     Query + render
     ------------------------------------------------------------------ */
  function tokensOf(query) {
    return query
      .toLowerCase()
      .split(/[\s\-,:!=\[\]()"/]+/)
      .filter(function (t) {
        return t.length > 0;
      });
  }

  function runSearch(query) {
    var tokens = tokensOf(query);
    if (!tokens.length) {
      clearResults();
      setStatus("Type to search the documentation.");
      return;
    }
    loadIndex().then(function (bundle) {
      var hits = [];
      try {
        hits = bundle.idx.query(function (q) {
          tokens.forEach(function (t) {
            q.term(t, { boost: 10 });
            q.term(t, { wildcard: lunr.Query.wildcard.TRAILING, boost: 4 });
            if (t.length > 3) {
              q.term(t, { editDistance: 1, boost: 1 });
            }
          });
        });
      } catch (e) {
        hits = [];
      }
      render(hits.slice(0, 12), tokens, query, bundle.byLocation);
    });
  }

  function pageTitleFor(location, byLocation) {
    var pageLoc = location.split("#")[0];
    var pageDoc = byLocation[pageLoc];
    return pageDoc ? pageDoc.title : "";
  }

  /* Append `text` to `parent`, wrapping every token match in <mark>. */
  function appendHighlighted(parent, text, tokens) {
    if (!text) return;
    var pattern = tokens
      .map(function (t) {
        return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("|");
    var re;
    try {
      re = new RegExp(pattern, "gi");
    } catch (e) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    var last = 0;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      var mark = document.createElement("mark");
      mark.textContent = m[0];
      parent.appendChild(mark);
      last = m.index + m[0].length;
      if (m.index === re.lastIndex) re.lastIndex++; // safety on zero-length match
    }
    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function snippetOf(text, tokens) {
    if (!text) return "";
    var lower = text.toLowerCase();
    var pos = -1;
    for (var i = 0; i < tokens.length; i++) {
      pos = lower.indexOf(tokens[i]);
      if (pos !== -1) break;
    }
    if (pos === -1) pos = 0;
    var start = Math.max(0, pos - 50);
    var end = Math.min(text.length, pos + 130);
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  }

  function render(hits, tokens, query, byLocation) {
    clearResults();
    if (!hits.length) {
      setStatus('No results for "' + query + '".');
      return;
    }
    setStatus("");
    var frag = document.createDocumentFragment();
    hits.forEach(function (hit, i) {
      var doc = byLocation[hit.ref];
      if (!doc) return;

      var li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.id = "search-result-" + i;

      var a = document.createElement("a");
      a.href = root + "/" + doc.location;

      var pageTitle = pageTitleFor(doc.location, byLocation);
      if (pageTitle && pageTitle !== doc.title) {
        var crumb = document.createElement("span");
        crumb.className = "sr-crumb";
        crumb.textContent = pageTitle;
        a.appendChild(crumb);
      }

      var title = document.createElement("span");
      title.className = "sr-title";
      appendHighlighted(title, doc.title || doc.location, tokens);
      a.appendChild(title);

      var snippet = snippetOf(doc.text, tokens);
      if (snippet) {
        var text = document.createElement("span");
        text.className = "sr-text";
        appendHighlighted(text, snippet, tokens);
        a.appendChild(text);
      }

      a.addEventListener("click", function () {
        closeSearch();
      });
      li.appendChild(a);
      frag.appendChild(li);
      resultLinks.push({ li: li, a: a });
    });
    resultsEl.appendChild(frag);
    input.setAttribute("aria-expanded", "true");
    setActive(0);
    statusEl.hidden = true;
    // screen-reader count announcement
    var live = resultLinks.length + (resultLinks.length === 1 ? " result" : " results");
    statusEl.setAttribute("data-count", live);
  }

  function setActive(i) {
    if (!resultLinks.length) return;
    if (activeIndex >= 0 && resultLinks[activeIndex]) {
      resultLinks[activeIndex].li.classList.remove("is-active");
      resultLinks[activeIndex].li.setAttribute("aria-selected", "false");
    }
    activeIndex = (i + resultLinks.length) % resultLinks.length;
    var item = resultLinks[activeIndex];
    item.li.classList.add("is-active");
    item.li.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", item.li.id);
    item.li.scrollIntoView({ block: "nearest" });
  }

  /* ------------------------------------------------------------------
     Events
     ------------------------------------------------------------------ */
  input.addEventListener("input", function () {
    clearTimeout(debounceTimer);
    var q = input.value.trim();
    debounceTimer = setTimeout(function () {
      runSearch(q);
    }, 90);
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(activeIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(activeIndex - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && resultLinks[activeIndex]) {
        resultLinks[activeIndex].a.click();
      }
    }
  });

  if (openBtn) openBtn.addEventListener("click", openSearch);
  if (closeBtn) closeBtn.addEventListener("click", closeSearch);

  overlay.addEventListener("mousedown", function (e) {
    if (e.target === overlay) closeSearch();
  });

  // basic focus trap inside the dialog
  overlay.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearch();
      return;
    }
    if (e.key !== "Tab") return;
    var focusables = [input, closeBtn].filter(Boolean);
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  document.addEventListener("keydown", function (e) {
    var tag = (e.target.tagName || "").toLowerCase();
    var typing =
      tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (overlay.hidden) openSearch();
      else closeSearch();
    } else if (e.key === "/" && !typing && overlay.hidden) {
      e.preventDefault();
      openSearch();
    }
  });

  // any element may opt in as a search opener (e.g. 404 page)
  Array.prototype.forEach.call(document.querySelectorAll("[data-search-open]"), function (el) {
    el.addEventListener("click", openSearch);
  });
})();
