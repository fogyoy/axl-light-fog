/** 源码坐标驱动的 DOM 装饰，不使用选中文字搜索或模糊匹配。 */
import type {
  AnnotationColor,
  CommentAnnotation,
  HighlightAnnotation,
} from "../storage/types";
import { mapRenderedSource, type ProjectionHint } from "./sourceProjection";
export type ReadingMark = Pick<
  HighlightAnnotation | CommentAnnotation,
  "id" | "color" | "anchor" | "orphaned"
>;
const selector = ".axl-reading-highlight";
export function refreshReadingViewHighlights(
  root: HTMLElement,
  marks: ReadingMark[],
  options: { source: string; filePath: string; hint?: ProjectionHint },
): Set<string> {
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>(selector)))
    mark.replaceWith(...Array.from(mark.childNodes));
  root.normalize();
  const mapping = mapRenderedSource(root, options.source, options.hint);
  const byNode = new Map<
    Text,
    { from: number; to: number; mark: ReadingMark }[]
  >();
  const painted = new Set<string>();
  for (const mark of marks.filter((mark) => !mark.orphaned)) {
    if (
      options.source.slice(mark.anchor.startOffset, mark.anchor.endOffset) !==
      (mark.anchor.sourceText ?? mark.anchor.selectedText)
    )
      continue;
    const groups = new Map<Text, { from: number; to: number }>();
    for (const unit of mapping.units) {
      if (
        unit.from >= mark.anchor.endOffset ||
        unit.to <= mark.anchor.startOffset
      )
        continue;
      const group = groups.get(unit.node);
      if (group) {
        group.from = Math.min(group.from, unit.offset);
        group.to = Math.max(group.to, unit.offset + 1);
      } else groups.set(unit.node, { from: unit.offset, to: unit.offset + 1 });
    }
    for (const [node, range] of groups) {
      const entries = byNode.get(node) ?? [];
      entries.push({ ...range, mark });
      byNode.set(node, entries);
      painted.add(mark.id);
    }
  }
  for (const [node, entries] of byNode) {
    const content = node.data,
      fragment = root.ownerDocument.createDocumentFragment();
    const boundaries = [
      ...new Set([
        0,
        content.length,
        ...entries.flatMap((entry) => [entry.from, entry.to]),
      ]),
    ].sort((a, b) => a - b);
    for (let i = 0; i < boundaries.length - 1; i++) {
      const from = boundaries[i],
        to = boundaries[i + 1],
        active = entries.filter(
          (entry) => entry.from <= from && entry.to >= to,
        );
      const text = root.ownerDocument.createTextNode(content.slice(from, to));
      if (!active.length) {
        fragment.append(text);
        continue;
      }
      const mark = root.ownerDocument.createElement("mark");
      mark.className = `axl-reading-highlight axl-highlight axl-highlight--${active[0].mark.color}`;
      mark.dataset.axlId = active[0].mark.id;
      mark.dataset.axlIds = JSON.stringify(
        active.map((entry) => entry.mark.id),
      );
      mark.dataset.axlFile = options.filePath;
      mark.dataset.axlColor = active[0].mark.color;
      mark.style.setProperty(
        "background-color",
        highlightBackground(active[0].mark.color),
        "important",
      );
      mark.tabIndex = 0;
      mark.append(text);
      fragment.append(mark);
    }
    node.replaceWith(fragment);
  }
  return new Set(
    marks
      .filter(
        (mark) =>
          !painted.has(mark.id) &&
          mapping.candidates.some(
            (block) =>
              block.from < mark.anchor.endOffset &&
              block.to > mark.anchor.startOffset,
          ),
      )
      .map((mark) => mark.id),
  );
}
export function highlightBackground(color: AnnotationColor): string {
  const colors: Record<AnnotationColor, string> = {
    yellow: "rgba(245,197,24,.42)",
    orange: "rgba(255,140,0,.36)",
    pink: "rgba(255,105,180,.32)",
    green: "rgba(82,196,26,.30)",
    blue: "rgba(22,119,255,.28)",
    purple: "rgba(114,46,209,.30)",
  };
  return colors[color];
}
