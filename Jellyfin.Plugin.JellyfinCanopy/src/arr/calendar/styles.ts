// src/arr/calendar/styles.ts
// Calendar Page — CSS and theme-color injection (split from calendar-page.js).
// Owns the single injection site for the feature's styles; all former call
// sites import injectStyles, deduped by style id via core injectCss.

import { ensureMaterialSymbolsFont, injectCss } from '../../core/ui-kit';
import { JC } from '../arr-globals';

// CSS Styles. The shared Material Symbols @font-face lives in core/ui-kit
// (local asset cache) and is injected by injectStyles() below, not re-declared here.
const CSS_STYLES = `
    .material-symbols-rounded {
      font-family: 'Material Symbols Rounded';
      font-weight: normal;
      font-style: normal;
      font-size: 24px;
      line-height: 1;
      letter-spacing: normal;
      text-transform: none;
      display: inline-block;
      white-space: nowrap;
      word-wrap: normal;
      direction: ltr;
      -webkit-font-feature-settings: 'liga';
      -moz-font-feature-settings: 'liga';
      font-feature-settings: 'liga';
      -webkit-font-smoothing: antialiased;
    }

    .jc-calendar-page,
    .jellyfincanopy.calendar {
      --jc-gray: rgba(128,128,128,0.05);
      --jc-gray-hover: rgba(128,128,128,0.12);
    }

    .jc-calendar-page {
      padding: 2em;
      max-width: 95vw;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }

    #jc-calendar-page > [data-role="content"],
    #jc-calendar-page .content-primary.jc-calendar-page,
    .content-primary.jc-calendar-page {
      overflow: visible !important;
    }

    .jc-calendar-layout {
      display: flex;
      gap: 1.5em;
      align-items: flex-start;
      position: relative;
      overflow: visible;
    }

    .jc-calendar-main {
      flex: 1;
      min-width: 0;
      font-size: 1em;
    }

    .jc-calendar-sidebar {
      align-items: center;
      position: sticky;
      top: 6em;
      align-self: flex-start;
      display: flex;
      flex-direction: column;
      gap: 1em;
      height: max-content;
      overflow-y: auto;
      z-index: 2;
    }

    .jc-calendar-sidebar-toggle {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 0.35em;
      width: 100%;
      padding: 0.45em;
      border-radius: 999px;
      background: var(--jc-gray);
      border: 1px solid var(--jc-gray);
      color: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }

    .jc-calendar-sidebar-toggle:hover {
      background: var(--jc-gray-hover);
    }

    .jc-calendar-sidebar-toggle-icon {
      font-size: 18px;
      transition: transform 0.2s ease;
    }

    .jc-calendar-sidebar:not(.is-collapsed) .jc-calendar-sidebar-toggle-icon {
      transform: rotate(180deg);
    }

    .jc-calendar-sidebar-content {
      width: 100%;
      display: flex;
    }


    .jc-calendar-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2em;
      padding-top: 2em;
      flex-wrap: wrap;
      gap: 1em;
      position: relative;
    }

    .jc-calendar-title {
      font-size: 2em;
      font-weight: 600;
      margin: 0;
    }

    .jc-calendar-actions {
      display: flex;
      gap: 1em;
      align-items: center;
      flex-wrap: wrap;
    }

    .jc-calendar-actions-center {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
    }

    .jc-calendar-actions-right {
      margin-left: auto;
    }

    .jc-calendar-nav {
      display: inline-flex;
      gap: 0.5em;
      align-items: center;
      margin-bottom: 0.1em;
    }

    .jc-calendar-nav-group {
      display: inline-flex;
      align-items: center;
      gap: 1em;
    }

    .jc-calendar-mode-toggle,
    .jc-calendar-filter-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.15em;
      padding: 0.2em;
      border-radius: 999px;
      background: var(--jc-gray);
      border: 1px solid var(--jc-gray);
    }

    .jc-calendar-mode-toggle.is-disabled,
    .jc-calendar-filter-toggle.is-disabled {
      opacity: 0.5;
      pointer-events: none;
    }

    .jc-calendar-mode-btn,
    .jc-calendar-filter-btn {
      background: transparent;
      border: none;
      color: inherit;
      padding: 0.35em 0.6em;
      border-radius: 999px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0.75;
      transition: all 0.15s ease;
      font-weight: 600;
      font-size: 0.85em;
      letter-spacing: 0.02em;
    }

    .jc-calendar-mode-btn:hover,
    .jc-calendar-filter-btn:hover {
      opacity: 1;
      background: var(--jc-gray-hover);
    }

    .jc-calendar-mode-btn.active,
    .jc-calendar-filter-btn.active {
      opacity: 1;
      background: var(--jc-gray-hover);
    }


    .jc-calendar-card {
      cursor: pointer;
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--jc-gray);
      border-radius: 8px;
      box-sizing: border-box;
      border-bottom: 3px solid transparent;
      min-width: 0;
      max-width: 100%;
      position: relative;
      align-items: center;
      text-align: center;
      gap: 0.35em;
      overflow: hidden;
      transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
    }

    .jc-calendar-card:hover {
      transform: translateY(-2px);
      background: var(--jc-gray-hover);
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.25);
    }

    .jc-calendar-card-meta {
      font-size: 0.8em;
      opacity: 0.85;
      display: flex;
      flex-wrap: wrap;
      gap: 0.35em;
      align-items: center;
      justify-content: center;
      text-align: center;
      margin-top: auto;
    }

    .jc-calendar-card-meta .jc-arr-badge {
      font-size: 0.9em;
    }

    .jc-calendar-card-meta img {
      width: 12px;
      height: 12px;
      object-fit: contain;
    }

    .jc-calendar-day-cards {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.5em;
      grid-auto-rows: 1fr;
      align-items: stretch;
      min-width: 0;
    }

    .jc-calendar-page.jc-view-week .jc-calendar-day-cards,
    .jc-calendar-page.jc-view-month .jc-calendar-day-cards {
      justify-items: center;
    }

    .jc-calendar-page.jc-view-week .jc-calendar-day-cards > .jc-calendar-card,
    .jc-calendar-page.jc-view-month .jc-calendar-day-cards > .jc-calendar-card {
      width: 100%;
      max-width: 100%;
    }

    .jc-calendar-card-image {
      width: 100%;
      height: auto;
      aspect-ratio: 2 / 3;
      max-height: 18em;
      object-fit: cover;
      border-radius: 0;
      display: block;
      flex-shrink: 0;
      max-width: 100%;
    }

    .jc-calendar-card-image-wrap {
      position: relative;
      width: 100%;
    }

    .jc-calendar-card-overlay {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 0.6em;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.2em;
      text-align: center;
      color: #fff;
      background: linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.25))
    }

    .jc-calendar-card-overlay .jc-calendar-card-title,
    .jc-calendar-card-overlay .jc-calendar-card-subtitle,
    .jc-calendar-card-overlay .jc-calendar-card-meta {
      text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    }

    .jc-calendar-card-overlay .jc-calendar-card-meta {
      font-size: 0.75em;
    }

    .jc-calendar-card-title {
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1.15;
      height: 3em;
      padding: 0 0.2em;
      width: 100%;
      overflow: hidden;
    }

    .jc-calendar-card-title-text {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.15;
      max-height: 3em;
      width: 100%;
      font-size: clamp(1.05em, 0.6vw + 0.9em, 1.3em);
      white-space: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
      hyphens: auto;
    }

    .jc-calendar-card-subtitle {
      font-size: 0.95em;
      opacity: 0.75;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.2;
      height: 1.4em;
      max-width: 100%;
    }

    .jc-calendar-card-time {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      align-self: center;
      padding: 0 0.6em;
      border-radius: 999px;
      background: rgba(0,0,0,0.55);
      font-size: 0.9em;
      font-weight: 600;
      letter-spacing: 0.01em;
      line-height: 1;
      height: 1.6em;
      box-sizing: border-box;
    }

    .jc-calendar-card-time.is-unavailable {
      padding: 0 0.85em;
    }

    .jc-calendar-card-time.is-available {
      background: rgba(76, 175, 80, 0.85);
      cursor: pointer;
    }

    .jc-calendar-card-time.is-past {
      background: rgba(255, 152, 0, 0.85);
    }

    .jc-calendar-card-time.is-late {
      background: rgba(244, 67, 54, 0.85);
    }

    .jc-calendar-card-time-row {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .jc-calendar-card-status-top {
      position: absolute;
      top: 0.45em;
      right: 0.45em;
      display: inline-flex;
      align-items: center;
      gap: 0.25em;
      z-index: 2;
      padding: 0.2em 0.35em;
      border-radius: 999px;
      background: rgba(0,0,0,0.6);
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
      backdrop-filter: blur(4px);
    }

    .jc-calendar-event-type .jc-calendar-card-time,
    .jc-calendar-event-type .jc-calendar-card-time-row {
      margin-top: 0;
    }

    .jc-calendar-day-cards > .jc-calendar-card {
      height: 100%;
    }

    .jc-calendar-nav-btn,
    .jc-calendar-view-btn {
      background: var(--jc-gray);
      border: 1px solid var(--jc-gray);
      color: inherit;
      padding: 0.45em 0.9em;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      font-weight: 600;
    }

    .jc-calendar-nav-btn {
      height: 2.2em;
      min-width: 2.2em;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border-radius: 999px;
      font-size: 1em;
    }

    .jc-calendar-nav-btn.jc-calendar-nav-today {
      padding: 0 1em;
      min-width: auto;
      font-size: 0.95em;
      border-radius: 999px;
    }

    .jc-calendar-nav-btn:hover,
    .jc-calendar-view-btn:hover {
      background: var(--jc-gray-hover);
    }

    .jc-calendar-month-grid,
    .jc-calendar-grid,
    .jc-calendar-weekdays,
    .jc-calendar-dayline {
      display: grid;
      grid-template-columns: repeat(7, minmax(150px, 1fr));
      gap: 1em;
    }

    .jc-calendar-weekday {
      text-align: center;
      font-weight: 600;
      padding: 0.5em;
      opacity: 0.8;
    }

    .jc-calendar-dayline .jc-calendar-event {
      width: 100%;
    }

    .jc-calendar-day-hours {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
    }

    .jc-calendar-hour-row {
      display: grid;
      grid-template-columns: 90px 1fr;
      gap: 0.75em;
      align-items: flex-start;
    }

    .jc-calendar-hour-label {
      font-weight: 600;
      opacity: 0.75;
      text-align: right;
      padding-top: 0.2em;
      font-size: 0.9em;
      white-space: nowrap;
    }

    .jc-calendar-hour-events {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
      min-width: 0;
    }

    .jc-calendar-day {
      background: var(--jc-gray);
      border-radius: 0.5em;
      min-height: 150px;
      border: 1px solid var(--jc-gray);
      min-width: 0;
    }

    .jc-calendar-day.jc-calendar-today {
      border-color: var(--jc-gray);
      box-shadow: none;
    }

    .jc-calendar-day.jc-calendar-today .jc-calendar-day-number,
    .jc-calendar-day.jc-calendar-today .jc-calendar-day-name {
      color: inherit;
    }

    .jc-calendar-day-header {
      font-weight: 600;
      text-align: center;
      padding: 0.5em;
      border-bottom: 1px solid var(--jc-gray);
    }

    .jc-calendar-day-number {
      display: inline-block;
      font-size: 1.2em;
      font-weight: 700;
    }

    .jc-calendar-day-name {
      display: block;
      font-size: 0.85em;
      opacity: 0.7;
      margin-top: 0.25em;
    }

    .jc-calendar-month-day-name {
      display: none;
      font-size: 0.75em;
      opacity: 0.7;
      margin-top: 0.2em;
    }

    .jc-calendar-events-list {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
    }

    .jc-calendar-event {
      padding: 0.5em;
      border-radius: 0.25em;
      font-size: 0.85em;
      cursor: pointer;
      transition: all 0.2s;
      border-left: 3px solid;
      padding-left: 0.7em;
      position: relative;
      color: #f5f5f5;
      text-shadow: 0 1px 2px rgba(0,0,0,0.85);
    }

    .jc-calendar-event:hover {
      transform: translateX(2px);
      opacity: 0.9;
    }

    .jc-calendar-event.jc-has-file:hover {
      box-shadow: 0 0 8px rgba(76, 175, 80, 0.4);
    }

    .jc-calendar-status-icons {
      display: inline-flex;
      align-items: center;
      gap: 0.25em;
    }

    .jc-calendar-status-icon {
      font-size: 22px;
      line-height: 1;
    }

    .jc-calendar-status-icon.jc-status-watchlist {
      color: #ffd700;
      font-variation-settings: 'FILL' 1;
    }

    .jc-calendar-status-icon.jc-status-watched {
      color: #64b5f6;
    }

    .jc-calendar-agenda-indicators .jc-calendar-status-icon {
      font-size: 22px;
    }

    .jc-calendar-play-btn {
      background: #4caf50;
      border: none;
      color: white;
      padding: 0;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: 0.35em;
      border-radius: 50%;
      width: 24px;
      height: 24px;
    }

    .jc-calendar-play-btn-card {
      width: 24px;
      height: 24px;
    }

    .jc-calendar-play-btn .material-icons {
      font-size: 14px;
    }

    .jc-calendar-event-status-top {
      position: absolute;
      top: 0.35em;
      right: 0.35em;
      display: inline-flex;
      align-items: center;
      gap: 0.2em;
      z-index: 2;
      padding: 0.12em 0.3em;
      border-radius: 999px;
      background: rgba(0,0,0,0.45);
      backdrop-filter: blur(2px);
    }

    .jc-calendar-event-status-top .jc-calendar-status-icon {
      font-size: 12px;
    }

    .jc-calendar-event-title {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }

    .jc-calendar-event-subtitle {
      font-size: 0.8em;
      opacity: 0.75;
      display: block;
      margin-top: 0.2em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .jc-calendar-event-type {
      font-size: 0.75em;
      opacity: 0.85;
      margin-top: 0.35em;
      display: flex;
      align-items: center;
      gap: 0.5em;
      flex-wrap: wrap;
      width: fit-content;
    }

    .jc-calendar-event-type img {
      width: 12px;
      height: 12px;
      object-fit: contain;
    }

    .jc-calendar-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5em;
      margin-top: 2em;
      padding: 1em;
      background: var(--jc-gray);
      border-radius: 0.5em;
    }

    .jc-calendar-legend.jc-calendar-legend-vertical {
      flex-direction: column;
      gap: 0.6em;
      margin-top: 0;
      padding: 0.75em;
    }

    .jc-calendar-filter-controls {
      display: flex;
      gap: 0.5em;
      align-items: center;
      flex-wrap: wrap;
      width: 100%;
      justify-content: center;
    }

    .jc-calendar-filter-invert {
      background: var(--jc-gray);
      border: 1px solid var(--jc-gray);
      color: inherit;
      padding: 0.3em 0.7em;
      border-radius: 999px;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.85em;
      opacity: 0.8;
      transition: all 0.15s ease;
    }

    .jc-calendar-filter-invert.is-disabled {
      opacity: 0.5;
      pointer-events: none;
    }

    .jc-calendar-filter-invert.active {
      opacity: 1;
      background: var(--jc-gray-hover);
    }

    .jc-calendar-mode-toggle {
      justify-content: center;
    }

    .jc-calendar-legend-item {
      display: flex;
      align-items: center;
      gap: 0.5em;
      font-size: 0.9em;
      padding: 0.5em 0.75em;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;
      border: 2px solid transparent;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
    }

    .jc-calendar-legend-item:hover {
      background: var(--jc-gray-hover);
    }

    .jc-calendar-legend-item.inactive {
      opacity: 0.4;
    }

    .jc-calendar-empty {
      text-align: center;
      padding: 2em;
      opacity: 0.7;
    }

    .jc-calendar-agenda {
      display: flex;
      flex-direction: column;
      gap: 0;
      padding-left: 1em;
      overflow-x: hidden;
    }

    .jc-calendar-agenda-row {
      display: flex;
      border-bottom: 1px solid var(--jc-gray);
      padding: 0.75em 0;
      align-items: flex-start;
      gap: 0.5em;
      max-width: 100%;
    }

    .jc-calendar-agenda-row:hover {
      background: var(--jc-gray-hover);
    }

    .jc-calendar-agenda-date {
      min-width: 140px;
      flex-shrink: 0;
      padding: 0.5em;
      font-weight: 600;
      font-size: 0.95em;
      opacity: 0.85;
    }

    .jc-calendar-agenda-events {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.75em;
    }

    .jc-calendar-agenda-event {
      display: flex;
      align-items: center;
      gap: 0.75em;
      cursor: default;
      padding: 0.5em;
      border-radius: 4px;
      box-sizing: border-box;
    }

    .jc-calendar-agenda-event.jc-has-file {
      cursor: pointer;
    }

    .jc-calendar-agenda-event.jc-has-file:hover {
      background: rgba(76, 175, 80, 0.1);
    }

    .jc-calendar-agenda-indicators {
      display: flex;
      align-items: center;
      gap: 0.25em;
      min-width: 70px;
      flex-direction: row-reverse;
      flex-shrink: 0;
    }

    .jc-calendar-agenda-event-marker {
      width: 4px;
      height: 36px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .jc-calendar-agenda-event-content {
      flex: 1;
      min-width: 0;
    }

    .jc-calendar-agenda-title-text {
      font-weight: 600;
    }

    .jc-calendar-agenda-subtitle {
      opacity: 0.8;
    }

    .jc-calendar-agenda-event-meta {
      display: flex;
      align-items: center;
      gap: 0.5em;
      margin-top: 0.25em;
      font-size: 0.85em;
      opacity: 0.8;
      flex-wrap: wrap;
    }

    .jc-calendar-agenda-event-meta img {
      width: 14px;
      height: 14px;
      object-fit: contain;
    }

    .jc-calendar-agenda-event-title {
      display: flex;
      flex-direction: column;
      gap: 0.15em;
      min-width: 0;
    }

    .jc-calendar-agenda-title-text,
    .jc-calendar-agenda-subtitle {
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: normal;
      line-height: 1.2;
      max-height: 1.2em;
      min-width: 0;
    }

    @media (max-width: 1340px) {
      .jc-calendar-month-grid,
      .jc-calendar-grid,
      .jc-calendar-weekdays,
      .jc-calendar-dayline {
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      }
    }

    @media (max-width: 1450px) {
      .jc-calendar-page {
        padding: 1em;
      }

      .jc-calendar-header {
        flex-direction: column;
        align-items: flex-start;
        margin-bottom: 0.5em;
      }

      .jc-calendar-title {
        font-size: 1.5em;
      }

      .jc-calendar-actions {
        width: 100%;
        flex-direction: column;
      }

      .jc-calendar-nav {
        justify-content: center;
        flex-wrap: wrap;
      }

      .jc-calendar-month-grid,
      .jc-calendar-grid,
      .jc-calendar-weekdays,
      .jc-calendar-dayline {
        gap: 0.5em;
      }

      .jc-calendar-day {
        min-height: 120px;
        padding: 0.5em;
      }

      .jc-calendar-legend {
        gap: 1em;
      }

      .jc-calendar-layout {
        flex-direction: column;
        width: 100%;
      }

      .jc-calendar-sidebar {
        position: unset;
        top: 1em;
        width: 100%;
        flex-direction: row;
        flex-wrap: nowrap;
        justify-content: space-between;
        align-items: center;
        order: -1;
      }

      .jc-calendar-main {
        width: 100%;
      }

      .jc-calendar-sidebar .jc-calendar-legend {
        flex: 1 1 auto;
        margin-top: 0;
      }

      .jc-calendar-legend.jc-calendar-legend-vertical {
        flex-direction: row;
        flex-wrap: wrap;
        gap: 1em;
        width: 100%;
        justify-content: space-around;
      }

      .jc-calendar-month .jc-calendar-weekdays {
        display: none;
      }

      .jc-calendar-month .jc-calendar-month-day-name {
        display: block;
      }

      .jc-calendar-month .jc-calendar-day-placeholder {
        display: none;
      }
    }

    @media (max-width: 768px) {
      .jc-calendar-actions-center {
        position: static;
        transform: none;
      }

      .jc-calendar-actions-right {
        margin-left: 0;
      }
      .jc-calendar-page {
        padding: 0.25em;
        max-width: 100vw;
      }

      .jc-calendar-main {
        overflow-x: hidden;
      }

      .jc-calendar-nav-btn,
      .jc-calendar-view-btn {
        padding: 0.35em 0.6em;
        font-size: 0.85em;
      }

      .jc-calendar-nav-btn {
        height: 1.9em;
        min-width: 1.9em;
        padding: 0;
      }

      .jc-calendar-nav-btn.jc-calendar-nav-today {
        padding: 0 0.8em;
      }

      .jc-calendar-day {
        min-height: 80px;
        min-width: 0;
        padding: 0.15em;
      }

      .jc-calendar-hour-row {
        grid-template-columns: 70px 1fr;
      }

      .jc-calendar-hour-label {
        text-align: left;
      }

      .jc-calendar-month .jc-calendar-weekdays {
        display: none;
      }

      .jc-calendar-agenda-row {
        flex-direction: column;
        gap: 0.5em;
      }

      .jc-calendar-agenda-date {
        min-width: auto;
      }

      .jc-calendar-agenda-event {
        gap: 0.5em;
      }

      .jc-calendar-legend {
        gap: 0.5em;
        font-size: 0.8em;
        padding: 0.75em;
      }

      .jc-calendar-legend-item {
        flex: 1 1 45%;
      }

      .jc-calendar-sidebar {
        width: 100%;
        flex-direction: column;
        align-items: stretch;
        gap: 0.5em;
      }

      .jc-calendar-sidebar-toggle {
        display: inline-flex;
        align-self: stretch;
      }

      .jc-calendar-sidebar-content {
        max-height: 1000px;
        opacity: 1;
        overflow: hidden;
        transition: max-height 0.25s ease, opacity 0.2s ease;
      }

      .jc-calendar-sidebar.is-collapsed .jc-calendar-sidebar-content {
        max-height: 0;
        opacity: 0;
        pointer-events: none;
      }

      .jc-calendar-sidebar.is-collapsed .jc-calendar-legend {
        padding: 0;
        border-width: 0;
      }
    }
  `;

// Inject CSS styles into page
export function injectStyles(): void {
    // Shared icon font (consolidated @font-face; served from the local asset cache).
    ensureMaterialSymbolsFont();
    if (document.getElementById("jc-calendar-styles")) return;
    injectCss("jc-calendar-styles", CSS_STYLES);

    // Inject dynamic theme colors
    injectThemeColors();
}

// Inject dynamic theme colors
function injectThemeColors(): void {
    const themeVars = JC.themer?.getThemeVariables?.() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';

    injectCss("jc-calendar-theme-colors", `
      .jc-calendar-view-btn.active {
        background: ${primaryAccent} !important;
        border-color: ${primaryAccent} !important;
      }
      .jc-calendar-legend-item.active {
        border-color: ${primaryAccent} !important;
      }
      .jc-calendar-day.jc-calendar-today {
        border-color: var(--jc-gray) !important;
        box-shadow: none;
      }
      .jc-calendar-day.jc-calendar-today .jc-calendar-day-number,
      .jc-calendar-day.jc-calendar-today .jc-calendar-day-name {
        color: ${primaryAccent} !important;
      }
    `);
}
