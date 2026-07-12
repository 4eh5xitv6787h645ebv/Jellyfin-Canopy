// src/arr/search/styles.ts
//
// Injected CSS for the arr Search modals. Matches the established JC modal aesthetic
// (dark overlay + gradient dialog, --primary-accent-color for accents) used by the
// spoiler-guard confirm dialog and the Seerr modals, so the picker looks native to JC.

import { JC } from '../../globals';

const CSS = `
.jc-arr-modal-overlay {
    /* Above the dialogHelper action sheet (.dialogContainer z-index 999999) so the modal never
       renders behind a still-closing sheet. */
    position: fixed; inset: 0; z-index: 1000001;
    background: rgba(0,0,0,0.7); backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    padding: 2vh 2vw;
}
.jc-arr-modal {
    background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 12px;
    color: #fff;
    width: 760px; max-width: 100%;
    max-height: 92vh;
    display: flex; flex-direction: column;
    box-shadow: 0 24px 64px rgba(0,0,0,0.5);
}
.jc-arr-modal-header {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
    padding: 18px 20px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
}
.jc-arr-modal-titles { min-width: 0; }
.jc-arr-modal-title {
    margin: 0; font-size: 18px; font-weight: 600;
    display: flex; align-items: center; gap: 8px;
}
.jc-arr-modal-title-icon { font-size: 22px; color: var(--primary-accent-color, #b9a6ff); }
.jc-arr-modal-subtitle {
    margin-top: 2px; font-size: 13px; color: rgba(255,255,255,0.6);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.jc-arr-modal-close {
    background: rgba(255,255,255,0.08); border: none; color: #fff;
    width: 34px; height: 34px; border-radius: 50%; cursor: pointer; flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s ease;
}
.jc-arr-modal-close:hover { background: rgba(255,255,255,0.18); }
/* min-height:0 lets this flex child actually scroll inside the capped modal instead of growing and
   pushing the whole page to scroll; overscroll-behavior stops touch scroll chaining to the page. */
.jc-arr-modal-body { padding: 14px 20px; overflow-y: auto; flex: 1 1 auto; min-height: 0; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.jc-arr-modal-footer {
    display: flex; justify-content: flex-end; gap: 10px;
    padding: 12px 20px; border-top: 1px solid rgba(255,255,255,0.08);
}
.jc-arr-modal-footer:empty { display: none; }

/* toolbar */
.jc-arr-toolbar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 10px;
}
.jc-arr-field { display: flex; align-items: center; gap: 6px; }
.jc-arr-field-label { font-size: 12px; color: rgba(255,255,255,0.55); }
.jc-arr-select, .jc-arr-filter {
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
    color: #fff; border-radius: 6px; padding: 6px 8px; font-size: 13px;
}
.jc-arr-filter { flex: 1 1 160px; min-width: 120px; }
.jc-arr-select option { color: #000; }
.jc-arr-check {
    display: flex; align-items: center; gap: 6px; font-size: 13px;
    color: rgba(255,255,255,0.75); cursor: pointer;
}
.jc-arr-check input { accent-color: var(--primary-accent-color, #b9a6ff); }
.jc-arr-release-count { font-size: 12px; color: rgba(255,255,255,0.5); margin-bottom: 8px; }

/* release list */
.jc-arr-release-list { display: flex; flex-direction: column; gap: 6px; }
.jc-arr-release {
    display: flex; align-items: center; gap: 10px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
    border-radius: 8px; padding: 8px 10px;
}
.jc-arr-release.jc-arr-rejected { opacity: 0.72; }
.jc-arr-release-main { min-width: 0; flex: 1 1 auto; }
.jc-arr-release-title {
    font-size: 13px; font-weight: 500; word-break: break-word; line-height: 1.35;
}
.jc-arr-release-meta {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 4px;
    font-size: 12px;
}
.jc-arr-dim { color: rgba(255,255,255,0.55); }
.jc-arr-badge {
    background: rgba(90,63,184,0.35); border: 1px solid rgba(90,63,184,0.5);
    color: #d8ccff; border-radius: 4px; padding: 1px 6px; font-size: 11px; font-weight: 600;
}
.jc-arr-badge-ok { background: rgba(76,175,80,0.28); border-color: rgba(76,175,80,0.5); color: #b8f0ba; }
.jc-arr-cf {
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.14);
    color: rgba(255,255,255,0.75); border-radius: 4px; padding: 1px 6px; font-size: 11px; white-space: nowrap;
}
.jc-arr-release-rejections {
    display: flex; align-items: flex-start; gap: 4px; margin-top: 4px;
    font-size: 11px; color: #f0b37e;
}
.jc-arr-release-rejections .material-icons { font-size: 14px; }
.jc-arr-grab {
    flex: 0 0 auto; width: 40px; height: 40px; border-radius: 8px; cursor: pointer;
    background: rgba(90,63,184,0.6); border: 1px solid rgba(90,63,184,0.75); color: #fff;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s ease;
}
.jc-arr-grab:hover:not(:disabled) { background: rgba(90,63,184,0.85); }
.jc-arr-grab:disabled { cursor: default; opacity: 0.8; }
.jc-arr-grab.jc-arr-grabbed { background: rgba(76,175,80,0.6); border-color: rgba(76,175,80,0.75); }

/* sections / manage */
.jc-arr-section { margin-bottom: 16px; }
.jc-arr-section-title {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;
    color: rgba(255,255,255,0.5); margin-bottom: 8px;
}
.jc-arr-manage-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07);
    border-radius: 8px; padding: 10px 12px; margin-bottom: 6px;
}
.jc-arr-manage-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.jc-arr-manage-name { font-size: 14px; font-weight: 500; }
.jc-arr-switch { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.jc-arr-switch input { accent-color: var(--primary-accent-color, #b9a6ff); width: 18px; height: 18px; }
.jc-arr-switch-track { display: none; }
.jc-arr-switch-label { font-size: 13px; color: rgba(255,255,255,0.7); }

/* progress */
.jc-arr-progress-row { margin-bottom: 10px; }
.jc-arr-progress-title { font-size: 13px; margin-bottom: 4px; word-break: break-word; }
.jc-arr-progress-bar {
    height: 8px; border-radius: 4px; background: rgba(255,255,255,0.1); overflow: hidden;
}
.jc-arr-progress-fill { height: 100%; background: var(--primary-accent-color, #b9a6ff); transition: width 0.3s ease; }
.jc-arr-progress-meta { display: flex; gap: 10px; margin-top: 3px; font-size: 12px; }

/* add form */
.jc-arr-add-form { display: flex; flex-direction: column; gap: 12px; }
.jc-arr-form-field { display: flex; flex-direction: column; gap: 4px; }
.jc-arr-form-field .jc-arr-field-label { font-size: 13px; color: rgba(255,255,255,0.75); }
.jc-arr-form-field .jc-arr-select { width: 100%; }

/* buttons */
.jc-arr-btn-base {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    border-radius: 6px; padding: 8px 16px; font-size: 14px; font-weight: 500;
    border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.1); color: #fff;
    transition: background 0.15s ease;
}
.jc-arr-btn-base .material-icons { font-size: 18px; }
.jc-arr-btn:hover { background: rgba(255,255,255,0.2); }
.jc-arr-btn-primary {
    background: rgba(90,63,184,0.6); border-color: rgba(90,63,184,0.75);
}
.jc-arr-btn-primary:hover:not(:disabled) { background: rgba(90,63,184,0.85); }
.jc-arr-btn-base:disabled { opacity: 0.6; cursor: default; }

/* states */
.jc-arr-center { display: flex; align-items: center; justify-content: center; min-height: 120px; }
.jc-arr-spinner {
    width: 32px; height: 32px; border-radius: 50%;
    border: 3px solid rgba(255,255,255,0.15); border-top-color: var(--primary-accent-color, #b9a6ff);
    animation: jc-arr-spin 0.8s linear infinite;
}
@keyframes jc-arr-spin { to { transform: rotate(360deg); } }
.jc-arr-message {
    display: flex; align-items: center; gap: 8px; font-size: 14px;
    color: rgba(255,255,255,0.75); text-align: center; padding: 12px;
}
.jc-arr-message-error { color: #f2a09a; }
.jc-arr-message .material-icons { font-size: 20px; }

@media (max-width: 640px) {
    .jc-arr-modal { width: 100%; max-height: 96vh; }
    .jc-arr-release-meta { font-size: 11px; }
}
`;

let injected = false;

/** Injects the arr-search modal CSS once (idempotent via ui-kit's dedupe-by-id). */
export function injectArrSearchStyles(): void {
    if (injected) return;
    injected = true;
    JC.core.ui!.injectCss('jc-arr-search-styles', CSS);
}
