'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { cn } from '@/components/ui/utils';
import {
  TEMPLATE_TOKEN_PATTERN,
  TOKEN_CHIP_CLASS,
  WHATSAPP_TEMPLATE_VARIABLES,
  tokenLabel,
} from '@/features/whatsapp/templateTokens';

/**
 * TemplateTokenEditor — a token-aware message editor.
 *
 * The stored template format stays raw syntax (`{{customer_name}}`, unchanged
 * backend/storage format). Inside the editor, every variable is an ATOMIC
 * inline chip (`[Customer name]`) implemented as a `contenteditable="false"`
 * span inside one contenteditable root — the browser therefore treats each
 * chip as one indivisible object:
 *
 *   - the caret cannot enter a token
 *   - Backspace before a token removes the ENTIRE token (beforeinput)
 *   - Delete after a token removes the ENTIRE token (beforeinput)
 *   - arrow keys skip over a token as one unit
 *   - click/selection treats the token as one unit (user-select: all)
 *   - text before/after tokens edits normally
 *
 * Control flow (controlled-sync pattern):
 *   - The DOM is built imperatively from `value` on mount (and only rebuilt
 *     when `value` changes from OUTSIDE — e.g. a reset). React never renders
 *     children into the contenteditable, so re-renders never clobber the
 *     caret.
 *   - Every DOM mutation (typing, deletion, token insertion) is serialized
 *     back to the raw syntax and reported through `onChange`; the parent
 *     echoing the same value back is detected and ignored (no DOM rebuild).
 *
 * Serialization: text nodes → text, `<br>` → newline (a trailing root-level
 * `<br>` is a browser "phantom" caret line and contributes nothing — the
 * backend trims the template anyway), chip → `{{token_name}}`.
 */

// ─── DOM helpers (module-level, pure DOM operations) ────────────────────────

function isChip(node: Node | null | undefined): node is HTMLElement {
  return node instanceof HTMLElement && node.dataset.token !== undefined;
}

/** Serialize the editor DOM back to the raw {{token}} template syntax. */
function serialize(root: HTMLElement): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? '';
      return;
    }
    if (node.nodeName === 'BR') {
      // A root-level trailing <br> is the browser's phantom caret line —
      // it renders nothing, so it must not become a newline in the model.
      if (node.parentNode === root && node === root.lastChild) return;
      out += '\n';
      return;
    }
    if (isChip(node)) {
      out += `{{${node.dataset.token}}}`;
      return;
    }
    // Any wrapper elements the browser may have created — recurse so their
    // text/chips are never lost.
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out;
}

/** Create one atomic token chip (never partially editable). */
function buildChip(name: string): HTMLElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.dataset.token = name;
  chip.className = TOKEN_CHIP_CLASS;
  chip.textContent = tokenLabel(name);
  return chip;
}

/**
 * Build DOM content for a raw template string: text nodes, `<br>` for
 * newlines, and atomic chips for every {{token}} (the same pattern the
 * backend recognizes — unknown names still become chips and round-trip
 * unchanged).
 */
function buildContent(template: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  // split() with one capture group → [text, token, text, token, …, text]
  template.split(TEMPLATE_TOKEN_PATTERN).forEach((part, index) => {
    if (index % 2 === 1) {
      fragment.appendChild(buildChip(part));
      return;
    }
    if (!part) return;
    part.split('\n').forEach((line, lineIndex) => {
      if (lineIndex > 0) fragment.appendChild(document.createElement('br'));
      if (line) fragment.appendChild(document.createTextNode(line));
    });
  });
  return fragment;
}

function applyRange(range: Range): void {
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function caretAfter(node: Node): void {
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  applyRange(range);
}

/** The atomic chip immediately BEFORE the collapsed caret, if any. */
function chipBeforeCaret(root: HTMLElement): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
  const node = selection.anchorNode;
  if (!node) return null;
  if (node === root) {
    const child = root.childNodes[selection.anchorOffset - 1];
    return isChip(child) ? child : null;
  }
  if (node.nodeType === Node.TEXT_NODE && selection.anchorOffset === 0) {
    return isChip(node.previousSibling) ? node.previousSibling : null;
  }
  return null;
}

/** The atomic chip immediately AFTER the collapsed caret, if any. */
function chipAfterCaret(root: HTMLElement): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
  const node = selection.anchorNode;
  if (!node) return null;
  if (node === root) {
    const child = root.childNodes[selection.anchorOffset];
    return isChip(child) ? child : null;
  }
  if (
    node.nodeType === Node.TEXT_NODE &&
    node.nodeValue !== null &&
    selection.anchorOffset === node.nodeValue.length
  ) {
    return isChip(node.nextSibling) ? node.nextSibling : null;
  }
  return null;
}

/** Remove one chip and place the caret exactly where it stood. */
function removeChip(chip: HTMLElement): void {
  const parent = chip.parentNode;
  if (!parent) return;
  const offset = Array.prototype.indexOf.call(parent.childNodes, chip);
  parent.removeChild(chip);
  const range = document.createRange();
  if (parent.childNodes.length === offset) {
    range.setStart(parent, offset);
  } else {
    range.setStartBefore(parent.childNodes[offset]);
  }
  range.collapse(true);
  applyRange(range);
}

// ─── Component ──────────────────────────────────────────────────────────────

export interface TemplateTokenEditorProps {
  /** Current raw template value ({{variable}} syntax). */
  value: string;
  /** Fired whenever the editor content changes. */
  onChange: (next: string) => void;
  /** Focus and place the caret at the end when the editor mounts. */
  autoFocus?: boolean;
  /** Placeholder shown while the editor is empty. */
  placeholder?: string;
  /** Accessible name for the editable region. */
  'aria-label': string;
  className?: string;
}

export function TemplateTokenEditor({
  value,
  onChange,
  autoFocus,
  placeholder,
  'aria-label': ariaLabel,
  className,
}: TemplateTokenEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  /** The serialized value the DOM currently represents. */
  const lastSerializedRef = useRef(value);
  /** Last selection known to be inside the editor (caret restore anchor). */
  const savedRangeRef = useRef<Range | null>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // ── DOM → model ──────────────────────────────────────────────────
  const commit = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    // Normalize the browser's post-delete residue: an editor left with only
    // a <br> is empty (placeholder shows, model is '').
    if (root.childNodes.length === 1 && root.firstChild?.nodeName === 'BR') {
      root.textContent = '';
    }
    const next = serialize(root);
    if (next === lastSerializedRef.current) return;
    lastSerializedRef.current = next;
    onChangeRef.current(next);
  }, []);

  // ── Mount: build the initial DOM from the raw template ───────────
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.textContent = '';
    root.appendChild(buildContent(value));
    lastSerializedRef.current = value;
    if (autoFocus) {
      root.focus();
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      applyRange(range);
    }
    // Mount-only: `value` is the initial snapshot by definition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── External value sync ──────────────────────────────────────────
  // Rebuild ONLY when the incoming value differs from what the DOM already
  // serializes to — i.e. the change came from outside the editor (a reset).
  // Internal edits keep lastSerializedRef in sync via commit(), so the echo
  // of our own onChange never triggers a rebuild (caret stays untouched).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (value === lastSerializedRef.current) return;
    root.textContent = '';
    root.appendChild(buildContent(value));
    lastSerializedRef.current = value;
  }, [value]);

  // ── Track the caret inside the editor ────────────────────────────
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onSelectionChange = () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (root.contains(range.commonAncestorContainer)) {
        savedRangeRef.current = range.cloneRange();
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  // ── Insert parsed content (variable buttons, paste) at the caret ─
  const insertAtCaret = useCallback(
    (content: string) => {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      // Prefer the LIVE selection (variable buttons keep it via
      // preventDefault on mousedown); fall back to the last remembered
      // range; otherwise append at the end.
      const selection = window.getSelection();
      const live = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const saved = savedRangeRef.current;
      let range: Range;
      if (live && root.contains(live.commonAncestorContainer)) {
        range = live.cloneRange();
      } else if (saved && root.contains(saved.commonAncestorContainer)) {
        range = saved.cloneRange();
      } else {
        range = document.createRange();
        range.selectNodeContents(root);
        range.collapse(false);
      }
      applyRange(range);
      range.deleteContents();
      const fragment = buildContent(content);
      const last = fragment.lastChild;
      range.insertNode(fragment);
      if (last) caretAfter(last);
      commit();
    },
    [commit],
  );

  // ── Atomic chip deletion (beforeinput) + plain-text paste ────────
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === 'deleteContentBackward') {
        const chip = chipBeforeCaret(root);
        if (chip) {
          event.preventDefault();
          removeChip(chip);
          commit();
        }
      } else if (event.inputType === 'deleteContentForward') {
        const chip = chipAfterCaret(root);
        if (chip) {
          event.preventDefault();
          removeChip(chip);
          commit();
        }
      }
    };

    const onPaste = (event: ClipboardEvent) => {
      // Plain text only — pasted {{tokens}} become real atomic chips, and no
      // arbitrary HTML can ever enter the template.
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      insertAtCaret(text);
    };

    root.addEventListener('beforeinput', onBeforeInput as EventListener);
    root.addEventListener('paste', onPaste as EventListener);
    return () => {
      root.removeEventListener('beforeinput', onBeforeInput as EventListener);
      root.removeEventListener('paste', onPaste as EventListener);
    };
  }, [commit, insertAtCaret]);

  // ── Keyboard: Enter → line break; arrows skip chips as one unit ──
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      // A real <br> line break (never a <div> paragraph) so serialization
      // stays exact for the multi-line message format.
      document.execCommand('insertLineBreak');
      commit();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const selection = window.getSelection();
      if (!selection || !selection.isCollapsed) return;
      const chip = event.key === 'ArrowLeft' ? chipBeforeCaret(root) : chipAfterCaret(root);
      if (!chip) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') {
        const range = document.createRange();
        range.setStartBefore(chip);
        range.collapse(true);
        applyRange(range);
      } else {
        caretAfter(chip);
      }
    }
  };

  return (
    <div className="space-y-3">
      <div
        ref={rootRef}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={commit}
        onKeyDown={handleKeyDown}
        className={cn(
          'wa-token-editor min-h-32 w-full whitespace-pre-wrap rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs leading-relaxed text-slate-900 caret-indigo-600 outline-none transition-colors focus:border-indigo-500',
          className,
        )}
      />
      {/* Available variables — insert at the current caret position */}
      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Available variables
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {WHATSAPP_TEMPLATE_VARIABLES.map(({ name, label }) => (
            <button
              key={name}
              type="button"
              title={`Insert ${label}`}
              // Never take focus from the editor — the insertion targets the
              // editor's current caret position, not the end of the message.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertAtCaret(`{{${name}}}`)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
