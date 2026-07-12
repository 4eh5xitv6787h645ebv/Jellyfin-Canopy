// src/enhanced/hidden-content-page/styles.ts
//
// Hidden Content Page — page CSS and its injector.
// (Converted from js/enhanced/hidden-content-page-styles.js — CSS verbatim.)

// ============================================================
// CSS Styles
// ============================================================

const CSS_STYLES = `
    .jc-hidden-content-page {
      padding: 2em;
      max-width: 95vw;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }

    .jc-hidden-content-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2em;
      padding-top: 2em;
      flex-wrap: wrap;
      gap: 1em;
    }

    .jc-hidden-content-title {
      font-size: 2em;
      font-weight: 600;
      margin: 0;
    }

    .jc-hidden-content-count {
      font-size: 0.5em;
      font-weight: 400;
      opacity: 0.6;
      margin-left: 0.5em;
    }

    .jc-hidden-content-toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      margin-bottom: 1.5em;
    }

    .jc-hidden-content-page-search {
      flex: 1;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      color: #fff;
      padding: 10px 14px;
      font-size: 14px;
      outline: none;
      max-width: 400px;
    }

    .jc-hidden-content-page-search::placeholder {
      color: rgba(255,255,255,0.4);
    }

    .jc-hidden-content-page-search:focus {
      border-color: rgba(255,255,255,0.3);
    }

    .jc-hidden-content-page-unhide-all {
      background: rgba(220,50,50,0.3);
      border: 1px solid rgba(220,50,50,0.5);
      color: #fff;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      transition: background 0.2s ease;
    }

    .jc-hidden-content-page-unhide-all:hover {
      background: rgba(220,50,50,0.5);
    }

    .jc-hidden-content-page-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 16px;
    }

    .jc-hidden-content-page-empty {
      text-align: center;
      padding: 60px 24px;
      color: rgba(255,255,255,0.4);
      font-size: 15px;
    }

    /* Group section headers */
    .jc-hidden-group-section {
      margin-bottom: 2em;
    }
    .jc-hidden-group-section-title {
      font-size: 1.2em;
      font-weight: 600;
      color: rgba(255,255,255,0.8);
      margin-bottom: 1em;
      padding-bottom: 0.5em;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }

    /* Grouped card for a show — vertical poster layout matching movie cards */
    .jc-hidden-group-card {
      background: rgba(255,255,255,0.05);
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.08);
      transition: border-color 0.2s ease;
    }
    .jc-hidden-group-card:hover {
      border-color: rgba(255,255,255,0.2);
    }
    .jc-hidden-group-poster-link {
      display: block;
      width: 100%;
      aspect-ratio: 2 / 3;
      overflow: hidden;
      background: rgba(255,255,255,0.05);
    }
    .jc-hidden-group-poster {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .jc-hidden-group-info {
      padding: 8px 10px 4px;
    }
    .jc-hidden-group-name {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    a.jc-hidden-group-name:hover {
      text-decoration: underline;
    }
    .jc-hidden-group-meta {
      font-size: 11px;
      color: rgba(255,255,255,0.4);
      margin-bottom: 4px;
    }

    /* Expand/collapse toggle */
    .jc-hidden-group-expand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: calc(100% - 20px);
      margin: 0 10px 6px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.6);
      padding: 5px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      transition: background 0.15s ease;
    }
    .jc-hidden-group-expand:hover {
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.85);
    }
    .jc-hidden-group-expand .material-icons {
      font-size: 16px;
      transition: transform 0.2s ease;
    }
    .jc-hidden-group-expand.expanded .material-icons {
      transform: rotate(180deg);
    }

    /* Expandable items panel */
    .jc-hidden-group-items {
      padding: 0 10px 6px;
      display: none;
    }
    .jc-hidden-group-items.expanded {
      display: block;
    }
    .jc-hidden-group-item {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      padding: 5px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      gap: 6px;
    }
    .jc-hidden-group-item:last-child {
      border-bottom: none;
    }
    .jc-hidden-group-item-info {
      flex: 1;
      min-width: 0;
    }
    .jc-hidden-group-item-label {
      font-size: 12px;
      color: rgba(255,255,255,0.7);
      display: block;
      word-break: break-word;
    }
    a.jc-hidden-group-item-label:hover {
      color: #fff;
      text-decoration: underline;
    }
    .jc-hidden-group-item-unhide {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.7);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      font-weight: 500;
      transition: background 0.2s ease;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .jc-hidden-group-item-unhide:hover {
      background: rgba(100,200,100,0.3);
      border-color: rgba(100,200,100,0.5);
      color: #fff;
    }
    .jc-hidden-group-unhide-all {
      width: calc(100% - 20px);
      margin: 4px 10px 10px;
      background: rgba(220,50,50,0.2);
      border: 1px solid rgba(220,50,50,0.3);
      color: rgba(255,255,255,0.7);
      padding: 5px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      transition: background 0.2s ease;
      display: none;
    }
    .jc-hidden-group-unhide-all.expanded {
      display: block;
    }
    .jc-hidden-group-unhide-all:hover {
      background: rgba(220,50,50,0.4);
      color: #fff;
    }

    /* Scoped hide badge */
    .jc-hidden-scoped-badge {
      display: inline-block;
      font-size: 9px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(100, 149, 237, 0.25);
      color: rgba(180, 210, 255, 0.85);
      border: 1px solid rgba(100, 149, 237, 0.35);
      white-space: nowrap;
      line-height: 1.3;
      margin-top: 2px;
    }

    /* Simple unhide button for series-only cards (matches movie card style) */
    .jc-hidden-group-unhide {
      display: block;
      width: calc(100% - 20px);
      margin: 6px 10px 10px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.7);
      padding: 6px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: background 0.2s ease;
      text-align: center;
    }
    .jc-hidden-group-unhide:hover {
      background: rgba(100,200,100,0.3);
      border-color: rgba(100,200,100,0.5);
      color: #fff;
    }

    /* Expand/collapse all toggle in section header */
    .jc-hidden-section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1em;
      padding-bottom: 0.5em;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .jc-hidden-section-header-title {
      font-size: 1.2em;
      font-weight: 600;
      color: rgba(255,255,255,0.8);
    }
    .jc-hidden-expand-all-btn {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.6);
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      transition: background 0.15s ease;
    }
    .jc-hidden-expand-all-btn:hover {
      background: rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.85);
    }

    /* Scoped filter toggle */
    .jc-hidden-scoped-filter {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.6);
      padding: 10px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .jc-hidden-scoped-filter:hover {
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.85);
    }
    .jc-hidden-scoped-filter.active {
      background: rgba(100, 149, 237, 0.25);
      border-color: rgba(100, 149, 237, 0.5);
      color: rgba(180, 210, 255, 0.95);
    }

    /* Admin cross-user controls. Accent + text colours come from the active theme via the
       --jc-hc-accent / --jc-hc-text custom properties set in applyAdminThemeVars(); the literal values
       below are fallbacks used when no theme variable is available (option backgrounds are themed inline).
       The control itself stays a neutral translucent surface (matching the sibling search / scoped-toggle
       controls) so it reads on any dark theme. color-mix() needs a modern engine (Chrome 111+/Firefox
       113+/Safari 16.4+); older browsers ignore the rule and fall back to the var() default colour. */
    .jc-hidden-admin-user-filter {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: var(--jc-hc-text, rgba(255,255,255,0.85));
      padding: 10px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      max-width: 240px;
      outline: none;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .jc-hidden-admin-user-filter:hover {
      background: rgba(255,255,255,0.1);
    }
    .jc-hidden-admin-user-filter:focus {
      border-color: color-mix(in srgb, var(--jc-hc-accent, rgb(150,170,255)) 60%, transparent);
    }
    .jc-hidden-admin-edit-toggle {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: var(--jc-hc-text, rgba(255,255,255,0.7));
      padding: 10px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .jc-hidden-admin-edit-toggle:hover {
      background: rgba(255,255,255,0.1);
    }
    .jc-hidden-admin-edit-toggle.active {
      background: color-mix(in srgb, var(--jc-hc-accent, rgb(100,200,120)) 22%, transparent);
      border-color: color-mix(in srgb, var(--jc-hc-accent, rgb(100,200,120)) 50%, transparent);
      color: var(--jc-hc-accent, rgb(185,240,200));
    }
    .jc-hidden-admin-add-btn {
      background: color-mix(in srgb, var(--jc-hc-accent, rgb(100,200,120)) 22%, transparent);
      border: 1px solid color-mix(in srgb, var(--jc-hc-accent, rgb(100,200,120)) 50%, transparent);
      color: var(--jc-hc-accent, rgb(185,240,200));
      padding: 10px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .jc-hidden-admin-add-btn:hover {
      background: color-mix(in srgb, var(--jc-hc-accent, rgb(100,200,120)) 34%, transparent);
    }
    /* Compact status chip that sits inside the header (right of the title). Inline so it never adds
       a banner row that shifts the page; height stays within the title's line so the header doesn't
       grow when it appears/disappears. */
    .jc-hidden-admin-viewing-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
      flex: 0 0 auto;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 13px;
      line-height: 1.2;
      white-space: nowrap;
      max-width: 100%;
      background: color-mix(in srgb, var(--jc-hc-accent, rgb(100,149,237)) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--jc-hc-accent, rgb(100,149,237)) 35%, transparent);
    }
    .jc-hidden-admin-viewing-badge.jc-hidden-admin-editing {
      background: color-mix(in srgb, var(--jc-hc-accent, rgb(100,200,120)) 18%, transparent);
      border-color: color-mix(in srgb, var(--jc-hc-accent, rgb(100,200,120)) 50%, transparent);
    }
    .jc-hidden-admin-viewing-icon {
      font-size: 16px;
      color: var(--jc-hc-accent, rgb(180,210,255));
    }
    .jc-hidden-admin-editing .jc-hidden-admin-viewing-icon {
      color: var(--jc-hc-accent, rgb(185,240,200));
    }
    .jc-hidden-admin-viewing-user {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--jc-hc-accent, rgb(180,210,255));
    }
    .jc-hidden-admin-editing .jc-hidden-admin-viewing-user {
      color: var(--jc-hc-accent, rgb(185,240,200));
    }

    /* Add-items modal: the panel fills the viewport and the results grid scrolls inside
       it (the search box stays put); overscroll-behavior stops the scroll reaching the page behind. */
    .jc-hidden-admin-add-overlay {
      padding: 24px 16px;
      overscroll-behavior: contain;
    }
    .jc-hidden-admin-add-overlay .jc-hidden-management-panel {
      display: flex;
      flex-direction: column;
      max-height: calc(100vh - 48px);
      max-height: calc(100dvh - 48px);
      overflow: hidden;
    }
    .jc-hidden-admin-add-overlay .jc-hidden-management-grid {
      overflow-y: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      flex: 1 1 auto;
      min-height: 0;
      /* The grid has a definite (flex-constrained) height. Without this, its auto rows are sized
         down to each card's min-content to fit that height, and the cards' overflow:hidden then
         clips the poster+info to a ~34px sliver (only visible with many results). Pinning rows to
         max-content keeps every card full height; the grid overflows and scrolls instead. */
      grid-auto-rows: max-content;
      align-content: start;
    }

    @media (max-width: 768px) {
      .jc-hidden-content-page {
        padding: 0.5em;
      }

      .jc-hidden-content-header {
        padding-top: 1em;
      }

      .jc-hidden-content-title {
        font-size: 1.3em;
      }

      /* Compact touch toolbar instead of a column of full-width slabs: the
         search field takes the first row, and the filter / unhide-all / admin
         controls share the next row and wrap as needed. */
      .jc-hidden-content-toolbar {
        flex-wrap: wrap;
        gap: 8px;
      }

      .jc-hidden-content-page-search {
        flex: 1 1 100%;
        max-width: none;
      }

      .jc-hidden-scoped-filter,
      .jc-hidden-content-page-unhide-all,
      .jc-hidden-admin-user-filter,
      .jc-hidden-admin-edit-toggle,
      .jc-hidden-admin-add-btn {
        flex: 1 1 auto;
        /* min-width:0 lets a control shrink below its content width, and
           max-width:100% caps it to the row — together with the container's
           flex-wrap this keeps a long localized label or admin username from
           forcing horizontal overflow (it wraps to its own row instead). The
           admin user-filter <select> also drops its desktop 240px cap. */
        min-width: 0;
        max-width: 100%;
        padding: 8px 12px;
        font-size: 12px;
      }

      .jc-hidden-content-page-grid {
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 10px;
      }

      /* Add-items modal: near-fullscreen with small result cards on phones. */
      .jc-hidden-admin-add-overlay {
        padding: 8px;
      }
      .jc-hidden-admin-add-overlay .jc-hidden-management-panel {
        max-height: calc(100vh - 16px);
        max-height: calc(100dvh - 16px);
      }
      .jc-hidden-admin-add-overlay .jc-hidden-management-grid {
        grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
        gap: 10px;
        padding: 12px;
      }
      .jc-hidden-admin-add-overlay .jc-hidden-item-name { font-size: 12px; }
      .jc-hidden-admin-add-overlay .jc-hidden-item-meta { font-size: 10px; }
      .jc-hidden-admin-add-overlay .jc-hidden-item-unhide { font-size: 11px; padding: 5px; }
    }
  `;

/**
 * Injects the page CSS styles into the document head.
 * No-ops if already injected.
 */
export function injectStyles(): void {
    if (document.getElementById("jc-hidden-content-page-styles")) return;
    const style = document.createElement("style");
    style.id = "jc-hidden-content-page-styles";
    style.textContent = CSS_STYLES;
    document.head.appendChild(style);
}
