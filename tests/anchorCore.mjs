import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
const require = createRequire(import.meta.url),
  root = fileURLToPath(new URL("../", import.meta.url));
const dom = new JSDOM("<!doctype html><body></body>", {
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "Window",
])
  globalThis[name] = dom.window[name];
const code = await build({
  stdin: {
    contents: `export * from './src/anchor/textAnchor.ts'; export * from './src/editor/sourceProjection.ts'; export * from './src/editor/readingViewHighlight.ts'; export {AnnotationStore} from './src/storage/annotationStore.ts'; export {default as Plugin} from './main.ts'; export {createHighlightExtension,refreshHighlightsEffect} from './src/editor/highlightExtension.ts'; export {MarkdownView,TFile,editorInfoField} from 'obsidian';`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["@codemirror/state", "@codemirror/view"],
  alias: { obsidian: root + "tests/obsidian.mjs" },
});
const module = { exports: {} };
new Function("require", "module", "exports", code.outputFiles[0].text)(
  require,
  module,
  module.exports,
);
const {
  createTextAnchor,
  resolveTextAnchor,
  sourceChanges,
  mapTextAnchor,
  relocateDocumentAnchors,
  refreshReadingViewHighlights,
  mapRenderedSource,
  renderedSelectionOffsets,
  AnnotationStore,
  Plugin,
  MarkdownView,
  TFile,
  editorInfoField,
  createHighlightExtension,
  refreshHighlightsEffect,
} = module.exports;
const { ChangeSet } = require("@codemirror/state");
const make = (html) => {
  const element = document.createElement("div");
  element.innerHTML = html;
  document.body.append(element);
  return element;
};
const markAt = (source, text, index = 0, id = "m") => {
  let at = -1;
  for (let n = 0; n <= index; n++) at = source.indexOf(text, at + 1);
  assert.ok(at >= 0);
  return {
    id,
    color: "yellow",
    anchor: createTextAnchor(source, at, at + text.length),
    createdAt: "",
  };
};
const paint = (element, source, marks, hint) =>
  refreshReadingViewHighlights(element, marks, {
    source,
    filePath: "A.md",
    hint,
  });
const count = (element) =>
  element.querySelectorAll(".axl-reading-highlight").length;
const phrase = "视频模型";
const source = `# ${phrase}\n\n| 字段 | 说明 |\n| --- | --- |\n| 图像 | 图像/${phrase}完成的任务 |\n| 其他 | ${phrase} |\n`;
const table =
  "<table><thead><tr><th>字段</th><th>说明</th></tr></thead><tbody><tr><td>图像</td><td>图像/视频模型完成的任务</td></tr><tr><td>其他</td><td>视频模型</td></tr></tbody></table>";
let element = make(table);
paint(element, source, [markAt(source, phrase)]);
assert.equal(count(element), 0, "标题标注不得复制到同词表格");
paint(element, source, [markAt(source, phrase, 2)]);
assert.equal(count(element), 1);
assert.equal(
  element.querySelector("mark").closest("tr").textContent,
  "其他视频模型",
);
element = make("<p>视频模型，前一处。视频模型，后一处。</p>");
const repeats = element.textContent;
paint(element, repeats, [markAt(repeats, phrase, 1)]);
assert.equal(element.querySelector("p").firstChild.nodeType, 3);
assert.equal(
  element.querySelector("mark").previousSibling.textContent,
  "视频模型，前一处。",
);
element = make("<p>视频模组</p>");
paint(element, source, [markAt(source, phrase)]);
assert.equal(count(element), 0, "禁止模糊匹配其他文字");
const duplicates = "同词段落。\n\n同词段落。";
element = make("<p>同词段落。</p>");
const repeatedMark = markAt(duplicates, "同词段落", 1);
const pending = paint(element, duplicates, [repeatedMark]);
assert.equal(count(element), 0);
assert.ok(pending.has("m"), "无法区分相同块时应提示待确认");
paint(element, duplicates, [repeatedMark], { from: 7, to: duplicates.length });
assert.equal(count(element), 1);
console.log(
  "通过：标题/表格隔离、表格行列坐标、块内重复词、相似词拒绝、重复块歧义",
);
const syntaxCases = [
  {
    source:
      "**前文** 链接 [视频模型](https://example.com)；`视频模型`；Failure分析\\& 筛选候选。",
    html: "<p><strong>前文</strong> 链接 <a>视频模型</a>；<code>视频模型</code>；Failure分析&amp; 筛选候选。</p>",
    text: "视频模型",
    index: 1,
  },
  {
    source: "# 标题：==视频模型== 与 [[条目|视频模型]]",
    html: "<h1>标题：<mark>视频模型</mark> 与 <a>视频模型</a></h1>",
    text: "视频模型",
    index: 1,
  },
  {
    source: "> [!note]\n> 视频模型 **文字**\n> 下一行",
    html: '<div class="callout"><div class="callout-title">Note</div><div class="callout-content"><p>视频模型 <strong>文字</strong>\n下一行</p></div></div>',
    text: "视频模型",
    index: 0,
  },
  {
    source: "中文 😀 &amp; 视频模型",
    html: "<p>中文 😀 &amp; 视频模型</p>",
    text: "视频模型",
    index: 0,
  },
  {
    source: "| 一 | 二 |\n| --- | --- |\n| A<br>B | **视频模型**<br>视频模型 |",
    html: "<table><tr><th>一</th><th>二</th></tr><tr><td>A<br>B</td><td><strong>视频模型</strong><br>视频模型</td></tr></table>",
    text: "视频模型",
    index: 1,
  },
  {
    source: "# 视频模型\r\n\r\n视频模型",
    html: "<p>视频模型</p>",
    text: "视频模型",
    index: 1,
  },
];
for (const test of syntaxCases) {
  element = make(test.html);
  paint(element, test.source, [markAt(test.source, test.text, test.index)]);
  assert.equal(count(element), 1, test.source);
  assert.equal(
    element.querySelector(".axl-reading-highlight").textContent,
    test.text,
  );
}
element = make("<p>前 **文字** 与后</p>");
const escaped = "前 \\*\\*文字\\*\\* 与后";
const escapedMark = markAt(escaped, "文字");
paint(element, escaped, [escapedMark]);
assert.equal(count(element), 1);
console.log(
  "通过：粗体、链接、行内代码、Obsidian 高亮/双链、callout、实体、转义、换行、表格 HTML、emoji、CRLF",
);
const fenced = "```视频模型\n视频模型\n```";
element = make("<pre><code>视频模型\n</code></pre>");
paint(element, fenced, [markAt(fenced, phrase, 0)]);
assert.equal(count(element), 0, "代码块语言名称不得冒充正文");
paint(element, fenced, [markAt(fenced, phrase, 1)]);
assert.equal(count(element), 1);
element = make("<p>无关注释</p>");
const stale = {
  ...markAt("视频模型", phrase),
  anchor: { ...createTextAnchor("视频模型", 0, 4) },
};
paint(element, "无关注释", [stale], { from: 0, to: 4 });
assert.equal(count(element), 0, "过期偏移不能画到别的文字");
console.log("通过：代码围栏/语言与正文隔离、过期位置验证");
// 选区使用同一套坐标表，选择第二处不能回到第一处。
element = make("<p>视频模型，视频模型</p>");
const mapping = mapRenderedSource(element, "视频模型，视频模型");
const text = element.querySelector("p").firstChild;
const range = document.createRange();
range.setStart(text, 5);
range.setEnd(text, 9);
assert.deepEqual(renderedSelectionOffsets(mapping, range), { from: 5, to: 9 });
console.log("通过：渲染选区反向映射到第二处源码");
const before =
  "开头文字。\n\n视频模型，原注释位置。\n\n| 词 |\n| --- |\n| 视频模型 |";
const original = markAt(before, phrase),
  insert = "新增前缀\n";
let changes = ChangeSet.of({ from: 0, insert }, before.length),
  after = insert + before;
let located = mapTextAnchor(after, original.anchor, changes);
assert.equal(
  located.anchor.startOffset,
  original.anchor.startOffset + insert.length,
);
assert.equal(located.orphaned, false);
const removeTo = before.indexOf("\n\n|");
changes = ChangeSet.of(
  { from: original.anchor.startOffset, to: removeTo },
  before.length,
);
after = changes
  .apply(require("@codemirror/state").Text.of(before.split("\n")))
  .toString();
located = mapTextAnchor(after, original.anchor, changes);
assert.equal(located.orphaned, true);
const doc = {
  filePath: "A.md",
  fileHash: "",
  lastModified: "",
  highlights: [{ ...original, orphaned: true }],
  comments: [],
  pdfHighlights: [],
  pdfComments: [],
};
assert.equal(
  relocateDocumentAnchors(before, doc).highlights[0].orphaned,
  true,
  "失效位置不得因同词出现自动恢复",
);
const deleted = "| 词 |\n| --- |\n| 视频模型 |";
assert.equal(
  resolveTextAnchor(deleted, original.anchor).orphaned,
  true,
  "离线恢复不得绑定其他同词",
);
const context = "重复上下文".repeat(10),
  ambiguous = `${context}视频模型${context}\n${context}视频模型${context}`;
const ambiguityMark = markAt(ambiguous, phrase, 1);
assert.equal(
  resolveTextAnchor(ambiguous + "新增文字", ambiguityMark.anchor).orphaned,
  true,
);
for (const [old, next] of [
  ["abc视频模型def", "xxabc视频模型def"],
  ["abc视频模型def", "abc视频模型def尾部"],
  ["abc视频模型def", "abc视频模型def".replace("abc", "a")],
]) {
  const mark = markAt(old, phrase);
  const mapped = mapTextAnchor(next, mark.anchor, sourceChanges(old, next));
  assert.equal(
    next.slice(mapped.anchor.startOffset, mapped.anchor.endOffset),
    phrase,
  );
}
console.log(
  "通过：编辑插入/删除的精确映射、整处删除保留失效状态、离线同词拒绝、上下文歧义拒绝",
);
// Obsidian 自动排版会用一次整表替换，不能把词的标注扩展成整个表。
const unformatted =
  "# 表格\n\n| 场景 | 内容 |\n| --- | --- |\n| 未标注 | 标注同词 |\n| 有标注 | 表格标注 |";
const formatted = unformatted
  .replaceAll("| 场景 | 内容 |", "| 场景  | 内容   |")
  .replaceAll("| 未标注 | 标注同词 |", "| 未标注 | 标注同词    |")
  .replaceAll("| 有标注 | 表格标注 |", "| 有标注 | 表格标注    |");
const preciseMark = markAt(unformatted, "表格标注");
const coarse = ChangeSet.of(
  {
    from: unformatted.indexOf("|"),
    to: unformatted.length,
    insert: formatted.slice(formatted.indexOf("|")),
  },
  unformatted.length,
);
const normalized = relocateDocumentAnchors(
  formatted,
  { ...doc, highlights: [preciseMark], comments: [] },
  unformatted,
  coarse,
);
assert.equal(normalized.highlights[0].anchor.selectedText, "表格标注");
assert.equal(
  normalized.highlights[0].anchor.startOffset,
  formatted.indexOf("表格标注"),
);
assert.equal(
  normalized.highlights[0].anchor.endOffset -
    normalized.highlights[0].anchor.startOffset,
  4,
);
console.log("通过：整表替换和自动排版保持词级标注范围");

// 真实嵌套单元格只有经过语法树确认后才获得全文坐标。
const { EditorState, StateEffect } = require("@codemirror/state");
const { EditorView, Decoration, WidgetType } = require("@codemirror/view");
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(
  dom.window,
);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(
  dom.window,
);
const tableMark = markAt(source, phrase, 2);
let cellEditor, captured;
const extension = createHighlightExtension({
  getDocument: () => ({ ...doc, highlights: [tableMark] }),
  getSource: () => source,
  trackSource: () => {},
  getVersion: () => 1,
  onDocumentChange: () => () => {},
  rememberSelection: (_file, from, to) => {
    captured = { from, to };
  },
});
const sourceView = make("");
sourceView.className = "markdown-source-view";
const outer = new EditorView({
  parent: sourceView,
  state: EditorState.create({
    doc: source,
    extensions: [editorInfoField, extension],
  }),
});
class TableWidget extends WidgetType {
  toDOM() {
    const root = document.createElement("div");
    root.innerHTML = table;
    mapRenderedSource(root, source, {
      from: source.indexOf("|"),
      to: source.indexOf("|"),
    });
    const cell = root.querySelector("tbody tr:last-child td:last-child");
    cell.textContent = "";
    cellEditor = new EditorView({
      parent: cell,
      state: EditorState.create({
        doc: phrase,
        extensions: [editorInfoField],
      }),
    });
    return root;
  }
}
outer.dispatch({
  effects: StateEffect.appendConfig.of(
    EditorView.decorations.of(
      Decoration.set([
        Decoration.widget({ widget: new TableWidget() }).range(source.length),
      ]),
    ),
  ),
});
const tableController = new Plugin({ workspace: { detachLeavesOfType() {} } });
tableController.highlightExtension = extension;
tableController.refreshNestedEditors(sourceView);
tableController.refreshNestedEditors(sourceView);
assert.equal(
  cellEditor.dom.querySelector(".axl-highlight")?.textContent,
  phrase,
  "源码范围确认后，无需改变选区即可更新嵌套编辑器",
);
cellEditor.dispatch({ selection: { anchor: 0, head: 4 } });
assert.equal(
  cellEditor.dom.querySelector(".axl-highlight")?.textContent,
  phrase,
);
assert.deepEqual(captured, {
  from: tableMark.anchor.startOffset,
  to: tableMark.anchor.endOffset,
});
assert.equal(
  tableController.nestedEditorCompartments.size,
  1,
  "重复刷新不得重复注册单元格扩展",
);
tableController.onunload();
assert.equal(
  cellEditor.dom.querySelector(".axl-highlight"),
  null,
  "停用插件时必须移除单元格扩展",
);
cellEditor.destroy();
outer.destroy();
console.log("通过：真实表格单元格的高亮和选区使用已确认的全文坐标");

// 实际框架可给表格局部行号；侧栏自身的 Markdown 不属于原文投影。
const contextFile = new TFile("A.md");
const contextPlugin = new Plugin({
  vault: { getAbstractFileByPath: () => contextFile },
  workspace: { getLeavesOfType: () => [] },
});
contextPlugin.store = {
  getDocument: async () => ({ ...doc, highlights: [tableMark], comments: [] }),
  getSource: () => source,
};
const localTable = make(table);
await contextPlugin.renderReadingHighlights(localTable, {
  sourcePath: "A.md",
  getSectionInfo: () => ({
    text: source.slice(source.indexOf("|")),
    lineStart: 0,
    lineEnd: 3,
  }),
});
assert.equal(count(localTable), 1, "表格局部行号不能用作全文范围");
assert.equal(contextPlugin.pendingReadingLocations.get("A.md").size, 0);
const sidebarRoot = make(
  '<div class="axl-sidebar"><p>标注同词</p></div>',
).firstChild;
await contextPlugin.renderReadingHighlights(sidebarRoot.querySelector("p"), {
  sourcePath: "A.md",
  getSectionInfo: () => ({ text: source, lineStart: 0, lineEnd: 20 }),
});
assert.equal(count(sidebarRoot), 0, "插件自己的便签预览不参与原文高亮");
assert.equal(
  contextPlugin.pendingReadingLocations.get("A.md").size,
  0,
  "侧栏预览不能产生错误的位置待确认状态",
);
console.log("通过：表格局部渲染上下文、侧栏 Markdown 预览隔离");

// 跨窗口 DOM realm 与位置信息都来自实际被点击的视图。
const secondWindow = new JSDOM(
  '<!doctype html><body><div><mark class="axl-reading-highlight" data-axl-id="m" data-axl-file="A.md">视频模型</mark></div></body>',
);
const view = new MarkdownView();
view.file = new TFile("A.md");
view.containerEl = secondWindow.window.document.querySelector("div");
const app = {
  workspace: {
    getLeavesOfType: () => [{ view }],
    getMostRecentLeaf: () => ({ view }),
  },
};
const plugin = new Plugin(app);
let shown = 0;
plugin.store = {
  getCachedDocument: () => ({ ...doc, highlights: [original] }),
};
plugin.surface = (ownerDocument) => {
  assert.equal(ownerDocument, secondWindow.window.document);
  return { popover: { show: () => shown++, hide: () => {} } };
};
const click = {
  target: view.containerEl.querySelector("mark"),
  preventDefault() {},
  stopPropagation() {},
};
await plugin.handleAnnotationClick(click, secondWindow.window.document);
assert.equal(shown, 1);
click.target.dataset.axlFile = "B.md";
await plugin.handleAnnotationClick(click, secondWindow.window.document);
assert.equal(shown, 1, "跨文档伪标记应拒绝");
console.log("通过：独立窗口 DOM 实例、所属视图/文件校验、跨文档隔离");
// 使用真实 surface 绑定，模拟单元格编辑器阻止冒泡；仍须打开标注。
const ui = secondWindow.window;
for (const [name, fn] of Object.entries({
  createEl(tag, options = {}) {
    const child = this.ownerDocument.createElement(tag);
    if (options.cls) child.className = options.cls;
    if (options.text) child.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {}))
      child.setAttribute(key, value);
    this.append(child);
    return child;
  },
  createDiv(options = {}) {
    return this.createEl("div", options);
  },
  createSpan(options = {}) {
    return this.createEl("span", options);
  },
  toggleClass(name, value) {
    this.classList.toggle(name, value);
  },
  empty() {
    this.replaceChildren();
  },
}))
  Object.defineProperty(ui.HTMLElement.prototype, name, {
    value: fn,
    configurable: true,
  });
click.target.dataset.axlFile = "A.md";
const capturePlugin = new Plugin(app);
capturePlugin.store = plugin.store;
capturePlugin.registerDomEvent = (target, type, callback, options) =>
  target.addEventListener(type, callback, options);
const actualSurface = capturePlugin.surface(ui.document);
view.containerEl.addEventListener("click", (event) => event.stopPropagation());
click.target.dispatchEvent(
  new ui.MouseEvent("click", { bubbles: true, cancelable: true }),
);
assert.ok(
  ui.document.querySelector(".axl-annotation-popover.is-visible"),
  "单元格停止冒泡也应正常打开注释",
);
actualSurface.toolbar.destroy();
actualSurface.popover.destroy();
console.log("通过：单元格停止冒泡时的真实工具条/弹窗事件绑定");
secondWindow.window.close();
dom.window.close();
