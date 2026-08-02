// Shared accessibility ownership for every Bookmarks overlay. Keeping the
// handle registry here lets either bookmark surface drain an overlay without
// leaking the repository-wide modal stack or restoring focus twice.

import {
  installModalA11y,
  type ModalA11yHandle,
  type ModalA11yOptions
} from '../../core/modal-a11y';

const handles = new WeakMap<HTMLElement, ModalA11yHandle>();
let nextAccessibleId = 0;

type BookmarkModalControl = 'label' | 'offset' | 'time';

export interface BookmarkModalA11yOptions {
  title: HTMLElement;
  description?: HTMLElement | null;
  initialFocus?: ModalA11yOptions['initialFocus'];
  onEscape: () => void;
}

function ownedId(element: HTMLElement, part: 'title' | 'description'): string {
  if (element.id) return element.id;
  nextAccessibleId += 1;
  element.id = `jc-bookmark-dialog-${part}-${nextAccessibleId}`;
  return element.id;
}

/** Allocate a document-unique label/control relationship for one modal instance. */
export function createBookmarkModalControlId(part: BookmarkModalControl): string {
  nextAccessibleId += 1;
  return `jc-bookmark-dialog-${part}-${nextAccessibleId}`;
}

/** Acquire the one shared modal/keyboard owner for a Bookmarks overlay. */
export function installBookmarkModalA11y(
  modal: HTMLElement,
  options: BookmarkModalA11yOptions
): void {
  releaseBookmarkModalA11y(modal, false);
  const descriptionId = options.description
    ? ownedId(options.description, 'description')
    : '';
  if (descriptionId) modal.setAttribute('aria-describedby', descriptionId);
  else modal.removeAttribute('aria-describedby');

  const handle = installModalA11y(modal, {
    labelledBy: ownedId(options.title, 'title'),
    initialFocus: options.initialFocus,
    onEscape: options.onEscape
  });
  handles.set(modal, handle);
}

/** Release modal-stack, shortcut-gate, refresh-safety, and focus ownership. */
export function releaseBookmarkModalA11y(
  modal: HTMLElement,
  restoreFocus = true
): void {
  const handle = handles.get(modal);
  if (!handle) return;
  handles.delete(modal);
  handle.release(restoreFocus);
}
