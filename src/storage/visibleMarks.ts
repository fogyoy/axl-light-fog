import { CommentAnnotation, FileAnnotationDocument, HighlightAnnotation } from "./types";

export function attachedMarkdownComments(highlight: HighlightAnnotation, comments: CommentAnnotation[]): CommentAnnotation[] {
  return comments.filter((comment) => !comment.orphaned && (
    comment.highlightId === highlight.id ||
    (!comment.highlightId && comment.anchor.startOffset === highlight.anchor.startOffset &&
      comment.anchor.endOffset === highlight.anchor.endOffset &&
      comment.anchor.selectedText === highlight.anchor.selectedText)
  ));
}

export function visibleMarkdownMarks(document: FileAnnotationDocument): (HighlightAnnotation | CommentAnnotation)[] {
  const highlights = document.highlights.filter((highlight) => !highlight.orphaned);
  const attachedIds = new Set(highlights.flatMap((highlight) =>
    attachedMarkdownComments(highlight, document.comments).map((comment) => comment.id),
  ));
  return [...highlights, ...document.comments.filter((comment) => !comment.orphaned && !attachedIds.has(comment.id))];
}
