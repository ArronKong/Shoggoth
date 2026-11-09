import { type ClipboardEvent, type KeyboardEvent, type ReactNode, forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { GroupDraftMention, GroupDraftText } from "../lib/groupMentions";
import type { GroupChatMember } from "../types";
import GroupChatMention from "./GroupChatMention";
import styles from "./GroupChatPanel.module.css";

type Prefill = { memberId: string | null; text: string };
export type GroupComposerSelection = { start: number; end: number; includesPrefill: boolean };
export type GroupComposerInputHandle = {
  focus(): void;
  selection(): GroupComposerSelection;
  moveCaret(position: number): void;
};

type Props = {
  value: GroupDraftText;
  prefill: Prefill | null;
  members: ReadonlyMap<string, GroupChatMember>;
  mentionableMembers: readonly GroupChatMember[];
  label: string;
  disabled: boolean;
  menuId: string;
  activeOption?: string;
  onChange(value: GroupDraftText, selection: GroupComposerSelection, removedPrefill: boolean, composing: boolean): void;
  onOpenMention(mention: GroupDraftMention | "prefill"): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>, selection: GroupComposerSelection): void;
  onPaste(event: ClipboardEvent<HTMLDivElement>): void;
  onDismissMenu(): void;
};

/** The DOM contains atomic chips. The draft still contains its original Markdown and @handles. */
function readField(root: HTMLDivElement) {
  let text = "";
  let prefill: HTMLElement | null = null;
  const mentions: Array<GroupDraftMention & { node: ChildNode }> = [];
  const leaves: Array<{ node: ChildNode; start: number; end: number }> = [];
  const boundaries = new Map<Node, number[]>();

  function readChildren(parent: Node) {
    const offsets = [text.length];
    let previousBlock = false;
    for (const node of Array.from(parent.childNodes)) {
      const block = node.nodeName === "DIV" || node.nodeName === "P";
      if (previousBlock || block && node.previousSibling && !text.endsWith("\n")) text += "\n";
      const start = text.length;
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue ?? "";
        leaves.push({ node, start, end: text.length });
      } else if (node instanceof HTMLElement) {
        const handle = node.dataset.groupDraftToken;
        if (handle !== undefined) {
          if (node.hasAttribute("data-group-draft-prefill")) prefill = node;
          else {
            text += handle;
            mentions.push({ node, start, end: text.length, memberId: node.dataset.groupDraftMember || null });
            leaves.push({ node, start, end: text.length });
          }
        } else if (node.tagName === "BR") {
          if (node.nextSibling && !node.hasAttribute("data-group-draft-tail")) {
            text += "\n";
            leaves.push({ node, start, end: text.length });
          }
        } else {
          // Browsers may insert block elements for native line breaks or pastes.
          readChildren(node);
        }
      }
      offsets.push(text.length);
      previousBlock = block;
    }
    boundaries.set(parent, offsets);
  }
  readChildren(root);
  return { text, mentions, prefill: prefill as HTMLElement | null, leaves, boundaries };
}

function fieldSelection(root: HTMLDivElement, field = readField(root)): GroupComposerSelection {
  const selection = root.ownerDocument.getSelection();
  const end = field.text.length;
  if (!selection?.rangeCount || !root.contains(selection.getRangeAt(0).commonAncestorContainer)) {
    return { start: end, end, includesPrefill: false };
  }
  const range = selection.getRangeAt(0);
  const offset = (node: Node, position: number) => {
    const boundary = field.boundaries.get(node)?.[position];
    if (boundary !== undefined) return boundary;
    const leaf = field.leaves.find(item => item.node === node || item.node.contains(node));
    if (!leaf) return 0;
    return leaf.node.nodeType === Node.TEXT_NODE ? leaf.start + position : leaf.end;
  };
  return { start: offset(range.startContainer, range.startOffset), end: offset(range.endContainer, range.endOffset),
    includesPrefill: Boolean(!range.collapsed && field.prefill && range.intersectsNode(field.prefill)) };
}

function placeCaret(root: HTMLDivElement, position: number) {
  const { leaves } = readField(root);
  const leaf = leaves.find(item => position <= item.end);
  const range = root.ownerDocument.createRange();
  if (leaf?.node.nodeType === Node.TEXT_NODE) range.setStart(leaf.node, Math.max(0, position - leaf.start));
  else if (leaf && position <= leaf.start) range.setStartBefore(leaf.node);
  else if (leaf) range.setStartAfter(leaf.node);
  else if (root.lastChild?.nodeName === "BR") range.setStartBefore(root.lastChild);
  else range.setStart(root, root.childNodes.length);
  range.collapse(true);
  const selection = root.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

const signature = (value: GroupDraftText, prefill: Prefill | null) => JSON.stringify([value.text, value.mentions, prefill?.memberId, prefill?.text]);

/** Keep the browser's text editing and composition state until the app replaces part of the draft. */
const GroupChatComposerInput = forwardRef<GroupComposerInputHandle, Props>(function GroupChatComposerInput(
  { value, prefill, members, mentionableMembers, label, disabled, menuId, activeOption, onChange, onOpenMention, onKeyDown, onPaste, onDismissMenu }, ref,
) {
  const root = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const nativeSignature = useRef(signature(value, prefill));
  const restoreCaret = useRef<number | null>(null);
  const [surface, setSurface] = useState(() => ({ value, prefill, revision: 0 }));

  useLayoutEffect(() => {
    const next = signature(value, prefill);
    if (nativeSignature.current === next) return;
    const editor = root.current;
    restoreCaret.current = editor && editor.ownerDocument.activeElement === editor ? fieldSelection(editor).end : null;
    nativeSignature.current = next;
    setSurface(previous => ({ value, prefill, revision: previous.revision + 1 }));
  }, [value, prefill]);
  useLayoutEffect(() => {
    const editor = root.current;
    if (editor && restoreCaret.current !== null && !disabled) {
      editor.focus({ preventScroll: true });
      placeCaret(editor, restoreCaret.current);
      restoreCaret.current = null;
    }
  }, [surface.revision, disabled]);

  useImperativeHandle(ref, () => ({
    focus: () => root.current?.focus({ preventScroll: true }),
    selection: () => root.current ? fieldSelection(root.current) : { start: value.text.length, end: value.text.length, includesPrefill: false },
    moveCaret: position => { if (root.current) placeCaret(root.current, position); },
  }), [value.text.length]);

  const reportChange = (editor: HTMLDivElement) => {
    const field = readField(editor);
    const next = { text: field.text, mentions: field.mentions.map(({ start, end, memberId }) => ({ start, end, memberId })) };
    const handle = field.prefill?.dataset.groupDraftToken;
    nativeSignature.current = signature(next, handle ? { text: handle, memberId: field.prefill?.dataset.groupDraftMember || null } : null);
    onChange(next, fieldSelection(editor, field), Boolean(prefill && !field.prefill), composing.current);
  };

  const copySelection = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const editor = event.currentTarget;
    const field = readField(editor);
    const { start, end, includesPrefill } = fieldSelection(editor, field);
    if (!includesPrefill && !field.mentions.some(mention => mention.start < end && mention.end > start)) return;
    event.preventDefault();
    const text = field.text.slice(start, end);
    const handle = includesPrefill ? field.prefill?.dataset.groupDraftToken : undefined;
    event.clipboardData.setData("text/plain", handle ? handle + (text ? " " + text : "") : text);
    if (cut) {
      const range = editor.ownerDocument.getSelection()?.getRangeAt(0);
      range?.deleteContents();
      range?.collapse(true);
      reportChange(editor);
    }
  };

  const token = (memberId: string | null, text: string, key: string, isPrefill: boolean) => {
    const member = memberId === null ? undefined : members.get(memberId);
    if (memberId !== null && !member) return text;
    return <span key={key} className={styles.composerToken} contentEditable={false}
      data-group-draft-token={text} data-group-draft-member={memberId ?? ""} data-group-draft-prefill={isPrefill || undefined}>
      <GroupChatMention member={member} everyone={mentionableMembers} picker={{ id: menuId, prefill: isPrefill, disabled, open: button => {
        const editor = root.current;
        if (!editor || disabled) return;
        const mention = readField(editor).mentions.find(span => span.node === button.parentElement);
        if (!isPrefill && !mention) return;
        editor.focus({ preventScroll: true });
        placeCaret(editor, mention?.end ?? 0);
        if (isPrefill) onOpenMention("prefill");
        else if (mention) onOpenMention({ start: mention.start, end: mention.end, memberId: mention.memberId });
      } }} />
    </span>;
  };

  const children: ReactNode[] = [];
  if (surface.prefill) children.push(token(surface.prefill.memberId, surface.prefill.text, "prefill", true));
  let end = 0;
  for (const mention of surface.value.mentions) {
    children.push(surface.value.text.slice(end, mention.start),
      token(mention.memberId, surface.value.text.slice(mention.start, mention.end), String(mention.start), false));
    end = mention.end;
  }
  children.push(surface.value.text.slice(end));
  if (!surface.value.text || surface.value.text.endsWith("\n")) children.push(<br key="tail" data-group-draft-tail />);

  return <div key={surface.revision} ref={root} className={`chat-composer__input ${styles.composerField}`} data-group-composer-input
    contentEditable={disabled ? false : "plaintext-only"} suppressContentEditableWarning aria-disabled={disabled} aria-label={label}
    role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={Boolean(activeOption)}
    aria-controls={activeOption ? menuId : undefined} aria-activedescendant={activeOption}
    onInput={event => reportChange(event.currentTarget)}
    onKeyDown={event => { if (!composing.current && event.target === event.currentTarget) onKeyDown(event, fieldSelection(event.currentTarget)); }}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; reportChange(event.currentTarget); }}
    onCopy={event => copySelection(event, false)} onCut={event => copySelection(event, true)} onPaste={onPaste}
    onClick={onDismissMenu} onBlur={onDismissMenu}>
    {children}
  </div>;
});

export default GroupChatComposerInput;
