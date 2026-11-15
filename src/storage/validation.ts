/** 外部旁注的边界校验；损坏或未知结构不能伪装成空文档继续写入。 */
import {
  ANNOTATION_COLORS,
  type AnnotationIndex,
  type FileAnnotationDocument,
  type TextAnchor,
  type PdfAnchor,
} from "./types";
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function string(value: unknown): value is string {
  return typeof value === "string";
}
function optional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value);
}
function array(value: unknown, check: (value: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(check);
}
function textAnchor(value: unknown): value is TextAnchor {
  return (
    record(value) &&
    Number.isSafeInteger(value.startOffset) &&
    number(value.startOffset) &&
    value.startOffset >= 0 &&
    Number.isSafeInteger(value.endOffset) &&
    number(value.endOffset) &&
    value.endOffset >= value.startOffset &&
    string(value.selectedText) &&
    string(value.prefix) &&
    string(value.suffix) &&
    optional(value.sourceText, string) &&
    optional(value.isCode, (v) => typeof v === "boolean")
  );
}
function pdfAnchor(value: unknown): value is PdfAnchor {
  return (
    record(value) &&
    number(value.pageNumber) &&
    Number.isInteger(value.pageNumber) &&
    value.pageNumber >= 1 &&
    string(value.selectedText) &&
    number(value.createdScale) &&
    value.createdScale > 0 &&
    array(
      value.rects,
      (rect) =>
        record(rect) &&
        number(rect.pageNumber) &&
        rect.pageNumber >= 1 &&
        Number.isInteger(rect.pageNumber) &&
        ["left", "top", "width", "height"].every((key) => number(rect[key])) &&
        number(rect.width) &&
        rect.width > 0 &&
        number(rect.height) &&
        rect.height > 0,
    )
  );
}
function mark(value: unknown, pdf: boolean, comment: boolean): boolean {
  if (
    !record(value) ||
    !string(value.id) ||
    !value.id ||
    !ANNOTATION_COLORS.some((color) => color === value.color) ||
    !string(value.createdAt) ||
    !optional(value.orphaned, (v) => typeof v === "boolean") ||
    !(pdf ? pdfAnchor(value.anchor) : textAnchor(value.anchor))
  )
    return false;
  if (!comment) return true;
  return (
    string(value.content) &&
    optional(value.title, string) &&
    optional(value.highlightId, string) &&
    string(value.author) &&
    string(value.updatedAt) &&
    record(value.position) &&
    number(value.position.offsetX) &&
    number(value.position.offsetY) &&
    typeof value.collapsed === "boolean" &&
    typeof value.resolved === "boolean" &&
    array(
      value.replies,
      (reply) =>
        record(reply) &&
        string(reply.id) &&
        string(reply.content) &&
        string(reply.createdAt),
    )
  );
}
export function parseAnnotationDocument(
  value: unknown,
): FileAnnotationDocument {
  if (!record(value)) throw new Error("Invalid annotation document");
  const document = {
    ...value,
    highlights: value.highlights ?? [],
    comments: value.comments ?? [],
    pdfHighlights: value.pdfHighlights ?? [],
    pdfComments: value.pdfComments ?? [],
  };
  function valid(value: unknown): value is FileAnnotationDocument {
    return (
      record(value) &&
      string(value.filePath) &&
      string(value.fileHash) &&
      string(value.lastModified) &&
      array(value.highlights, (v) => mark(v, false, false)) &&
      array(value.comments, (v) => mark(v, false, true)) &&
      array(value.pdfHighlights, (v) => mark(v, true, false)) &&
      array(value.pdfComments, (v) => mark(v, true, true))
    );
  }
  if (!valid(document)) throw new Error("Invalid annotation document fields");
  return document;
}
export function parseAnnotationIndex(value: unknown): AnnotationIndex {
  function valid(value: unknown): value is AnnotationIndex {
    return (
      record(value) &&
      number(value.version) &&
      value.version === 1 &&
      record(value.files) &&
      Object.values(value.files).every(
        (entry) =>
          record(entry) &&
          string(entry.filePath) &&
          string(entry.sidecarPath) &&
          string(entry.fileHash) &&
          number(entry.highlightCount) &&
          number(entry.commentCount) &&
          string(entry.updatedAt),
      )
    );
  }
  if (!valid(value)) throw new Error("Invalid annotation index");
  return value;
}
