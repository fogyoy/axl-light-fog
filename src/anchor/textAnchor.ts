/** 源码锚点：实时变更映射优先；离线恢复必须有唯一且充分的上下文证据。 */
import { ChangeSet, type ChangeDesc } from "@codemirror/state";
import diff from "fast-diff";
import { decodeString } from "micromark-util-decode-string";
import type {
  FileAnnotationDocument,
  LocatedAnchor,
  TextAnchor,
} from "../storage/types";

export function normalizeMarkdownSource(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

const CONTEXT_LENGTH = 32;
export function createTextAnchor(
  source: string,
  startOffset: number,
  endOffset: number,
): TextAnchor {
  const start = Math.max(0, Math.min(startOffset, source.length));
  const end = Math.max(start, Math.min(endOffset, source.length));
  const sourceText = source.slice(start, end);
  return {
    startOffset: start,
    endOffset: end,
    selectedText: sourceText,
    sourceText,
    prefix: source.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: source.slice(end, end + CONTEXT_LENGTH),
    isCode: isCodePosition(source, start) || /^[ \t]{4}/m.test(sourceText),
  };
}

function isCodePosition(source: string, offset: number): boolean {
  let fence: { char: string; length: number } | null = null;
  for (const line of source.slice(0, offset).split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!fence) fence = { char: match[1][0], length: match[1].length };
    else if (
      match[1][0] === fence.char &&
      match[1].length >= fence.length &&
      !match[2].trim()
    )
      fence = null;
  }
  return fence !== null;
}

export function resolveTextAnchor(
  source: string,
  anchor: TextAnchor,
  trustOffset = false,
): LocatedAnchor {
  const raw = anchor.sourceText ?? anchor.selectedText;
  const direct = source.slice(anchor.startOffset, anchor.endOffset);
  if (
    direct === raw ||
    (!anchor.sourceText && decodeString(direct) === anchor.selectedText)
  ) {
    if (trustOffset) {
      return {
        anchor: { ...anchor, sourceText: direct },
        orphaned: false,
        confidence: 1,
      };
    }
  }
  const candidates: number[] = [];
  if (
    direct !== raw &&
    decodeString(direct) === anchor.selectedText &&
    contextMatches(source, anchor.startOffset, anchor.endOffset, anchor)
  )
    candidates.push(anchor.startOffset);
  for (
    let at = raw ? source.indexOf(raw) : -1;
    at >= 0;
    at = source.indexOf(raw, at + 1)
  ) {
    if (contextMatches(source, at, at + raw.length, anchor))
      candidates.push(at);
  }
  if (candidates.length === 1) {
    const at = candidates[0];
    return {
      anchor: {
        ...createTextAnchor(source, at, at + raw.length),
        selectedText: anchor.selectedText,
      },
      orphaned: false,
      confidence: 1,
    };
  }
  return { anchor, orphaned: true, confidence: 0 };
}

function contextMatches(
  source: string,
  start: number,
  end: number,
  anchor: TextAnchor,
): boolean {
  const prefix = source.slice(Math.max(0, start - anchor.prefix.length), start);
  const suffix = source.slice(end, end + anchor.suffix.length);
  // 两边都核验，禁止仅凭一个同词或单侧相似上下文重新绑定。
  return (
    prefix === anchor.prefix &&
    suffix === anchor.suffix &&
    (anchor.prefix.length + anchor.suffix.length >= 8 ||
      (start === 0 && end === source.length))
  );
}

export function sourceChanges(before: string, after: string): ChangeSet {
  const changes: { from: number; to: number; insert: string }[] = [];
  let offset = 0;
  let pending: { from: number; to: number; insert: string } | null = null;
  for (const [kind, text] of diff(before, after)) {
    if (kind === 0) {
      if (pending) changes.push(pending);
      pending = null;
      offset += text.length;
    } else {
      pending ??= { from: offset, to: offset, insert: "" };
      if (kind === -1) {
        offset += text.length;
        pending.to = offset;
      } else pending.insert += text;
    }
  }
  if (pending) changes.push(pending);
  return ChangeSet.of(changes, before.length);
}

export function mapTextAnchor(
  source: string,
  anchor: TextAnchor,
  changes: ChangeDesc,
): LocatedAnchor {
  let deleted = false;
  let replacement: { from: number; to: number } | null = null;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (fromA <= anchor.startOffset && toA >= anchor.endOffset && fromA < toA) {
      if (fromB === toB) deleted = true;
      else replacement = { from: fromB, to: toB };
    }
  });
  if (deleted) return { anchor, orphaned: true, confidence: 0 };
  let start = changes.mapPos(anchor.startOffset, 1);
  let end = changes.mapPos(anchor.endOffset, -1);
  if (replacement) {
    const range: { from: number; to: number } = replacement;
    start = range.from;
    end = range.to;
  }
  if (start >= end) return { anchor, orphaned: true, confidence: 0 };
  const mapped = createTextAnchor(source, start, end);
  return {
    anchor: {
      ...mapped,
      selectedText:
        mapped.sourceText === (anchor.sourceText ?? anchor.selectedText)
          ? anchor.selectedText
          : mapped.selectedText,
    },
    orphaned: false,
    confidence: 1,
  };
}

export function relocateDocumentAnchors(
  source: string,
  document: FileAnnotationDocument,
  previousSource?: string,
  changes?: ChangeDesc,
  trustOffset = false,
): FileAnnotationDocument {
  const mapping =
    previousSource === undefined
      ? changes
      : changes
        ? refineSourceChanges(previousSource, source, changes)
        : sourceChanges(previousSource, source);
  const relocate = <T extends { anchor: TextAnchor; orphaned?: boolean }>(
    mark: T,
  ): T => {
    if (mark.orphaned) return mark;
    const located = mapping
      ? mapTextAnchor(source, mark.anchor, mapping)
      : resolveTextAnchor(source, mark.anchor, trustOffset);
    return { ...mark, anchor: located.anchor, orphaned: located.orphaned };
  };
  return {
    ...document,
    highlights: document.highlights.map(relocate),
    comments: document.comments.map(relocate),
  };
}

function refineSourceChanges(
  before: string,
  after: string,
  coarse: ChangeDesc,
): ChangeSet {
  const edits: { from: number; to: number; insert: string }[] = [];
  // 表格编辑器会把整个表格替换一次；只在框架给出的变更范围内细分，保留未改动字词的身份。
  coarse.iterChangedRanges((fromA, toA, fromB, toB) => {
    const local = sourceChanges(
      before.slice(fromA, toA),
      after.slice(fromB, toB),
    );
    local.iterChanges((from, to, _newFrom, _newTo, inserted) => {
      edits.push({
        from: fromA + from,
        to: fromA + to,
        insert: inserted.toString(),
      });
    });
  });
  return ChangeSet.of(edits, before.length);
}
