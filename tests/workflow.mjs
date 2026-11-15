import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
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
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const code = await build({
  stdin: {
    contents: `export {default as Plugin} from './main.ts'; export {AnnotationStore} from './src/storage/annotationStore.ts'; export {PdfAnnotationLayer} from './src/pdf/pdfAnnotationLayer.ts'; export * from './src/editor/sourceProjection.ts'; export {refreshReadingViewHighlights} from './src/editor/readingViewHighlight.ts'; export {createTextAnchor} from './src/anchor/textAnchor.ts'; export {MarkdownView,TFile,FileSystemAdapter} from 'obsidian';`,
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
  Plugin,
  AnnotationStore,
  PdfAnnotationLayer,
  MarkdownView,
  TFile,
  FileSystemAdapter,
  mapRenderedSource,
  renderedSelectionOffsets,
  createTextAnchor,
  refreshReadingViewHighlights,
} = module.exports;
for (const [name, fn] of Object.entries({
  createEl(tag, options = {}) {
    const child = this.ownerDocument.createElement(tag);
    if (options.cls) child.className = options.cls;
    if (options.text) child.textContent = options.text;
    for (const [k, v] of Object.entries(options.attr ?? {}))
      child.setAttribute(k, v);
    this.append(child);
    return child;
  },
  createDiv(options = {}) {
    return this.createEl("div", options);
  },
  createSpan(options = {}) {
    return this.createEl("span", options);
  },
  toggleClass(n, v) {
    this.classList.toggle(n, v);
  },
  addClass(n) {
    this.classList.add(n);
  },
  empty() {
    this.replaceChildren();
  },
}))
  Object.defineProperty(window.HTMLElement.prototype, name, {
    value: fn,
    configurable: true,
  });
const make = (html) => {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
};
const source =
  "# 测试标题\n\n第一段视频模型。\n\n第二段其他文字。\n\n| 字段 | 内容 |\n| --- | --- |\n| 名称 | 视频模型 |\n";
const host = make(
  '<div class="markdown-preview-view"><div class="markdown-preview-sizer markdown-preview-section"><div class="mod-header"><div class="inline-title">文件标题</div></div><div class="el-h1"><h1>测试标题</h1></div><div class="el-p"><p>第一段视频模型。</p></div><div class="el-p"><p>第二段其他文字。</p></div><div class="el-table"><table><tr><th>字段</th><th>内容</th></tr><tr><td>名称</td><td>视频模型</td></tr></table></div><div class="mod-footer">反向链接</div></div></div>',
);
const view = new MarkdownView();
view.file = new TFile("workflow.md");
view.containerEl = host;
view.getViewData = () => source;
view.getMode = () => "preview";
view.previewMode = {
  containerEl: host.firstChild,
  getScroll: () => 12,
  applyScroll: () => {},
  rerender: () => {},
};
const app = {
  workspace: {
    getLeavesOfType: (type) => (type === "markdown" ? [{ view }] : []),
    getMostRecentLeaf: () => ({ view }),
  },
  vault: { getAbstractFileByPath: () => view.file },
};
const plugin = new Plugin(app);
const range = document.createRange();
const first = host.querySelectorAll("p")[0].firstChild;
range.setStart(first, 3);
range.setEnd(first, 7);
document.getSelection().removeAllRanges();
document.getSelection().addRange(range);
const selected = await plugin.resolveSelection(document, false);
assert.equal(
  selected?.selectedText,
  "视频模型",
  "真实预览容器含标题、多个块和表格时，段落选区仍须可创建标注",
);
assert.equal(selected.startOffset, source.indexOf("视频模型"));
const mark = {
  id: "workflow-mark",
  color: "yellow",
  anchor: createTextAnchor(source, selected.startOffset, selected.endOffset),
  createdAt: "",
};
refreshReadingViewHighlights(view.previewMode.containerEl, [mark], {
  source,
  filePath: view.file.path,
});
assert.equal(
  host.querySelectorAll(".axl-reading-highlight").length,
  1,
  "完整预览渲染必须显示段落标注",
);
assert.equal(
  host.querySelector("table .axl-reading-highlight"),
  null,
  "同词表格不得串标",
);
const firstParagraph = host.querySelectorAll("p")[0],
  secondParagraph = host.querySelectorAll("p")[1];
range.setStart(firstParagraph.firstChild, 0);
range.setEnd(secondParagraph.firstChild, 4);
document.getSelection().removeAllRanges();
document.getSelection().addRange(range);
const cross = await plugin.resolveSelection(document, false);
assert.equal(cross?.startOffset, source.indexOf("第一段"));
assert.equal(
  cross?.endOffset,
  source.indexOf("第二段") + 4,
  "跨段落选区应按源码顺序合并",
);
const surface = plugin.surface(document);
const colorButton = document.querySelector(".axl-toolbar-color");
const mouseDown = new window.MouseEvent("mousedown", {
  bubbles: true,
  cancelable: true,
});
assert.equal(
  colorButton.dispatchEvent(mouseDown),
  false,
  "点击工具条必须保留正文选区，不能让浏览器焦点先折叠选区",
);
surface.toolbar.destroy();
surface.popover.destroy();
console.log(
  "通过：完整预览结构、阅读选区、跨段选区、表格隔离、工具条真实焦点事件",
);
for (const [source, html] of [
  [
    "含公式 $x^2$ 的邻近文字。",
    '<p>含公式 <span class="math">x²</span> 的邻近文字。</p>',
  ],
  [
    "脚注附近文字[^n]。\n\n[^n]: 注脚说明。",
    '<p>脚注附近文字<sup class="footnote-ref">1</sup>。</p>',
  ],
  ["带块ID的文字。 ^audit-block", "<p>带块ID的文字。</p>"],
  [
    "中文引号”**强调短语：**后面的正文。",
    "<p>中文引号”<strong>强调短语：</strong>后面的正文。</p>",
  ],
]) {
  const element = make(html);
  assert.ok(
    mapRenderedSource(element, source).units.length,
    "公式、脚注、块ID或强调语法不得阻断同段正文定位：" + source,
  );
}
console.log("通过：公式相邻正文、脚注引用、块 ID、中文标点旁强调");

// 文件系统适配器执行真实写入与原子替换，故障注入不能只验证内存 Map。
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "axl-workflow-"));
let failing = false;
const adapter = {
  getFullPath: (name) => path.join(directory, name),
  exists: async (name) => {
    try {
      await fs.access(path.join(directory, name));
      return true;
    } catch {
      return false;
    }
  },
  mkdir: (name) => fs.mkdir(path.join(directory, name), { recursive: true }),
  read: (name) => fs.readFile(path.join(directory, name), "utf8"),
  write: async (name, text) => {
    if (failing && name.endsWith(".tmp")) throw new Error("磁盘写入失败");
    await fs.writeFile(path.join(directory, name), text);
  },
  rename: (from, to) =>
    fs.rename(path.join(directory, from), path.join(directory, to)),
  remove: (name) => fs.unlink(path.join(directory, name)),
};
Object.setPrototypeOf(adapter, FileSystemAdapter.prototype);
const storageApp = { vault: { adapter, cachedRead: async () => source } };
try {
  let store = new AnnotationStore(storageApp);
  await store.initialize();
  const file = new TFile("A.md");
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      store.addHighlight(file, { ...mark, id: `concurrent-${i}` }),
    ),
  );
  store = new AnnotationStore(storageApp);
  await store.initialize();
  assert.equal(
    (await store.getDocument(file)).highlights.length,
    12,
    "并发新增后重新读盘不得丢记录",
  );
  const original = await adapter.read(store.toSidecarPath(file.path));
  failing = true;
  await assert.rejects(
    store.addHighlight(file, { ...mark, id: "failed-write" }),
  );
  assert.equal(await adapter.read(store.toSidecarPath(file.path)), original);
  assert.equal(
    store.getCachedDocument(file.path).highlights.length,
    12,
    "写入失败不得把未保存的快照当作成功缓存",
  );
  failing = false;
  await Promise.all([
    store.migrateFilePath(file.path, new TFile("Renamed.md")),
    store.addHighlight(new TFile("B.md"), { ...mark, id: "other-document" }),
  ]);
  const reopened = new AnnotationStore(storageApp);
  await reopened.initialize();
  assert.equal(
    (await reopened.getDocument(new TFile("Renamed.md"))).highlights.length,
    12,
  );
  assert.equal(
    (await reopened.getDocument(new TFile("B.md"))).highlights.length,
    1,
  );
  const bad = new TFile("Corrupt.md"),
    badPath = store.toSidecarPath(bad.path);
  await adapter.write(badPath, "{ damaged");
  await assert.rejects(reopened.getDocument(bad));
  await assert.rejects(reopened.addHighlight(bad, mark));
  assert.equal(
    await adapter.read(badPath),
    "{ damaged",
    "损坏旁注不得被空文档覆盖",
  );
  await adapter.write(
    badPath,
    JSON.stringify({
      filePath: bad.path,
      fileHash: "",
      lastModified: "",
      highlights: "wrong-type",
    }),
  );
  await assert.rejects(
    new AnnotationStore(storageApp).getDocument(bad),
    "合法 JSON 的错误字段也须拒绝",
  );
  await reopened.removeAnnotation(new TFile("B.md"), "other-document");
  assert.equal(
    (await reopened.getDocument(new TFile("B.md"))).highlights.length,
    0,
  );
  console.log(
    "通过：真实文件系统、12 路并发新增、重命名与跨文档并发、重启读盘、写入失败、损坏 JSON 与错误字段保护、删除",
  );
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}

const pdfHost = make(
  '<div class="workspace-leaf-content" data-type="pdf"><div class="pdf-viewer"><div class="page" data-page-number="1"><div class="textLayer"><span>PDF 验收文字</span></div></div></div></div>',
);
const pdfView = { containerEl: pdfHost, file: new TFile("A.pdf") };
const pdfApp = {
  workspace: {
    getMostRecentLeaf: () => ({ view: pdfView }),
    getLeavesOfType: (type) => (type === "pdf" ? [{ view: pdfView }] : []),
  },
};
const added = [];
const layer = new PdfAnnotationLayer(
  {
    app: pdfApp,
    addHighlight: async (file, annotation) =>
      added.push({ file: file.path, annotation }),
  },
  document,
);
pdfHost.querySelector(".page").getBoundingClientRect = () => ({
  left: 0,
  top: 0,
  width: 600,
  height: 800,
});
document.elementFromPoint = () => pdfHost.querySelector(".textLayer span");
const pdfRange = document.createRange();
pdfRange.setStart(pdfHost.querySelector("span").firstChild, 0);
pdfRange.setEnd(pdfHost.querySelector("span").firstChild, 3);
pdfRange.getClientRects = () => [{ left: 10, top: 10, width: 60, height: 15 }];
document.getSelection().removeAllRanges();
document.getSelection().addRange(pdfRange);
layer.captureSelection();
document.getSelection().removeAllRanges();
await layer.createHighlight("yellow");
assert.equal(added.length, 0, "清除 PDF 选区后不得沿用旧快照");
document.getSelection().addRange(pdfRange);
layer.captureSelection();
pdfView.file = new TFile("B.pdf");
document.getSelection().removeAllRanges();
await layer.createHighlight("yellow");
assert.equal(added.length, 0, "切换 PDF 后不得把旧选区写入旧文件");
document.getSelection().addRange(pdfRange);
await layer.createHighlight("green");
assert.equal(added.length, 1);
assert.equal(added[0].file, "B.pdf");
assert.equal(added[0].annotation.anchor.rects[0].pageNumber, 1);
layer.destroy();
console.log("通过：PDF 取消选区、切换文件隔离、实际选区与页面相对坐标");
dom.window.close();
