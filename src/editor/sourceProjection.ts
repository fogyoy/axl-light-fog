/** Markdown 语法树的字符坐标投影；只有完整块或确定的表格单元格才能对应到 DOM。 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";
import { decodeString } from "micromark-util-decode-string";
import diff from "fast-diff";
import type { Nodes } from "mdast";

export interface SourceSpan {
  from: number;
  to: number;
}
interface Unit extends SourceSpan {
  char: string;
}
interface SourceBlock extends SourceSpan {
  type: string;
  units: Unit[];
  cells?: Unit[][][];
  cellRanges?: SourceSpan[][];
}
interface DomUnit {
  node: Text;
  offset: number;
  char: string;
}
export interface MappedUnit extends DomUnit, SourceSpan {}
export interface RenderedMapping {
  units: MappedUnit[];
  candidates: SourceSpan[];
  confirmed: boolean;
}
export interface ProjectionHint {
  from: number;
  to: number;
}
const cellScopes = new WeakMap<
  HTMLElement,
  { source: string; range: SourceSpan }
>();
export function editorCellScope(
  element: HTMLElement,
  source: string,
  value: string,
): SourceSpan | null {
  const cell = element.closest<HTMLElement>("td,th");
  const scope = cell ? cellScopes.get(cell) : undefined;
  return scope?.source === source &&
    source.slice(scope.range.from, scope.range.to) === value
    ? scope.range
    : null;
}
const cache = new Map<string, { units: Unit[]; blocks: SourceBlock[] }>();
const blockSelector = "h1,h2,h3,h4,h5,h6,p,ul,ol,pre,table,blockquote,.callout";
const ignoredContent =
  "script,style,button,textarea,input,svg,.heading-collapse-indicator,.list-collapse-indicator,.callout-title,.callout-icon,.copy-code-button,.math,.footnote-ref,.footnote-backref,.mod-header,.mod-footer,.metadata-container,.frontmatter,.inline-title,.heading-connector,.heading-indicator,.internal-embed,.axl-sidebar,.axl-annotation-popover,.axl-sticky-note";
// 阅读渲染的行范围只对当次源码有效，不能在文档编辑后沿用。
const renderedScopes = new WeakMap<
  HTMLElement,
  { source: string; hint: ProjectionHint }
>();

function normalize(units: Unit[]): Unit[] {
  return units.filter((unit) => !/[\s\u200b\ufeff]/u.test(unit.char));
}
function stringOf(units: { char: string }[]): string {
  return units.map((unit) => unit.char).join("");
}
function rawUnits(raw: string, start: number): Unit[] {
  const units: Unit[] = [];
  const expression =
    /\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]|&(?:#[xX][\da-fA-F]+;|#\d+;|[A-Za-z][\dA-Za-z]+;)/y;
  for (let index = 0; index < raw.length; ) {
    expression.lastIndex = index;
    const match = expression.exec(raw);
    const consumed = match?.[0] ?? raw[index];
    const decoded = match ? decodeString(consumed) : consumed;
    for (let offset = 0; offset < decoded.length; offset++)
      units.push({
        char: decoded[offset],
        from: start + index,
        to: start + index + consumed.length,
      });
    index += consumed.length;
  }
  return units;
}
function leafUnits(node: Nodes, source: string): Unit[] {
  if (!("value" in node) || !node.position) return [];
  let from = node.position.start.offset ?? 0;
  const to = node.position.end.offset ?? from;
  let raw = source.slice(from, to);
  if (node.type === "code") {
    const fence = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.exec(raw);
    if (fence) {
      from += fence[0].length;
      raw = raw.slice(fence[0].length);
      const closing = new RegExp(
        "(?:\\r?\\n)? {0,3}" +
          fence[1][0] +
          "{" +
          fence[1].length +
          ",}[ \\t]*$",
      );
      raw = raw.replace(closing, "");
    }
  } else if (node.type === "inlineCode") {
    const length = /^`+/.exec(raw)?.[0].length ?? 0;
    from += length;
    raw = raw.slice(length, raw.length - length);
  }
  let decoded =
    node.type === "text"
      ? rawUnits(raw, from)
      : Array.from({ length: raw.length }, (_, index) => ({
          char: raw[index],
          from: from + index,
          to: from + index + 1,
        }));
  const aligned: Unit[] = [];
  let offset = 0;
  for (const [kind, text] of diff(stringOf(decoded), node.value)) {
    if (kind === 0) {
      aligned.push(...decoded.slice(offset, offset + text.length));
      offset += text.length;
    } else if (kind === -1) offset += text.length;
    else {
      const left = decoded[Math.max(0, offset - 1)],
        right = decoded[Math.min(offset, decoded.length - 1)];
      if (left && right)
        for (const char of text)
          aligned.push({ char, from: left.from, to: right.to });
    }
  }
  decoded = aligned;
  if (node.type === "text") {
    const text = stringOf(decoded),
      hidden = new Set<number>();
    const hide = (start: number, end: number): void => {
      for (let i = start; i < end; i++) hidden.add(i);
    };
    for (const match of text.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
      const at = match.index;
      if (match[0].startsWith("!")) hide(at, at + match[0].length);
      else {
        const pipe = match[0].lastIndexOf("|");
        hide(at, at + (pipe >= 0 ? pipe + 1 : 2));
        hide(at + match[0].length - 2, at + match[0].length);
      }
    }
    for (const match of text.matchAll(/==([^=]+)==|%%[\s\S]*?%%/g)) {
      const at = match.index;
      if (match[0].startsWith("%%")) hide(at, at + match[0].length);
      else {
        hide(at, at + 2);
        hide(at + match[0].length - 2, at + match[0].length);
      }
    }
    const callout = /^\[![^\]]+\][+-]?[^\n]*(?:\n|$)/.exec(text);
    if (callout) hide(0, callout[0].length);
    const blockId = /\s\^[\w-]+$/.exec(text);
    if (
      blockId &&
      decoded[blockId.index + 1]?.to - decoded[blockId.index + 1]?.from === 1
    )
      hide(blockId.index, text.length);
    decoded = decoded.filter((_, index) => !hidden.has(index));
  }
  if (node.type === "html") {
    const hidden = new Set<number>();
    for (const match of raw.matchAll(/<[^>]*>/g))
      for (let i = match.index; i < match.index + match[0].length; i++)
        hidden.add(i);
    decoded = rawUnits(raw, from).filter(
      (unit) => !hidden.has(unit.from - from),
    );
  }
  return normalize(decoded);
}
function parse(source: string): { units: Unit[]; blocks: SourceBlock[] } {
  const cached = cache.get(source);
  if (cached) return cached;
  const tree = fromMarkdown(source, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  const blocks: SourceBlock[] = [];
  const yaml =
    /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(source)?.[0]
      .length ?? 0;
  const visit = (node: Nodes): Unit[] => {
    if ((node.position?.end.offset ?? 0) <= yaml) return [];
    if (
      node.type === "definition" ||
      node.type === "inlineMath" ||
      node.type === "math" ||
      node.type === "image" ||
      node.type === "imageReference"
    )
      return [];
    const units =
      "children" in node
        ? node.children.flatMap((child) => visit(child))
        : leafUnits(node, source);
    if (
      node.position &&
      [
        "heading",
        "paragraph",
        "table",
        "blockquote",
        "list",
        "listItem",
        "code",
        "html",
        "root",
      ].includes(node.type)
    ) {
      const block: SourceBlock = {
        from: node.position.start.offset ?? 0,
        to: node.position.end.offset ?? source.length,
        type: node.type,
        units,
      };
      if (node.type === "table") {
        block.cells = node.children.map((row) =>
          row.children.map((cell) =>
            cell.children.flatMap((child) => visit(child)),
          ),
        );
        block.cellRanges = node.children.map((row) =>
          row.children.map((cell) => {
            let start = cell.position?.start.offset ?? 0,
              end = cell.position?.end.offset ?? start;
            if (source[start] === "|") start++;
            if (source[end - 1] === "|") {
              let escapes = 0;
              for (let at = end - 2; at >= start && source[at] === "\\"; at--)
                escapes++;
              if (escapes % 2 === 0) end--;
            }
            const raw = source.slice(start, end),
              leading = raw.length - raw.trimStart().length;
            return {
              from: start + leading,
              to: end - (raw.length - raw.trimEnd().length),
            };
          }),
        );
      }
      blocks.push(block);
    }
    return units;
  };
  const units = visit(tree),
    result = { units, blocks };
  if (cache.size >= 8) cache.delete(cache.keys().next().value ?? "");
  cache.set(source, result);
  return result;
}
function domUnits(root: Node): DomUnit[] {
  const result: DomUnit[] = [];
  if (!root.ownerDocument) return result;
  const walker = root.ownerDocument.createTreeWalker(root, 4, {
    acceptNode(node) {
      const parent = node.parentElement;
      return !parent || parent.closest(ignoredContent) ? 2 : 1;
    },
  });
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      for (let index = 0; index < text.length; index++)
        if (!/[\s\u200b\ufeff]/u.test(text[index]))
          result.push({ node: node as Text, offset: index, char: text[index] });
    }
    node = walker.nextNode();
  }
  return result;
}
function pair(source: Unit[], dom: DomUnit[]): MappedUnit[] | null {
  if (stringOf(source) !== stringOf(dom)) {
    // Obsidian 对中文标点旁的强调分隔符比 CommonMark 宽松。
    // 仅允许源码里未转义的排版分隔符被渲染器消费，绝不删除正文或搜索近似词。
    const aligned: Unit[] = [];
    let offset = 0;
    for (const [kind, text] of diff(stringOf(source), stringOf(dom))) {
      if (kind === 0) {
        aligned.push(...source.slice(offset, offset + text.length));
        offset += text.length;
      } else if (
        kind === -1 &&
        /^(?:\*{1,3}|_{1,3}|~{2}|={2})$/.test(text) &&
        source
          .slice(offset, offset + text.length)
          .every((unit) => unit.to - unit.from === 1)
      )
        offset += text.length;
      else return null;
    }
    source = aligned;
  }
  return dom.map((unit, index) => ({
    ...unit,
    from: source[index].from,
    to: source[index].to,
  }));
}
export function mapRenderedSource(
  root: HTMLElement,
  source: string,
  hint?: ProjectionHint,
): RenderedMapping {
  const scope = renderedScopes.get(root);
  hint ??= scope?.source === source ? scope.hint : undefined;
  if (root.closest(ignoredContent))
    return { units: [], candidates: [], confirmed: false };
  const roots = Array.from(
    root.querySelectorAll<HTMLElement>(blockSelector),
  ).filter((element) => {
    if (element.closest(ignoredContent)) return false;
    const parent = element.parentElement?.closest(blockSelector);
    return !parent || parent === root || !root.contains(parent);
  });
  if (!root.matches(blockSelector) && roots.length > 1) {
    const units = parse(source).units.filter(
      (unit) => !hint || (unit.from >= hint.from && unit.to <= hint.to),
    );
    const complete = pair(units, domUnits(root));
    if (complete) {
      // 只有完整源码与完整可见内容一一相等时，才使用文档顺序区分重复块。
      for (const child of roots) {
        const childUnits = complete.filter((unit) => child.contains(unit.node));
        if (childUnits.length)
          renderedScopes.set(child, {
            source,
            hint: {
              from: childUnits[0].from,
              to: childUnits[childUnits.length - 1].to,
            },
          });
        if (child.matches("table"))
          mapSingleBlock(child, source, renderedScopes.get(child)?.hint);
      }
      return {
        units: complete,
        candidates: [hint ?? { from: 0, to: source.length }],
        confirmed: true,
      };
    }
    const mappings = roots.map((child) =>
      mapRenderedSource(
        child,
        source,
        renderedScopes.get(child)?.source === source
          ? renderedScopes.get(child)?.hint
          : hint,
      ),
    );
    return {
      units: mappings.flatMap((mapping) => mapping.units),
      candidates: mappings.flatMap((mapping) => mapping.candidates),
      confirmed: mappings.every((mapping) => mapping.confirmed),
    };
  }
  const mapping = mapSingleBlock(root, source, hint);
  if (mapping.confirmed && mapping.candidates.length === 1) {
    renderedScopes.set(root, { source, hint: mapping.candidates[0] });
    if (roots.length === 1)
      renderedScopes.set(roots[0], { source, hint: mapping.candidates[0] });
  }
  return mapping;
}
function mapSingleBlock(
  root: HTMLElement,
  source: string,
  hint?: ProjectionHint,
): RenderedMapping {
  const parsed = parse(source),
    dom = domUnits(root);
  const table = root.matches("table") ? root : root.querySelector("table");
  let blocks = parsed.blocks.filter(
    (block) =>
      !hint ||
      (hint.from === hint.to
        ? block.from <= hint.from && block.to >= hint.from
        : block.from < hint.to && block.to > hint.from),
  );
  if (table) blocks = blocks.filter((block) => block.type === "table");
  else {
    const tag = root.matches(blockSelector)
      ? root.tagName
      : root.children.length === 1
        ? root.children[0].tagName
        : root.tagName;
    const type = /^H[1-6]$/.test(tag)
      ? "heading"
      : tag === "P"
        ? "paragraph"
        : /^(UL|OL)$/.test(tag)
          ? "list"
          : tag === "PRE"
            ? "code"
            : null;
    if (type) blocks = blocks.filter((block) => block.type === type);
  }
  const complete = hint
    ? pair(
        parsed.units.filter(
          (unit) => unit.from >= hint.from && unit.to <= hint.to,
        ),
        dom,
      )
    : null;
  if (complete && hint && !table)
    return { units: complete, candidates: [hint], confirmed: true };
  let matches = blocks.filter((block) => pair(block.units, dom) !== null);
  // 编辑中的表格单元格显示源码，完整 DOM 文本会不同；可信位置提示可确定具体表格。
  if (!matches.length && table && hint)
    matches = blocks.filter((block) => block.type === "table");
  const unique = new Map<string, SourceBlock>();
  for (const block of matches)
    unique.set(
      block.units.map((unit) => `${unit.from}:${unit.to}`).join(","),
      block,
    );
  matches = [...unique.values()];
  if (matches.length !== 1)
    return {
      units: [],
      candidates: matches.length
        ? matches
        : hint
          ? blocks.filter((block) =>
              hint.from === hint.to
                ? block.from <= hint.from && block.to >= hint.from
                : block.from >= hint.from && block.to <= hint.to,
            )
          : [],
      confirmed: false,
    };
  const block = matches[0];
  if (table && block.cells) {
    const rows = Array.from(table.querySelectorAll("tr")).filter(
      (row) => row.closest("table") === table,
    );
    if (rows.length !== block.cells.length)
      return { units: [], candidates: [block], confirmed: false };
    const mapped: MappedUnit[] = [];
    let confirmed = true;
    for (let r = 0; r < rows.length; r++) {
      const cells = Array.from(rows[r].children).filter(
        (cell): cell is HTMLElement =>
          cell.nodeType === 1 && /^(TD|TH)$/.test(cell.tagName),
      );
      if (cells.length !== block.cells[r].length) {
        confirmed = false;
        continue;
      }
      for (let c = 0; c < cells.length; c++) {
        const units = block.cells[r][c],
          cell = cells[c];
        const range = block.cellRanges?.[r]?.[c];
        if (range) cellScopes.set(cell, { source, range });
        if (units.length) {
          cell.dataset.axlSourceFrom = String(units[0].from);
          cell.dataset.axlSourceTo = String(units[units.length - 1].to);
        }
        if (cell.querySelector(".cm-editor")) continue;
        const cellMap = pair(units, domUnits(cell));
        if (cellMap) mapped.push(...cellMap);
        else confirmed = false;
      }
    }
    return { units: mapped, candidates: [block], confirmed };
  }
  const mapped = pair(block.units, dom);
  return {
    units: mapped ?? [],
    candidates: [block],
    confirmed: Boolean(mapped),
  };
}
export function renderedSelectionOffsets(
  mapping: RenderedMapping,
  range: Range,
): SourceSpan | null {
  const selected = mapping.units.filter(
    (unit) =>
      range.comparePoint(unit.node, unit.offset) === 0 &&
      range.comparePoint(unit.node, unit.offset + 1) === 0,
  );
  if (!selected.length) return null;
  const ancestor =
    range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  if (ancestor && "tagName" in ancestor) {
    // 部分段落定位失败时，不能只用成功的半段构造一个看似有效的选区。
    const expected = domUnits(ancestor).filter(
      (unit) =>
        range.comparePoint(unit.node, unit.offset) === 0 &&
        range.comparePoint(unit.node, unit.offset + 1) === 0,
    );
    if (
      expected.some(
        (unit) =>
          !selected.some(
            (mapped) =>
              mapped.node === unit.node && mapped.offset === unit.offset,
          ),
      )
    )
      return null;
  }
  return {
    from: Math.min(...selected.map((unit) => unit.from)),
    to: Math.max(...selected.map((unit) => unit.to)),
  };
}
export function sourceRangeForLines(
  source: string,
  lineStart: number,
  lineEnd: number,
): ProjectionHint {
  const lines = source.split("\n");
  const from = lines
    .slice(0, lineStart)
    .reduce((sum, line) => sum + line.length + 1, 0);
  return {
    from,
    to: Math.min(
      source.length,
      from +
        lines
          .slice(lineStart, lineEnd + 1)
          .reduce((sum, line) => sum + line.length + 1, 0),
    ),
  };
}
