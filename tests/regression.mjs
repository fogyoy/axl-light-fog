import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { unlink } from "node:fs/promises";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
const require = createRequire(import.meta.url);
const { EditorState, StateEffect, StateField } = require("@codemirror/state");
const { EditorView, Decoration, WidgetType } = require("@codemirror/view");

const root = fileURLToPath(new URL("../", import.meta.url));
const dom = new JSDOM("<!doctype html><body></body>", {
  pretendToBeVisual: true,
});
for (const name of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "MutationObserver",
  "Window",
]) {
  Object.defineProperty(globalThis, name, {
    value: dom.window[name],
    configurable: true,
  });
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(
  dom.window,
);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(
  dom.window,
);
await build({
  stdin: {
    contents: `export {default as Plugin} from './main.ts'; export {AnnotationStore} from './src/storage/annotationStore.ts'; export {createHighlightExtension} from './src/editor/highlightExtension.ts'; export {MarkdownView, TFile, editorInfoField} from 'obsidian';`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: root + "tests/runtime.cjs",
  external: ["@codemirror/state", "@codemirror/view"],
  alias: { obsidian: root + "tests/obsidian.mjs" },
});
const {
  Plugin,
  AnnotationStore,
  createHighlightExtension,
  MarkdownView,
  TFile,
  editorInfoField,
} = createRequire(import.meta.url)("./runtime.cjs");
await unlink(root + "tests/runtime.cjs");
const disk = new Map();
const events = new Map();
let writes = 0;
const app = {
  vault: {
    cachedRead: async () => "01234567视频模型" + "普通内容".repeat(30),
    on: (name, callback) => {
      events.set(name, callback);
    },
    adapter: {
      exists: async (path) => disk.has(path),
      mkdir: async (path) => {
        disk.set(path, "");
      },
      write: async (path, text) => {
        writes++;
        disk.set(path, text);
      },
      read: async (path) => disk.get(path),
    },
  },
  workspace: {
    getLeavesOfType: () => [],
    iterateAllLeaves: () => {},
    on: () => {},
    updateOptions: () => {
      throw new Error("不应全局重建编辑器");
    },
  },
};
const store = new AnnotationStore(app);
await store.initialize();
const fileA = new TFile("A.md");
const fileB = new TFile("B.md");
const docA = await store.getDocument(fileA);
const docB = await store.getDocument(fileB);
const mark = {
  id: "highlight-a",
  color: "yellow",
  anchor: {
    startOffset: 8,
    endOffset: 12,
    selectedText: "视频模型",
    prefix: "01234567",
    suffix: "",
    isCode: false,
  },
  createdAt: "",
};
await store.saveDocument({ ...docA, highlights: [mark] });
let captures = 0;
let updates = 0;
const extension = createHighlightExtension({
  getDocument: (path) => store.getCachedDocument(path),
  getSource: (path) => store.getSource(path),
  trackSource: (path, before, after, changes) =>
    store.trackSource(path, after, before, changes),
  getVersion: () => store.version,
  onDocumentChange: (listener) => store.onDocumentChange(listener),
  rememberSelection: () => {
    captures++;
  },
});
const source = document.createElement("div");
source.className = "markdown-source-view";
document.body.append(source);
const editor = new EditorView({
  parent: source,
  state: EditorState.create({
    doc: await app.vault.cachedRead(),
    extensions: [
      editorInfoField,
      extension,
      EditorView.updateListener.of(() => updates++),
    ],
  }),
});
let cell;
class CellWidget extends WidgetType {
  toDOM() {
    const parent = document.createElement("div");
    cell = new EditorView({
      parent,
      state: EditorState.create({
        doc: "Task 定义的唯一ID，如 E-MAT。",
        extensions: [editorInfoField, extension],
      }),
    });
    return parent;
  }
}
const widgets = StateField.define({
  create: (state) =>
    Decoration.set([
      Decoration.widget({ widget: new CellWidget() }).range(state.doc.length),
    ]),
  update: (value, transaction) => value.map(transaction.changes),
  provide: (field) => EditorView.decorations.from(field),
});
editor.dispatch({ effects: StateEffect.appendConfig.of(widgets) });
await store.saveDocument({ ...docA, highlights: [mark] });
assert.equal(
  editor.dom.querySelector(".axl-highlight")?.textContent,
  "视频模型",
);
assert.equal(
  cell.dom.querySelector(".axl-highlight"),
  null,
  "表格单元格不能套用全文偏移",
);
cell.dispatch({ selection: { anchor: 1, head: 5 } });
assert.equal(captures, 0, "表格局部选区不能记录成全文偏移");
const beforeUpdates = updates;
await store.saveDocument(docB);
assert.equal(updates, beforeUpdates, "修改 B 不应刷新 A 的编辑器");
console.log(
  "通过：真实 CodeMirror 全文高亮、嵌套表格隔离、局部选区隔离、跨文档编辑器隔离",
);
editor.dispatch({ changes: { from: 0, insert: "新增" } });
assert.equal(
  store.getCachedDocument("A.md").highlights[0].anchor.startOffset,
  10,
);
assert.equal(
  editor.dom.querySelector(".axl-highlight")?.textContent,
  "视频模型",
);
const savedVersion = store.getDocumentVersion("A.md");
store.trackSource("A.md", editor.state.doc.toString());
assert.equal(
  store.getDocumentVersion("A.md"),
  savedVersion,
  "重复保存不得二次平移",
);
editor.dispatch({ changes: { from: 10, to: 14 } });
assert.equal(store.getCachedDocument("A.md").highlights[0].orphaned, true);
assert.equal(editor.dom.querySelector(".axl-highlight"), null);
editor.dispatch({ changes: { from: 10, insert: "视频模型" } });
assert.equal(store.getCachedDocument("A.md").highlights[0].orphaned, false);
assert.equal(
  editor.dom.querySelector(".axl-highlight")?.textContent,
  "视频模型",
);
console.log(
  "通过：真实编辑事务同步源码锚点、保存幂等、整处删除保留数据、精确撤销恢复原位置",
);

function preview(path) {
  const view = new MarkdownView();
  view.file = new TFile(path);
  view.getMode = () => "preview";
  view.renders = 0;
  view.scroll = 64.25;
  view.getViewData = () => store.getSource(path);
  const content = document.createElement("div");
  content.innerHTML = "<p>" + view.getViewData() + "</p>";
  document.body.append(content);
  view.previewMode = {
    containerEl: content,
    getScroll: () => view.scroll,
    rerender: () => {
      view.renders++;
      view.scroll = 0;
    },
    applyScroll: (scroll) => {
      view.scroll = scroll;
    },
  };
  return view;
}
const a1 = preview("A.md");
const a2 = preview("A.md");
const b = preview("B.md");
app.workspace.getLeavesOfType = (type) =>
  type === "markdown" ? [a1, a2, b].map((view) => ({ view })) : [];
const plugin = new Plugin(app);
plugin.store = store;
await plugin.refreshAnnotations();
await store.saveDocument(docB);
await plugin.refreshAnnotations();
assert.equal(a1.renders, 0);
assert.equal(a2.renders, 0);
assert.equal(b.renders, 0);
assert.equal(
  a1.previewMode.containerEl.querySelector(".axl-reading-highlight")
    ?.textContent,
  "视频模型",
);
assert.equal(
  b.previewMode.containerEl.querySelector(".axl-reading-highlight"),
  null,
);
assert.equal(b.scroll, 64.25);
await store.saveDocument({ ...docA, highlights: [mark] });
await plugin.refreshAnnotations();
assert.equal(a1.renders, 0);
assert.equal(a2.renders, 0);
assert.equal(a1.scroll, 64.25);
assert.equal(a2.scroll, 64.25);
await plugin.refreshAnnotations();
assert.equal(a1.renders, 0, "标注更新不应全量重建阅读视图");
console.log(
  "通过：跨文档阅读视图隔离、同文档多视图各刷新一次、滚动位置保留、重复刷新幂等",
);
plugin.surface = () => ({});
plugin.pdfLayerFor = () => ({});
plugin.registerEvents();
const beforeWrites = writes;
await events.get("modify")(fileB);
assert.equal(writes, beforeWrites, "无标注文档编辑不应写入旁注文件");
console.log("通过：无标注文档编辑不产生旁注写入");
cell.destroy();
editor.destroy();
dom.window.close();
