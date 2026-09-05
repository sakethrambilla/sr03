// The composer's text box. A contenteditable rather than a <textarea> because the next step is
// atomic file pills inside the text, which a textarea can't hold — shadcn has no such primitive,
// so this is a wrapper, not a hand-rolled copy of one. It is uncontrolled by necessity: the
// browser owns the DOM, `serialize` reads the text back out, and every write goes through
// execCommand so the native undo stack survives.
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";

import { cn } from "./ui.tsx";

export interface MentionInputHandle {
  focus: () => void;
  setText: (text: string) => void;
  insertText: (text: string) => void;
}

// a trailing <br> is what makes a final empty line render; it is not part of the text
function serialize(root: Node): string {
  let out = "";
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node as Text).data;
      continue;
    }
    const element = node as HTMLElement;
    if (element.tagName === "BR") {
      if (element.dataset.sentinel === undefined) out += "\n";
      continue;
    }
    out += serialize(element);
  }
  return out;
}

// contenteditable is never left in a shape the caret can't reach: exactly one sentinel, always last
function normalize(root: HTMLElement) {
  for (const stray of root.querySelectorAll("br[data-sentinel]")) {
    if (stray !== root.lastChild) stray.remove();
  }
  if (!(root.lastChild instanceof HTMLBRElement) || root.lastChild.dataset.sentinel === undefined) {
    const sentinel = document.createElement("br");
    sentinel.dataset.sentinel = "";
    root.append(sentinel);
  }
  root.dataset.empty = serialize(root) === "" ? "true" : "false";
}

export const MentionInput = forwardRef<
  MentionInputHandle,
  {
    onChange: (text: string) => void;
    onSubmit: () => void;
    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
    onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
    placeholder: string;
    className?: string;
  }
>(function MentionInput({ onChange, onSubmit, onKeyDown, onPaste, placeholder, className }, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  // an IME candidate window writes through the DOM; reading it back mid-compose corrupts it
  const composing = useRef(false);

  useLayoutEffect(() => {
    if (rootRef.current) normalize(rootRef.current);
  }, []);

  const emit = () => {
    const root = rootRef.current;
    if (!root || composing.current) return;
    normalize(root);
    onChange(serialize(root));
  };

  // execCommand is deprecated but is still the only write that keeps the browser's own undo stack
  const write = (text: string) => {
    const root = rootRef.current;
    if (!root) return;
    root.focus();
    document.execCommand("insertText", false, text);
    emit();
  };

  useImperativeHandle(ref, () => ({
    focus: () => rootRef.current?.focus(),
    insertText: write,
    setText: (text: string) => {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      const range = document.createRange();
      range.selectNodeContents(root);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (text) document.execCommand("insertText", false, text);
      else document.execCommand("delete");
      emit();
    },
  }));

  return (
    <div
      ref={rootRef}
      role="textbox"
      contentEditable
      suppressContentEditableWarning
      aria-multiline="true"
      aria-label={placeholder}
      data-placeholder={placeholder}
      onInput={emit}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
        emit();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Enter") {
          event.preventDefault();
          // insertText silently drops "\n", so a line break has to go in as its own node
          if (event.shiftKey) {
            rootRef.current?.focus();
            document.execCommand("insertHTML", false, "<br>");
            emit();
          } else onSubmit();
        }
      }}
      onPaste={(event) => {
        onPaste?.(event);
        if (event.defaultPrevented) return;
        // the browser would otherwise paste the source's markup and fonts into the box
        event.preventDefault();
        write(event.clipboardData.getData("text/plain"));
      }}
      className={cn(
        "relative max-h-[220px] min-h-8 w-full flex-1 overflow-y-auto py-1.5 text-[14px]",
        "leading-relaxed whitespace-pre-wrap outline-none",
        "data-[empty=true]:before:pointer-events-none data-[empty=true]:before:absolute",
        "data-[empty=true]:before:top-1.5 data-[empty=true]:before:left-0",
        "data-[empty=true]:before:text-faint data-[empty=true]:before:content-[attr(data-placeholder)]",
        className,
      )}
    />
  );
});
