// src/arr/requests/styles.ts
// Requests Page — CSS and theme-color injection (split from requests-page.js).
// Owns the single injection site for the feature's styles; all former call
// sites import injectStyles, deduped by style id via core injectCss.

import { injectCss } from '../../core/ui-kit';
import { JC } from '../arr-globals';

// CSS Styles - minimal styling to fit Jellyfin's theme
const CSS_STYLES = `
        .jc-downloads-page {
            padding: 2em;
            max-width: 85vw;
            margin: 0 auto;
            position: relative;
            z-index: 1;
        }
        .jc-downloads-section {
            margin-bottom: 2em;
        }
        .jc-downloads-section h2 {
            font-size: 1.5em;
            margin-bottom: 1em;
        }
        .jc-downloads-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: 1.1em;
        }
        .jc-download-card, .jc-request-card {
            background: rgba(128,128,128,0.1);
            border-radius: 0.25em;
            overflow: hidden;
        }
        .jc-download-card-content {
          display: flex;
          gap: 1em;
          padding: 1.15em;
        }
        .jc-download-poster, .jc-request-poster {
            border-radius: 0.5em;
            object-fit: cover;
            flex-shrink: 0;
        }
        .jc-download-poster {
          width: 72px;
          height: 108px;
        }
        .jc-request-poster {
            width: 80px;
            height: 120px;
            max-height: 120px;
        }
        .jc-download-poster.placeholder, .jc-request-poster.placeholder {
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(128,128,128,0.15);
            opacity: 0.5;
        }
        .jc-download-info, .jc-request-info {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 0.3em;
        }
        .jc-download-title, .jc-request-title {
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .jc-download-subtitle, .jc-request-year {
            font-size: 0.85em;
            opacity: 0.7;
        }
        .jc-download-meta {
            display: flex;
            gap: 0.5em;
            flex-wrap: wrap;
            margin-top: auto;
        }
        .jc-download-badge, .jc-request-status {
          font-size: 0.95em;
          padding: 0.35em 0.7em;
          border-radius: 999px;
          text-transform: uppercase;
          font-weight: 700;
          color: #fff;
        }
        .jc-arr-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.25em;
          padding: 0;
          background: transparent;
        }
        .jc-arr-badge img {
          width: 18px;
          height: 18px;
          object-fit: contain;
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));
        }
        .jc-download-progress-container {
            padding: 0 1em 1em;
        }
        .jc-download-progress {
            height: 4px;
            background: rgba(128,128,128,0.2);
            border-radius: 2px;
            overflow: hidden;
        }
        .jc-download-progress-bar {
            height: 100%;
            transition: width 0.3s ease;
        }
        .jc-download-stats {
          display: flex;
          justify-content: space-between;
          font-size: 1em;
          opacity: 0.95;
          margin-top: 0.6em;
        }
        .jc-requests-tabs,
        .jc-issues-tabs {
            display: flex;
            gap: 0.5em;
            margin-bottom: 1em;
            flex-wrap: wrap;
        }
        .jc-requests-tab.emby-button,
        .jc-issues-tab.emby-button {
            background: transparent;
            border: 1px solid rgba(255,255,255,0.3);
            color: inherit;
            padding: 0.5em 1em;
            border-radius: 4px;
            cursor: pointer;
            opacity: 0.7;
            transition: all 0.2s;
        }
        .jc-requests-tab.emby-button:hover,
        .jc-issues-tab.emby-button:hover {
            opacity: 1;
            background: rgba(255,255,255,0.1);
        }
        .jc-requests-tab.emby-button.active,
        .jc-issues-tab.emby-button.active {
            opacity: 1;
        }
        .jc-request-card {
            display: flex;
            gap: 1em;
            padding: 1em;
            overflow: visible;
        }
        .jc-request-info {
            overflow: hidden;
            min-width: 0;
        }
        .jc-request-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 0.5em;
            margin-bottom: 0.5em;
            min-width: 0;
        }
        .jc-request-header > div:first-child {
            min-width: 0;
            flex: 1;
            overflow: hidden;
        }
        .jc-request-title {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            display: block;
        }
        .jc-request-status {
            flex-shrink: 0;
        }
        .jc-request-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5em;
          font-size: 0.85em;
          opacity: 0.8;
          margin-top: 0.5em;
        }
        .jc-request-meta-left { display: inline-flex; align-items: center; gap: 0.5em; min-width: 0; }
        .jc-request-avatar {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            object-fit: cover;
        }
        .jc-request-actions {
            margin-top: 1em;
        }
        .jc-request-watch-btn {
          color: inherit;
          border: none;
          padding: 0.45em;
          border-radius: 50%;
          cursor: pointer;
          width: 36px;
          height: 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        }
        .jc-request-watch-btn:hover { opacity: 0.9; }
        .jc-request-watch-btn .material-icons { font-size: 20px; }
        .jc-request-approve-btn, .jc-request-decline-btn {
          border: none;
          padding: 0.45em;
          border-radius: 50%;
          cursor: pointer;
          width: 36px;
          height: 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px rgba(0,0,0,0.25);
          margin-left: 6px;
        }
        .jc-request-approve-btn { background: #4caf50; color: #fff; }
        .jc-request-decline-btn { background: #f44336; color: #fff; }
        .jc-request-approve-btn:hover { background: #43a047; }
        .jc-request-decline-btn:hover { background: #e53935; }
        .jc-request-approve-btn .material-icons,
        .jc-request-decline-btn .material-icons { font-size: 20px; }
        .jc-request-approve-btn:disabled,
        .jc-request-decline-btn:disabled { opacity: 0.5; cursor: default; }
        .jc-issues-section h2 {
          font-size: 1.5em;
          margin-bottom: 1em;
        }
        .jc-issue-card {
          display: flex;
          gap: 1em;
          padding: 1em;
          background: rgba(128,128,128,0.1);
          border-radius: 0.25em;
          overflow: visible;
        }
        .jc-issue-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.35em;
        }
        .jc-issue-title-row {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 0.4em;
          min-width: 0;
        }
        .jc-issue-title {
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
        }
        .jc-issue-summary {
          font-size: 0.85em;
          opacity: 0.8;
          display: flex;
          flex-wrap: wrap;
          gap: 0.4em;
          align-items: center;
          width: 100%;
        }
        .jc-issue-view-btn {
          background: transparent;
          border: none;
          color: inherit;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          opacity: 0.8;
          margin-left: auto;
          transition: opacity 0.2s;
        }
        .jc-issue-view-btn:hover { opacity: 1; }
        .jc-issue-view-btn.is-disabled { opacity: 0.35; cursor: not-allowed; }
        .jc-issue-view-btn .material-icons { font-size: 18px; }
        .jc-issue-message {
          font-size: 0.9em;
          opacity: 0.85;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .jc-issue-status-chip {
          font-size: 0.7em;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          padding: 0.25em 0.6em;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.12);
        }
        .jc-issue-status-open { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }
        .jc-issue-status-resolved { background: rgba(34, 197, 94, 0.25); color: #f0f9ff; border-color: rgba(34, 197, 94, 0.5); }
        .jc-issue-type-chip {
          font-size: 0.7em;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          padding: 0.25em 0.6em;
          border-radius: 999px;
          background: rgba(59, 130, 246, 0.25);
          border: 1px solid rgba(59, 130, 246, 0.5);
          color: #f0f9ff;
        }
        .jc-pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 1em;
            margin-top: 1.5em;
        }
        .jc-pagination .emby-button {
            background: transparent;
            border: 1px solid rgba(255,255,255,0.3);
            color: inherit;
            padding: 0.5em 1em;
            border-radius: 4px;
            cursor: pointer;
            opacity: 0.7;
            transition: all 0.2s;
        }
        .jc-pagination .emby-button:hover:not(:disabled) {
            opacity: 1;
            background: rgba(255,255,255,0.1);
        }
        .jc-pagination .emby-button:disabled { opacity: 0.3; cursor: not-allowed; }
        .jc-empty-state {
            text-align: center;
            padding: 3em;
            opacity: 0.5;
        }
        .jc-loading {
            display: flex;
            justify-content: center;
            padding: 2em;
        }
        .jc-requests-status-chip {
          display: inline-flex;
          align-items: center;
          padding: 0.3rem 0.6rem;
          margin-top: 0.7rem;
          border-radius: 999px;
          font-weight: 700;
          letter-spacing: 0.02em;
          font-size: 0.72rem;
          text-transform: uppercase;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .jc-requests-status-chip.jc-chip-available { background: rgba(34, 197, 94, 0.25); color: #f0f9ff; border-color: rgba(34, 197, 94, 0.5); }
        .jc-requests-status-chip.jc-chip-partial { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }
        .jc-requests-status-chip.jc-chip-processing { background: rgba(59, 130, 246, 0.25); color: #f0f9ff; border-color: rgba(59, 130, 246, 0.5); }
        .jc-requests-status-chip.jc-chip-requested { background: rgba(168, 85, 247, 0.25); color: #f0f9ff; border-color: rgba(168, 85, 247, 0.5); }
        .jc-requests-status-chip.jc-chip-pending { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }
        .jc-requests-status-chip.jc-chip-rejected,
        .jc-requests-status-chip.jc-chip-declined { background: rgba(248, 113, 113, 0.25); color: #f0f9ff; border-color: rgba(248, 113, 113, 0.5); }
        .jc-requests-status-chip.jc-chip-blocklisted { background: rgba(245, 158, 11, 0.25); color: #f0f9ff; border-color: rgba(245, 158, 11, 0.5); }
        .jc-requests-status-chip.jc-chip-deleted { background: rgba(220, 38, 38, 0.22); color: #ffe4e6; border-color: rgba(248, 113, 113, 0.55); }
        .jc-requests-status-chip.jc-chip-coming-soon { background: rgba(156, 39, 176, 0.25); color: #f0f9ff; border-color: rgba(156, 39, 176, 0.5); }
        .jc-release-date-chip {
          display: inline-flex;
          align-items: center;
          padding: 0.25rem 0.5rem;
          margin-left: 0.5rem;
          border-radius: 999px;
          font-weight: 600;
          letter-spacing: 0.02em;
          font-size: 0.68rem;
          text-transform: uppercase;
          background: rgba(156, 39, 176, 0.25);
          border: 1px solid rgba(156, 39, 176, 0.5);
          color: #f0f9ff;
        }
        .jc-release-date-icon { font-size: 1em; margin-right: 3px; vertical-align: middle; line-height: 1; }
        .jc-release-date-chip sup,
        .jc-requests-status-chip sup,
        .jc-request-title sup {
          font-size: 0.6em;
          opacity: 0.85;
          margin-bottom: 1em;
          margin-right: 0.25em;
          text-transform: lowercase;
        }
        .jc-refresh-btn:hover {
          opacity: 1 !important;
          background: rgba(255,255,255,0.1) !important;
        }
        .jc-downloads-controls {
          display: flex;
          flex-direction: column;
          gap: 1em;
          margin-bottom: 1.5em;
        }
        .jc-downloads-tabs {
          display: flex;
          gap: 0.5em;
          flex-wrap: wrap;
          align-items: center;
        }
        .jc-downloads-tab.emby-button {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.3);
          color: inherit;
          padding: 0.5em 1em;
          border-radius: 4px;
          cursor: pointer;
          opacity: 0.7;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          gap: 0.5em;
        }
        .jc-downloads-tab.emby-button:hover {
          opacity: 1;
          background: rgba(255,255,255,0.1);
        }
        .jc-downloads-tab.emby-button.active {
          opacity: 1;
        }
        .jc-downloads-search-toggle {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.3);
          color: inherit;
          padding: 0.5em;
          border-radius: 4px;
          cursor: pointer;
          opacity: 0.7;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
        }
        .jc-downloads-search-toggle:hover {
          opacity: 1;
          background: rgba(255,255,255,0.1);
        }
        .jc-downloads-search-toggle.active {
          opacity: 1;
          background: rgba(255,255,255,0.15);
        }
        .jc-downloads-search-toggle .material-icons {
          font-size: 20px;
        }
        .jc-downloads-tab-count {
          font-size: 0.8em;
          padding: 0.2em 0.5em;
          background: rgba(255,255,255,0.5);
          border-radius: 999px;
          min-width: 20px;
          text-align: center;
        }
        .jc-downloads-search-container {
          display: flex;
          align-items: center;
          gap: 0.5em;
          position: relative;
          width: 100%;
          animation: slideDown 0.2s ease-out;
        }
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .jc-downloads-search-icon {
          position: absolute;
          left: 0.7em;
          font-size: 20px;
          opacity: 0.5;
          pointer-events: none;
        }
        .jc-downloads-search-input {
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.2);
          color: inherit;
          padding: 0.6em 0.9em 0.6em 2.5em;
          border-radius: 4px;
          font-size: 0.9em;
          flex: 1;
          width: 100%;
          transition: all 0.2s;
        }
        .jc-downloads-search-input:focus {
          outline: none;
          border-color: rgba(255,255,255,0.4);
          background: rgba(255,255,255,0.12);
        }
        .jc-downloads-search-input:focus + .jc-downloads-search-icon {
          opacity: 0.7;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        /* Phone layout: the desktop page reserves 2em padding + 85vw max-width
           and lays cards out in a 340px-min grid — on a 360px phone that single
           column is wider than the content box and scrolls horizontally. Fill
           the width and drop to a single full-width card column. */
        @media (max-width: 768px) {
          .jc-downloads-page { padding: 0.75em; max-width: 100%; }
          .jc-downloads-grid { grid-template-columns: minmax(0, 1fr); }
        }
    `;

/**
 * Inject CSS styles
 */
export function injectStyles(): void {
    if (document.getElementById('jc-downloads-styles')) return;
    injectCss('jc-downloads-styles', CSS_STYLES);

    // Inject dynamic theme colors
    injectThemeColors();
}

/**
 * Inject dynamic theme colors
 */
function injectThemeColors(): void {
    const themeVars = JC.themer?.getThemeVariables?.() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';

    injectCss('jc-downloads-theme-colors', `
      .jc-requests-tab.emby-button.active,
      .jc-issues-tab.emby-button.active,
      .jc-downloads-tab.emby-button.active {
        background: ${primaryAccent} !important;
        border-color: ${primaryAccent} !important;
      }
      .jc-request-watch-btn {
        background: ${primaryAccent} !important;
      }
    `);
}
