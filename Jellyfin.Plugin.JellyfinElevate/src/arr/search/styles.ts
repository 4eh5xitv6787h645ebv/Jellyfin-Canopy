// src/arr/search/styles.ts
//
// Injected CSS for the arr Search modals. Matches the established JE modal aesthetic
// (dark overlay + gradient dialog, --primary-accent-color for accents) used by the
// spoiler-guard confirm dialog and the Seerr modals, so the picker looks native to JE.

import { JE } from '../../globals';

const CSS = `
.je-arr-modal-overlay {
    position: fixed; inset: 0; z-index: 100001;
    background: rgba(0,0,0,0.7); backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    padding: 2vh 2vw;
}
.je-arr-modal {
    background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    color: #fff;
    width: 760px; max-width: 100%;
    max-height: 92vh;
    display: flex; flex-direction: column;
    box-shadow: 0 24px 64px rgba(0,0,0,0.5);
}
.je-arr-modal-header {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    padding: 18px 20px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
}
.je-arr-modal-titles { min-width: 0; }
.je-arr-modal-title {
    margin: 0; font-size: 18px; font-weight: 600;
    display: flex; align-items: center; gap: 8px;
}
.je-arr-modal-title-icon { font-size: 22px; color: var(--primary-accent-color, #b9a6ff); }
.je-arr-modal-subtitle {
    margin-top: 2px; font-size: 13px; color: rgba(255,255,255,0.6);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.je-arr-modal-close {
    background: rgba(255,255,255,0.08); border: none; color: #fff;
    width: 34px; height: 34px; border-radius: 50%; cursor: pointer; flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s ease;
}
.je-arr-modal-close:hover { background: rgba(255,255,255,0.18); }
.je-arr-modal-body { padding: 14px 20px; overflow-y: auto; flex: 1 1 auto; }
.je-arr-modal-footer {
    display: flex; justify-content: flex-end; gap: 10px;
    padding: 12px 20px; border-top: 1px solid rgba(255,255,255,0.08);
}
.je-arr-modal-footer:empty { display: none; }

/* toolbar */
.je-arr-toolbar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 10px;
}
.je-arr-field { display: flex; align-items: center; gap: 6px; }
.je-arr-field-label { font-size: 12px; color: rgba(255,255,255,0.55); }
.je-arr-select, .je-arr-filter {
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
    color: #fff; border-radius: 6px; padding: 6px 8px; font-size: 13px;
}
.je-arr-filter { flex: 1 1 160px; min-width: 120px; }
.je-arr-select option { color: #000; }
.je-arr-check {
    display: flex; align-items: center; gap: 6px; font-size: 13px;
    color: rgba(255,255,255,0.75); cursor: pointer;
}
.je-arr-check input { accent-color: var(--primary-accent-color, #b9a6ff); }
.je-arr-release-count { font-size: 12px; color: rgba(255,255,255,0.5); margin-bottom: 8px; }

/* release list */
.je-arr-release-list { display: flex; flex-direction: column; gap: 6px; }
.je-arr-release {
    display: flex; align-items: center; gap: 10px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
    border-radius: 8px; padding: 8px 10px;
}
.je-arr-release.je-arr-rejected { opacity: 0.72; }
.je-arr-release-main { min-width: 0; flex: 1 1 auto; }
.je-arr-release-title {
    font-size: 13px; font-weight: 500; word-break: break-word; line-height: 1.35;
}
.je-arr-release-meta {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 4px;
    font-size: 12px;
}
.je-arr-dim { color: rgba(255,255,255,0.55); }
.je-arr-badge {
    background: rgba(90,63,184,0.35); border: 1px solid rgba(90,63,184,0.5);
    color: #d8ccff; border-radius: 4px; padding: 1px 6px; font-size: 11px; font-weight: 600;
}
.je-arr-badge-ok { background: rgba(76,175,80,0.28); border-color: rgba(76,175,80,0.5); color: #b8f0ba; }
.je-arr-release-rejections {
    display: flex; align-items: flex-start; gap: 4px; margin-top: 4px;
    font-size: 11px; color: #f0b37e;
}
.je-arr-release-rejections .material-icons { font-size: 14px; }
.je-arr-grab {
    flex: 0 0 auto; width: 40px; height: 40px; border-radius: 8px; cursor: pointer;
    background: rgba(90,63,184,0.6); border: 1px solid rgba(90,63,184,0.75); color: #fff;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s ease;
}
.je-arr-grab:hover:not(:disabled) { background: rgba(90,63,184,0.85); }
.je-arr-grab:disabled { cursor: default; opacity: 0.8; }
.je-arr-grab.je-arr-grabbed { background: rgba(76,175,80,0.6); border-color: rgba(76,175,80,0.75); }

/* sections / manage */
.je-arr-section { margin-bottom: 16px; }
.je-arr-section-title {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;
    color: rgba(255,255,255,0.5); margin-bottom: 8px;
}
.je-arr-manage-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
    border-radius: 8px; padding: 10px 12px; margin-bottom: 6px;
}
.je-arr-manage-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.je-arr-manage-name { font-size: 14px; font-weight: 500; }
.je-arr-switch { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.je-arr-switch input { accent-color: var(--primary-accent-color, #b9a6ff); width: 18px; height: 18px; }
.je-arr-switch-track { display: none; }
.je-arr-switch-label { font-size: 13px; color: rgba(255,255,255,0.7); }

/* progress */
.je-arr-progress-row { margin-bottom: 10px; }
.je-arr-progress-title { font-size: 13px; margin-bottom: 4px; word-break: break-word; }
.je-arr-progress-bar {
    height: 8px; border-radius: 4px; background: rgba(255,255,255,0.1); overflow: hidden;
}
.je-arr-progress-fill { height: 100%; background: var(--primary-accent-color, #b9a6ff); transition: width 0.3s ease; }
.je-arr-progress-meta { display: flex; gap: 10px; margin-top: 3px; font-size: 12px; }

/* add form */
.je-arr-add-form { display: flex; flex-direction: column; gap: 12px; }
.je-arr-form-field { display: flex; flex-direction: column; gap: 4px; }
.je-arr-form-field .je-arr-field-label { font-size: 13px; color: rgba(255,255,255,0.75); }
.je-arr-form-field .je-arr-select { width: 100%; }

/* buttons */
.je-arr-btn-base {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    border-radius: 6px; padding: 8px 16px; font-size: 14px; font-weight: 500;
    border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.1); color: #fff;
    transition: background 0.15s ease;
}
.je-arr-btn-base .material-icons { font-size: 18px; }
.je-arr-btn:hover { background: rgba(255,255,255,0.2); }
.je-arr-btn-primary {
    background: rgba(90,63,184,0.6); border-color: rgba(90,63,184,0.75);
}
.je-arr-btn-primary:hover:not(:disabled) { background: rgba(90,63,184,0.85); }
.je-arr-btn-base:disabled { opacity: 0.6; cursor: default; }

/* states */
.je-arr-center { display: flex; align-items: center; justify-content: center; min-height: 120px; }
.je-arr-spinner {
    width: 32px; height: 32px; border-radius: 50%;
    border: 3px solid rgba(255,255,255,0.15); border-top-color: var(--primary-accent-color, #b9a6ff);
    animation: je-arr-spin 0.8s linear infinite;
}
@keyframes je-arr-spin { to { transform: rotate(360deg); } }
.je-arr-message {
    display: flex; align-items: center; gap: 8px; font-size: 14px;
    color: rgba(255,255,255,0.75); text-align: center; padding: 12px;
}
.je-arr-message-error { color: #f2a09a; }
.je-arr-message .material-icons { font-size: 20px; }

@media (max-width: 640px) {
    .je-arr-modal { width: 100%; max-height: 96vh; }
    .je-arr-release-meta { font-size: 11px; }
}
`;

let injected = false;

/** Injects the arr-search modal CSS once (idempotent via ui-kit's dedupe-by-id). */
export function injectArrSearchStyles(): void {
    if (injected) return;
    injected = true;
    JE.core.ui!.injectCss('je-arr-search-styles', CSS);
}
