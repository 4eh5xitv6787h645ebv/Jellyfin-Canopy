// src/enhanced/bookmarks/library-styles.ts
//
// Bookmarks Library View — styles.
// Split from bookmarks-library.js (code motion; CSS block verbatim).
// Creates <div class="sections bookmarks"></div> for CustomTabs plugin
// (see bookmarks/library-init.ts for the boot sequence).
// (Converted from js/enhanced/bookmarks-library-styles.js — bodies semantically identical.)

import { JC } from "../../globals";

if (!JC.pluginConfig?.BookmarksEnabled) {
  console.log("🪼 Jellyfin Canopy: Bookmarks library feature is disabled");
} else {
  // Inject custom styles
  const style = document.createElement("style");
  style.textContent = `
    .jc-bookmarks-wrapper {
      display: flex;
      flex-direction: column;
      gap: 0;
      width: 100%;
    }

    .jc-bookmark-tabs {
      display: flex;
      justify-content: center;
      gap: 2px;
      padding: 12px 3vw 8px 3vw;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .jc-tab {
      padding: 12px 16px;
      background: transparent;
      color: rgba(200, 200, 200, .7);
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      border-radius: 10px 10px 0 0;
    }

    .jc-tab:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .jc-tab.active {
      color: rgba(200, 200, 200, 1);
      background: rgba(200, 200, 200, 0.1);
      border-bottom-color: #fff;
    }

    .bookmarks-container {
      padding: 12px 3vw;
    }

    .jc-bookmarks-empty {
      text-align: center;
      padding: 60px 20px;
      color: #888;
    }

    .jc-bookmarks-empty-icon {
      font-size: 32px;
      margin-bottom: 12px;
      opacity: 0.6;
    }

    .jc-bookmarks-empty-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .jc-bookmarks-empty-hint {
      font-size: 14px;
    }

    .jc-bookmarks-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
      width: 100%;
    }

    .jc-bookmark-item {
      background: rgba(0, 0, 0, 0.32);
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: 0 6px 12px rgba(0, 0, 0, 0.35);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .jc-bookmark-item-orphaned {
      border: 2px solid rgba(255, 193, 7, 0.5);
      background: rgba(255, 193, 7, 0.03);
    }

    .jc-bookmark-item-header {
      display: flex;
      gap: 14px;
      padding: 12px 14px;
      align-items: flex-start;
      position: relative;
    }

    .jc-offset-icon {
      position: absolute;
      top: 12px;
      right: 14px;
      background: rgba(33, 150, 243, 0.15);
      border: 1px solid rgba(33, 150, 243, 0.3);
      color: #2196f3;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
      font-size: 18px;
    }

    .jc-offset-icon:hover {
      background: rgba(33, 150, 243, 0.25);
      border-color: rgba(33, 150, 243, 0.5);
      transform: scale(1.1);
    }

    /* Modal styles */
    .jc-bm-library-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.85);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.2s;
    }

    .jc-bm-library-modal-container {
      background: #181818;
      border-radius: 12px;
      padding: 24px;
      position: relative;
      box-shadow: 0 8px 32px rgba(0,0,0,0.8);
    }

    .jc-bm-library-modal-close {
      position: absolute;
      top: 16px;
      right: 16px;
      background: transparent;
      border: none;
      color: #fff;
      font-size: 32px;
      cursor: pointer;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      transition: background 0.2s;
    }

    .jc-bm-library-modal-close:hover {
      background: rgba(255,255,255,0.1);
    }

    .jc-bookmarks-modal-header {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 24px;
    }

    .jc-modal-title {
      margin: 0 0 8px 0;
      font-size: 24px;
      font-weight: 700;
      color: #fff;
    }

    .jc-modal-subtitle {
      margin: 0;
      font-size: 13px;
      color: #aaa;
    }

    .jc-modal-info-box {
      background: rgba(33, 150, 243, 0.08);
      border: 2px solid rgba(33, 150, 243, 0.3);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }

    .jc-modal-info-title {
      font-size: 12px;
      color: #64b5f6;
      margin-bottom: 8px;
    }

    .jc-modal-info-text {
      font-size: 12px;
      color: #ccc;
      line-height: 1.4;
    }

    .jc-modal-warning-box {
      background: rgba(255,152,0,0.08);
      border: 2px solid rgba(255,152,0,0.3);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }

    .jc-modal-warning-label {
      font-size: 12px;
      font-weight: 700;
      color: #ff9800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .jc-modal-item-name {
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 6px;
    }

    .jc-modal-item-meta {
      font-size: 12px;
      color: #ccc;
    }

    .jc-modal-label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
      color: #e0e0e0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .jc-modal-input {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid rgba(33, 150, 243, 0.3);
      border-radius: 8px;
      background: rgba(255,255,255,0.05);
      color: #fff;
      font-family: inherit;
      font-size: 15px;
      transition: all 0.2s;
      box-sizing: border-box;
    }

    .jc-modal-input:focus {
      outline: none;
      border-color: rgba(33, 150, 243, 0.5);
    }

    .jc-modal-help-text {
      font-size: 12px;
      color: #999;
      margin-top: 6px;
      line-height: 1.4;
    }

    .jc-modal-list-container {
      background: rgba(255,255,255,0.03);
      border-radius: 8px;
      padding: 12px;
      max-height: 200px;
      overflow-y: auto;
    }

    .jc-modal-list-title {
      font-size: 12px;
      font-weight: 600;
      color: #aaa;
      margin-bottom: 8px;
      text-transform: uppercase;
    }

    .jc-modal-list-item {
      font-size: 13px;
      color: #e0e0e0;
      padding: 6px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }

    .jc-modal-list-item-title {
      font-weight: 600;
    }

    .jc-modal-list-item-meta {
      font-size: 11px;
      color: #999;
    }

    .jc-bookmark-modal-actions {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid rgba(255,255,255,0.08);
    }

    .jc-bookmark-btn-cancel {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 20px;
      background: rgba(255, 255, 255, 0.05);
      color: #aaa;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
    }

    .jc-bookmark-btn-cancel:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .jc-modal-btn-primary {
      padding: 10px 20px;
      background: rgba(33, 150, 243, 0.2);
      color: #2196f3;
      border: 1px solid rgba(33, 150, 243, 0.3);
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .jc-modal-btn-primary:hover {
      background: rgba(33, 150, 243, 0.3);
    }

    .jc-modal-btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .jc-btn-find-replacement {
      position: absolute;
      top: 12px;
      right: 14px;
      background: rgba(255, 152, 0, 0.15);
      border: 1px solid rgba(255, 152, 0, 0.3);
      color: #ff9800;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
      font-size: 18px;
    }

    .jc-btn-find-replacement:hover {
      background: rgba(255, 152, 0, 0.25);
      border-color: rgba(255, 152, 0, 0.5);
      transform: scale(1.1);
    }

    .jc-bookmark-item-poster {
      width: 86px;
      height: 129px;
      object-fit: cover;
      border-radius: 6px;
      cursor: pointer;
      flex-shrink: 0;
    }

    .jc-bookmark-item-placeholder {
      width: 86px;
      height: 129px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #b0bec5;
      font-size: 13px;
      flex-shrink: 0;
    }

    .jc-bookmark-item-info {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .jc-bookmark-item-title {
      color: #e3f2fd;
      font-size: 18px;
      font-weight: 700;
      text-decoration: none;
      display: block;
    }

    .jc-bookmark-item-title:hover {
      color: #fff;
    }

    .jc-bookmark-item-meta {
      color: #90a4ae;
      font-size: 13px;
    }

    .jc-bookmarks-list {
      display: grid;
      gap: 8px;
      padding: 0 14px 12px 14px;
    }

    .jc-bookmark-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .jc-bookmark-main {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .jc-bookmark-bar {
      width: 2px;
      height: 32px;
      background: rgb(30, 144, 255);
      border-radius: 2px;
    }

    .jc-bookmark-info {
      flex: 1;
    }

    .jc-bookmark-label {
      font-size: 15px;
      color: #eceff1;
      font-weight: 600;
    }

    .jc-bookmark-time {
      font-size: 13px;
      color: #b0bec5;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .jc-bookmark-time:hover {
      color: #ccc;
    }

    .jc-bookmark-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .jc-btn {
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 5px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s;
      font-size: 12px;
    }

    .jc-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .jc-btn-delete {
      background: rgba(200, 40, 40, 0.12);
      color: #ff6b6b;
      border-color: rgba(200, 40, 40, 0.25);
    }

    .jc-btn-delete:hover {
      background: rgba(200, 40, 40, 0.18);
      border-color: rgba(200, 40, 40, 0.35);
    }

    .jc-btn-edit-row {
      display: none;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      padding-left: 20px;
    }

    .jc-btn-edit-row.show {
      display: flex;
    }

    .jc-input {
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.04);
      color: #fff;
      font-size: 13px;
    }

    .jc-input::placeholder {
      color: #777;
    }

    .jc-input-label {
      min-width: 200px;
      flex: 1;
    }

    .jc-btn-action {
      padding: 8px 14px;
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 5px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
      font-size: 13px;
    }

    .jc-btn-action:hover {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.3);
    }

    .jc-btn-cancel {
      background: rgba(255, 255, 255, 0.05);
      color: #aaa;
      border-color: rgba(255, 255, 255, 0.1);
    }

    .jc-btn-cancel:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .jc-bookmark-actions-footer {
      display: flex;
      gap: 12px;
      justify-content: center;
      padding: 24px 0 12px 0;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      margin-top: 24px;
    }

    .jc-btn-footer {
      padding: 10px 18px;
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      transition: all 0.2s;
    }

    .jc-btn-footer:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    .jc-btn-footer-delete {
      background: rgba(200, 40, 40, 0.15);
      color: #ff6b6b;
      border-color: rgba(200, 40, 40, 0.3);
    }

    .jc-btn-footer-delete:hover {
      background: rgba(200, 40, 40, 0.22);
    }

    /* Replacement modal specific */
    .jc-replacement-modal-container {
      max-width: 650px;
      background: linear-gradient(135deg, rgba(20,20,30,0.95) 0%, rgba(25,25,35,0.95) 100%);
      border: 1px solid rgba(76,175,80,0.3);
    }

    .jc-replacement-section-title {
      font-size: 13px;
      font-weight: 700;
      color: #4caf50;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }

    .jc-replacement-options {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 24px;
    }

    .replacement-option {
      display: flex;
      gap: 12px;
      background: rgba(76,175,80,0.05);
      border: 2px solid rgba(76,175,80,0.2);
      border-radius: 8px;
      padding: 12px;
      cursor: pointer;
      transition: all 0.2s;
      align-items: center;
    }

    .replacement-option:hover {
      background: rgba(76,175,80,0.1);
      border-color: rgba(76,175,80,0.4);
    }

    .replacement-option.selected {
      background: rgba(76,175,80,0.15);
      border-color: #4caf50;
    }

    .replacement-option img {
      width: 60px;
      height: 90px;
      object-fit: cover;
      border-radius: 6px;
      flex-shrink: 0;
    }

    .replacement-option-placeholder {
      width: 60px;
      height: 90px;
      background: rgba(255,255,255,0.05);
      border-radius: 6px;
      flex-shrink: 0;
    }

    .replacement-option-info {
      flex: 1;
    }

    .replacement-option-name {
      font-weight: 600;
      margin-bottom: 4px;
      color: #fff;
      font-size: 15px;
    }

    .replacement-option-meta {
      font-size: 12px;
      color: #aaa;
    }

    .replacement-option-check {
      color: #4caf50;
      font-size: 28px;
      display: none;
      flex-shrink: 0;
    }

    .replacement-option.selected .replacement-option-check {
      display: block;
    }

    .jc-modal-actions-padded {
      padding: 0 28px 28px 28px;
      display: flex;
      gap: 12px;
      justify-content: flex-end;
    }

    .jc-modal-btn-submit {
      padding: 10px 24px;
      background: linear-gradient(135deg, #4caf50 0%, #45a049 100%);
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 700;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .jc-modal-btn-submit:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .jc-modal-btn-submit:not(:disabled):hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(76,175,80,0.3);
    }

    .jc-modal-btn-cancel-alt {
      padding: 10px 20px;
      background: rgba(255,255,255,0.08);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.2s;
    }

    /* Episode title formatting */
    .jc-episode-title {
      font-size: 0.85em;
      font-weight: normal;
      color: #b0bec5;
    }

    /* Orphaned results list */
    .jc-orphaned-results {
      margin-top: 20px;
      max-height: 400px;
      overflow-y: auto;
    }

    .jc-orphaned-result-item {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 12px;
    }

    .jc-orphaned-result-header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 10px;
    }

    .jc-orphaned-result-name {
      font-weight: 600;
      color: #ff9800;
      margin-bottom: 4px;
    }

    .jc-orphaned-result-count {
      font-size: 12px;
      color: #aaa;
    }

    .jc-orphaned-result-meta {
      font-size: 11px;
      color: #666;
      padding: 8px;
      background: rgba(0,0,0,0.3);
      border-radius: 4px;
    }

    .btnMigrateOrphaned {
      background: rgba(76, 175, 80, 0.15);
      border-color: #4caf50;
      color: #4caf50;
    }

    /* Duplicates modal */
    .jc-duplicates-modal-container {
      max-width: 700px;
      max-height: 85vh;
      overflow-y: auto;
    }

    .jc-duplicate-item {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }

    .jc-duplicate-name {
      font-weight: 600;
      margin-bottom: 12px;
      color: #ff9800;
    }

    .jc-duplicate-meta {
      font-size: 12px;
      color: #888;
      margin-bottom: 12px;
    }

    .jc-duplicate-version {
      background: rgba(255,255,255,0.02);
      padding: 8px 12px;
      margin-bottom: 8px;
      border-radius: 4px;
    }

    .jc-duplicate-version-primary {
      border-left: 3px solid #4caf50;
    }

    .jc-duplicate-version-secondary {
      border-left: 3px solid #ff9800;
    }

    .jc-duplicate-version-label {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 4px;
    }

    .jc-duplicate-version-primary .jc-duplicate-version-label {
      color: #4caf50;
    }

    .jc-duplicate-version-secondary .jc-duplicate-version-label {
      color: #ff9800;
    }

    .jc-duplicate-version-id {
      font-size: 11px;
      color: #999;
    }

    .jc-duplicate-version-id code {
      background: rgba(0,0,0,0.3);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
    }

    .btnMergeDuplicates {
      margin-top: 8px;
      background: rgba(255, 152, 0, 0.15);
      border-color: #ff9800;
      color: #ff9800;
    }

    .jc-bookmarks-wrapper .material-icons {
      font-size: 18px;
    }
  `;
  document.head.appendChild(style);
}
