/**
 * [INPUT]: 依赖 Obsidian Plugin API、CM6 扩展、sidecar AnnotationStore、锚点算法、视图与设置模块
 * [OUTPUT]: 对外提供 OverlayAnnotationsPlugin 主类，注册选区、迁移、侧栏与 vault 事件，按文档刷新视图并保留阅读位置
 * [POS]: 插件装配根，协调模块但不修改用户 Markdown 原文
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import {
  addIcon,
  MarkdownPostProcessorContext,
  MarkdownView,
  Notice,
  Plugin,
  TFile,
} from "obsidian";

import { EditorView } from "@codemirror/view";
import { StateEffect, Compartment } from "@codemirror/state";
import {
  createTextAnchor,
  normalizeMarkdownSource,
  mapTextAnchor,
  sourceChanges,
} from "./src/anchor/textAnchor";
import {
  createHighlightExtension,
  refreshHighlightsEffect,
} from "./src/editor/highlightExtension";
import { refreshReadingViewHighlights } from "./src/editor/readingViewHighlight";
import {
  mapRenderedSource,
  renderedSelectionOffsets,
  sourceRangeForLines,
  type ProjectionHint,
} from "./src/editor/sourceProjection";
import { SelectionToolbar } from "./src/editor/selectionToolbar";
import { PdfAnnotationLayer } from "./src/pdf/pdfAnnotationLayer";
import { AnnotationSettingsTab } from "./src/settings/settingsTab";
import { AnnotationStore } from "./src/storage/annotationStore";
import {
  attachedMarkdownComments,
  visibleMarkdownMarks,
} from "./src/storage/visibleMarks";
import {
  AnnotationColor,
  AnnotationPluginSettings,
  CommentAnnotation,
  DEFAULT_SETTINGS,
  HighlightAnnotation,
  SelectionSnapshot,
} from "./src/storage/types";
import { AnnotationPopover } from "./src/views/annotationPopover";
import { CommentModal } from "./src/views/commentModal";
import {
  ANNOTATION_SIDEBAR_VIEW,
  AnnotationSidebarView,
} from "./src/views/sidebarView";

const AXL_LIGHT_ICON = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect x="5" y="5" width="90" height="90" rx="20" ry="20" fill="#F5C518"/>
    <g transform="translate(50,50) rotate(-45) translate(-18,-18)"
      fill="none" stroke="#000" stroke-width="6"
      stroke-linecap="round" stroke-linejoin="round">
      <rect x="8" y="2" width="20" height="28" rx="3" fill="#000" stroke="none"/>
      <polygon points="8,30 28,30 18,42" fill="#000" stroke="none"/>
      <line x1="8" y1="10" x2="28" y2="10" stroke="#F5C518" stroke-width="3"/>
    </g>
  </svg>
`;

export default class OverlayAnnotationsPlugin extends Plugin {
  private disposed = false;
  settings: AnnotationPluginSettings = DEFAULT_SETTINGS;
  store!: AnnotationStore;

  private readonly surfaces = new Map<
    Document,
    { toolbar: SelectionToolbar; popover: AnnotationPopover }
  >();
  private readonly lastSelections = new WeakMap<Document, SelectionSnapshot>();
  readonly pendingReadingLocations = new Map<string, Set<string>>();
  private readonly sourceSaves = new Map<string, Promise<void>>();
  private get toolbar(): SelectionToolbar {
    return this.surface(this.activeDocument()).toolbar;
  }
  private get popover(): AnnotationPopover {
    return this.surface(this.activeDocument()).popover;
  }
  private readonly pdfLayers = new Map<Document, PdfAnnotationLayer>();
  private readonly commentModals = new Set<CommentModal>();
  private highlightExtension!: ReturnType<typeof createHighlightExtension>;
  private readonly nestedEditorCompartments = new Map<
    EditorView,
    Compartment
  >();
  private readonly renderedViewVersions = new WeakMap<
    MarkdownView,
    { filePath: string; version: number; mode: string }
  >();
  private readonly renameMigrationTimers = new Map<string, number>();

  async onload(): Promise<void> {
    addIcon("axl-light-fog-icon", AXL_LIGHT_ICON);
    await this.loadSettings();
    this.store = new AnnotationStore(this.app);
    await this.store.initialize();

    this.registerView(
      ANNOTATION_SIDEBAR_VIEW,
      (leaf) => new AnnotationSidebarView(leaf, this),
    );
    this.highlightExtension = createHighlightExtension({
      getDocument: (filePath) => this.store.getCachedDocument(filePath),
      getSource: (filePath) => this.store.getSource(filePath),
      getVersion: () => this.store.version,
      onDocumentChange: (listener) => this.store.onDocumentChange(listener),
      trackSource: (filePath, before, after, changes) =>
        this.store.trackSource(filePath, after, before, changes),
      rememberSelection: (
        filePath,
        startOffset,
        endOffset,
        selectedText,
        document,
        source,
      ) => {
        this.lastSelections.set(document, {
          filePath,
          startOffset,
          endOffset,
          selectedText,
          source,
        });
      },
    });
    this.registerEditorExtension(this.highlightExtension);

    this.addSettingTab(new AnnotationSettingsTab(this));
    this.registerRibbonIcon();
    this.registerCommands();
    this.registerEvents();
    this.registerMarkdownPostProcessor((element, context) =>
      this.renderReadingHighlights(element, context),
    );
    this.app.workspace.onLayoutReady(() => {
      void this.initializeOpenViews();
    });
  }

  onunload(): void {
    this.disposed = true;
    for (const modal of this.commentModals) modal.close();
    this.commentModals.clear();
    for (const timer of this.renameMigrationTimers.values()) {
      window.clearTimeout(timer);
    }
    this.renameMigrationTimers.clear();
    for (const surface of this.surfaces.values()) {
      surface.toolbar.destroy();
      surface.popover.destroy();
    }
    for (const ownerDocument of this.surfaces.keys()) {
      for (const mark of Array.from(
        ownerDocument.querySelectorAll<HTMLElement>(".axl-reading-highlight"),
      ))
        unwrapStaleHighlight(mark);
    }
    this.surfaces.clear();
    for (const layer of this.pdfLayers.values()) layer.destroy();
    this.pdfLayers.clear();
    for (const [editor, compartment] of this.nestedEditorCompartments) {
      if (editor.dom.isConnected)
        editor.dispatch({ effects: compartment.reconfigure([]) });
    }
    this.nestedEditorCompartments.clear();
    this.app.workspace.detachLeavesOfType(ANNOTATION_SIDEBAR_VIEW);
  }

  private pdfLayerFor(ownerDocument: Document): PdfAnnotationLayer {
    const existing = this.pdfLayers.get(ownerDocument);
    if (existing) return existing;
    const layer = new PdfAnnotationLayer(
      {
        app: this.app,
        component: this,
        getSettings: () => this.settings,
        getDocument: (file) => this.store.getDocument(file),
        getCachedDocument: (filePath) => this.store.getCachedDocument(filePath),
        addHighlight: async (file, highlight) => {
          await this.store.addPdfHighlight(file, highlight);
          await this.refreshAnnotations();
        },
        addComment: async (file, comment) => {
          await this.store.addPdfComment(file, comment);
          await this.refreshAnnotations();
        },
        updateComment: async (file, comment) => {
          await this.store.updatePdfComment(file, comment);
          await this.refreshAnnotations();
        },
        deleteAnnotation: async (file, annotationId) => {
          await this.store.removeAnnotation(file, annotationId);
          await this.refreshAnnotations();
        },
      },
      ownerDocument,
    );
    this.pdfLayers.set(ownerDocument, layer);
    layer.register();
    return layer;
  }

  async loadSettings(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...((await this.loadData()) ?? {}),
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async refreshAnnotations(skipSidebar = false): Promise<void> {
    if (this.disposed) return;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) {
        const filePath = view.file.path;
        const version = this.store.getDocumentVersion(filePath);
        const previous = this.renderedViewVersions.get(view);
        const mode = view.getMode();
        this.renderedViewVersions.set(view, { filePath, version, mode });
        if (view.getMode() === "source") {
          if (
            previous?.filePath !== filePath ||
            previous.version !== version ||
            previous.mode !== mode
          )
            this.refreshSourceWidgets(view);
          continue;
        }
        if (
          previous?.filePath !== filePath ||
          previous.version !== version ||
          previous.mode !== mode
        ) {
          this.pendingReadingLocations.delete(filePath);
          const data = this.store.getCachedDocument(filePath);
          if (data)
            this.pendingReadingLocations.set(
              filePath,
              refreshReadingViewHighlights(
                view.previewMode.containerEl,
                visibleMarkdownMarks(data),
                {
                  source: normalizeMarkdownSource(view.getViewData()),
                  filePath,
                },
              ),
            );
        }
      }
    }
    if (skipSidebar) return;
    for (const leaf of this.app.workspace.getLeavesOfType(
      ANNOTATION_SIDEBAR_VIEW,
    )) {
      const view = leaf.view;
      if (view instanceof AnnotationSidebarView) {
        await view.render();
      }
    }
  }

  private async initializeOpenViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      await this.store.getDocument(view.file);
      if (view.getMode() === "source")
        this.store.trackSource(view.file.path, view.getViewData());
      else {
        const scroll = view.previewMode.getScroll();
        view.previewMode.rerender(true);
        view.previewMode.applyScroll(scroll);
      }
    }
    await this.refreshAnnotations();
  }

  private refreshSourceWidgets(view: MarkdownView): void {
    if (!view.file) return;
    const document = this.store.getCachedDocument(view.file.path);
    if (!document) return;
    const source = normalizeMarkdownSource(view.getViewData());
    for (const root of Array.from(
      view.containerEl.querySelectorAll<HTMLElement>(".cm-table-widget"),
    )) {
      refreshReadingViewHighlights(root, visibleMarkdownMarks(document), {
        source,
        filePath: view.file.path,
        hint: this.renderHint(root),
      });
      this.refreshNestedEditors(root);
    }
  }

  private refreshNestedEditors(root: HTMLElement): void {
    for (const editor of this.nestedEditorCompartments.keys())
      if (!editor.dom.isConnected) this.nestedEditorCompartments.delete(editor);
    for (const element of Array.from(
      root.querySelectorAll<HTMLElement>("td .cm-editor,th .cm-editor"),
    )) {
      const editor = EditorView.findFromDOM(element);
      if (!editor || !element.isConnected) continue;
      if (editor.plugin(this.highlightExtension))
        editor.dispatch({ effects: refreshHighlightsEffect.of(null) });
      else {
        const compartment = new Compartment();
        this.nestedEditorCompartments.set(editor, compartment);
        editor.dispatch({
          effects: StateEffect.appendConfig.of(
            compartment.of(this.highlightExtension),
          ),
        });
      }
    }
  }

  private registerRibbonIcon(): void {
    const icon = this.addRibbonIcon("highlighter", "打开 Axl Light Fog", () => {
      void this.activateSidebar();
    });
    icon.addClass("axl-ribbon-icon");
  }

  private registerCommands(): void {
    this.addCommand({
      id: "highlight-selection",
      name: "高亮选中文本",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "h" }],
      callback: () => this.createHighlight(this.settings.defaultHighlightColor),
    });

    this.addCommand({
      id: "add-sticky-note",
      name: "为选中文本添加便签",
      hotkeys: [{ modifiers: ["Mod", "Alt"], key: "m" }],
      callback: () => this.createComment(),
    });

    this.addCommand({
      id: "toggle-sticky-notes",
      name: "切换注释弹窗",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "n" }],
      callback: async () => {
        this.settings.stickyNotesVisible = !this.settings.stickyNotesVisible;
        await this.saveSettings();
        await this.refreshAnnotations();
      },
    });

    this.addCommand({
      id: "open-annotation-sidebar",
      name: "打开注释概览",
      callback: () => this.activateSidebar(),
    });
  }

  private registerEvents(): void {
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        void this.refreshAnnotations(true);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        void this.refreshAnnotations(true);
      }),
    );
    this.surface(document);
    this.pdfLayerFor(document);
    this.registerEvent(
      this.app.workspace.on("window-open", (_workspaceWindow, window) => {
        this.surface(window.document);
        this.pdfLayerFor(window.document);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("window-close", (_workspaceWindow, window) => {
        const surface = this.surfaces.get(window.document);
        surface?.toolbar.destroy();
        surface?.popover.destroy();
        this.surfaces.delete(window.document);
        this.pdfLayers.get(window.document)?.destroy();
        this.pdfLayers.delete(window.document);
      }),
    );
    this.app.workspace.iterateAllLeaves((leaf) => {
      this.surface(leaf.view.containerEl.ownerDocument);
      this.pdfLayerFor(leaf.view.containerEl.ownerDocument);
    });

    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (!(file instanceof TFile) || !isMarkdownFile(file)) {
          return;
        }

        const previous = this.sourceSaves.get(file.path) ?? Promise.resolve();
        const next = previous.then(async () => {
          await this.store.getDocument(file);
          const source = await this.app.vault.cachedRead(file);
          this.store.trackSource(file.path, source);
          const document = this.store.getCachedDocument(file.path);
          if (
            !document ||
            (!document.highlights.length && !document.comments.length)
          )
            return;
          await this.store.touchFileHash(file);
          await this.refreshAnnotations();
        });
        this.sourceSaves.set(
          file.path,
          next.catch((error) => {
            console.error("Axl Light Fog source update failed", error);
            new Notice("标注位置更新未保存，请稍后重试。");
          }),
        );
        await next;
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (
          !this.settings.migrateOnRename ||
          !(file instanceof TFile) ||
          !isAnnotatableFile(file)
        ) {
          return;
        }

        const existingTimer = this.renameMigrationTimers.get(oldPath);
        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer);
        }

        const timer = window.setTimeout(async () => {
          await this.store.migrateFilePath(oldPath, file);
          await this.refreshAnnotations();
          this.renameMigrationTimers.delete(oldPath);
        }, 100);
        this.renameMigrationTimers.set(oldPath, timer);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", async (file) => {
        if (file instanceof TFile && isAnnotatableFile(file)) {
          this.popover.hide();
          await this.store.getDocument(file);
          await this.refreshAnnotations();
        }
      }),
    );
  }

  private async createHighlight(
    color: AnnotationColor,
    ownerDocument = this.activeDocument(),
  ): Promise<void> {
    if (this.pdfLayerFor(ownerDocument).isPdfActive()) {
      await this.pdfLayerFor(ownerDocument).createHighlight(color);
      this.toolbar.hide();
      return;
    }

    const snapshot = await this.resolveSelection(ownerDocument);

    if (!snapshot) {
      new Notice(
        ownerDocument.getSelection()?.toString().trim()
          ? "无法确认所选文字的位置，请重新选择正文文本。"
          : "请先选中文本。",
      );
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
    if (!(file instanceof TFile)) {
      return;
    }

    const anchor = createAnchorForSnapshot(
      this.store.getSource(file.path) ??
        (await this.app.vault.cachedRead(file)),
      snapshot,
    );
    if (!anchor) {
      new Notice("所选文字已被删除，请重新选择。");
      return;
    }
    const highlight: HighlightAnnotation = {
      id: crypto.randomUUID(),
      color,
      anchor,
      createdAt: new Date().toISOString(),
    };

    await this.store.addHighlight(file, highlight);
    await this.refreshAnnotations();
    this.toolbar.hide();
  }

  private async createComment(
    ownerDocument = this.activeDocument(),
  ): Promise<void> {
    if (this.pdfLayerFor(ownerDocument).isPdfActive()) {
      const layer = this.pdfLayerFor(ownerDocument);
      const snapshot = layer.selectionForCommand();
      if (!snapshot) {
        new Notice("请先在 PDF 中选中文本。");
        return;
      }
      const note = await this.readComment();
      if (note !== null) {
        await layer.createComment(
          this.settings.defaultHighlightColor,
          note.content,
          this.settings.defaultAuthor,
          note.title,
          snapshot,
        );
      }
      this.toolbar.hide();
      return;
    }

    const snapshot = await this.resolveSelection(ownerDocument);
    if (!snapshot) {
      new Notice(
        ownerDocument.getSelection()?.toString().trim()
          ? "无法确认所选文字的位置，请重新选择正文文本。"
          : "请先选中文本。",
      );
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
    if (!(file instanceof TFile)) {
      return;
    }

    const note = await this.readComment();
    if (note === null) {
      return;
    }

    const now = new Date().toISOString();
    const anchor = createAnchorForSnapshot(
      this.store.getSource(file.path) ??
        (await this.app.vault.cachedRead(file)),
      snapshot,
    );
    if (!anchor) {
      new Notice("所选文字已被删除，请重新选择。");
      return;
    }
    const comment: CommentAnnotation = {
      id: crypto.randomUUID(),
      anchor,
      title: note.title,
      content: note.content,
      color: this.settings.defaultHighlightColor,
      position: { offsetX: 20, offsetY: 0 },
      collapsed: false,
      author: this.settings.defaultAuthor,
      createdAt: now,
      updatedAt: now,
      replies: [],
      resolved: false,
    };

    await this.store.addComment(file, comment);
    await this.refreshAnnotations();
    this.toolbar.hide();
  }

  private async readComment() {
    const modal = new CommentModal(this.app, "", "");
    this.commentModals.add(modal);
    try {
      return await modal.openAndRead();
    } finally {
      this.commentModals.delete(modal);
    }
  }

  private activeDocument(): Document {
    return (
      this.app.workspace.getMostRecentLeaf()?.view.containerEl.ownerDocument ??
      document
    );
  }

  private surface(document: Document): {
    toolbar: SelectionToolbar;
    popover: AnnotationPopover;
  } {
    const existing = this.surfaces.get(document);
    if (existing) return existing;
    const toolbar = new SelectionToolbar({
      document,
      onHighlight: (color) => this.createHighlight(color, document),
      onComment: () => this.createComment(document),
      onCopy: () => this.copySelection(document),
      onOpenSidebar: () => this.activateSidebar(),
    });
    const popover = new AnnotationPopover({
      app: this.app,
      component: this,
      document,
    });
    const surface = { toolbar, popover };
    this.surfaces.set(document, surface);
    this.registerDomEvent(document, "pointerdown", (event) => {
      if (
        isHtmlElement(event.target) &&
        !event.target.closest(".axl-selection-toolbar,.modal,.prompt")
      )
        this.lastSelections.delete(document);
    });
    this.registerDomEvent(document, "selectionchange", () => {
      toolbar.showForSelection();
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) {
        if (
          !document.activeElement?.closest(
            ".axl-selection-toolbar,.modal,.prompt",
          )
        )
          this.lastSelections.delete(document);
        return;
      }
      void this.resolveSelection(document, false);
    });
    this.registerDomEvent(
      document,
      "click",
      (event) => {
        void this.handleAnnotationClick(event, document);
      },
      { capture: true },
    );
    return surface;
  }

  private async resolveSelection(
    ownerDocument: Document,
    allowRemembered = true,
  ): Promise<SelectionSnapshot | null> {
    const selection = ownerDocument.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const element =
      range?.commonAncestorContainer.nodeType === 1
        ? range.commonAncestorContainer
        : range?.commonAncestorContainer.parentElement;
    const owner = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find(
        (view) =>
          view instanceof MarkdownView &&
          element &&
          view.containerEl.contains(element),
      );
    if (
      owner instanceof MarkdownView &&
      owner.file &&
      range &&
      selection &&
      !selection.isCollapsed
    ) {
      const filePath = owner.file.path,
        source = normalizeMarkdownSource(owner.getViewData());
      const cmRoot = owner.containerEl.querySelector<HTMLElement>(
        ".markdown-source-view > .cm-editor",
      );
      const cm = cmRoot ? EditorView.findFromDOM(cmRoot) : null;
      if (
        cm &&
        element &&
        cm.contentDOM.contains(element) &&
        !element.parentElement?.closest("td,th")
      ) {
        const selected = cm.state.selection.main;
        if (!selected.empty) {
          const snapshot = {
            filePath,
            startOffset: selected.from,
            endOffset: selected.to,
            selectedText: cm.state.sliceDoc(selected.from, selected.to),
            source,
          };
          this.lastSelections.set(ownerDocument, snapshot);
          return snapshot;
        }
      }
      const root =
        (element?.nodeType === 1
          ? (element as HTMLElement).closest<HTMLElement>(
              "table,.el-p,.el-h1,.el-h2,.el-h3,.el-h4,.el-h5,.el-h6,.el-ul,.el-ol,.el-blockquote,.el-pre,.markdown-preview-section",
            )
          : null) ?? owner.previewMode.containerEl;
      const mapping = mapRenderedSource(root, source, this.renderHint(root));
      const offsets = renderedSelectionOffsets(mapping, range);
      if (offsets) {
        const snapshot = {
          filePath,
          startOffset: offsets.from,
          endOffset: offsets.to,
          selectedText: selection.toString(),
          source,
        };
        this.lastSelections.set(ownerDocument, snapshot);
        return snapshot;
      }
      return null;
    }
    if (
      selection &&
      !selection.isCollapsed &&
      !element?.parentElement?.closest(".axl-selection-toolbar,.modal,.prompt")
    )
      return null;
    if (!allowRemembered) return null;
    const remembered = this.lastSelections.get(ownerDocument);
    const recent = this.app.workspace.getMostRecentLeaf()?.view;
    return remembered &&
      recent instanceof MarkdownView &&
      recent.file?.path === remembered.filePath &&
      recent.containerEl.ownerDocument === ownerDocument
      ? remembered
      : null;
  }

  private renderHint(element: HTMLElement): ProjectionHint | undefined {
    const sourceView = element.closest<HTMLElement>(".markdown-source-view");
    const cmRoot = sourceView?.querySelector<HTMLElement>(".cm-editor");
    if (!cmRoot) return undefined;
    const cm = EditorView.findFromDOM(cmRoot);
    if (!cm) return undefined;
    try {
      const from = cm.posAtDOM(element);
      return { from, to: from };
    } catch {
      return undefined;
    }
  }

  async activateSidebar(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(ANNOTATION_SIDEBAR_VIEW)[0];
    if (!leaf) {
      const nextLeaf = this.app.workspace.getRightLeaf(false);
      if (!nextLeaf) {
        return;
      }
      leaf = nextLeaf;
      await leaf.setViewState({ type: ANNOTATION_SIDEBAR_VIEW, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  private async copySelection(
    ownerDocument = this.activeDocument(),
  ): Promise<void> {
    const text = ownerDocument.getSelection()?.toString() || "";
    if (text) {
      try {
        await writeClipboardText(text, ownerDocument);
        new Notice("已复制选中文本");
      } catch {
        new Notice("复制失败，请使用系统复制快捷键。");
      }
    }
  }

  private async handleAnnotationClick(
    event: MouseEvent,
    ownerDocument: Document,
  ): Promise<void> {
    const target = event.target;
    if (!isHtmlElement(target)) {
      this.surface(ownerDocument).popover.hide();
      return;
    }

    const mark = target.closest<HTMLElement>(
      ".axl-highlight, .axl-reading-highlight",
    );
    if (!mark) {
      if (!target.closest(".axl-annotation-popover")) {
        this.surface(ownerDocument).popover.hide();
      }
      return;
    }

    const annotationId = mark.dataset.axlId;
    const owner = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find(
        (view) =>
          view instanceof MarkdownView && view.containerEl.contains(mark),
      );
    const file = owner instanceof MarkdownView ? owner.file : null;
    if (!annotationId || !(file instanceof TFile)) {
      return;
    }

    const document =
      this.store.getCachedDocument(file.path) ??
      (await this.store.getDocument(file));
    if (mark.dataset.axlFile !== file.path) return;
    const ids = new Set<string>([annotationId]);
    if (mark.dataset.axlIds) {
      try {
        const parsed: unknown = JSON.parse(mark.dataset.axlIds);
        if (Array.isArray(parsed))
          for (const id of parsed) if (typeof id === "string") ids.add(id);
      } catch {
        /* 无效 DOM 属性不作为注释来源。 */
      }
    }
    for (
      let parent = mark.parentElement?.closest<HTMLElement>(".axl-highlight");
      parent;
      parent = parent.parentElement?.closest<HTMLElement>(".axl-highlight")
    ) {
      if (parent.dataset.axlFile === file.path && parent.dataset.axlId)
        ids.add(parent.dataset.axlId);
    }
    const items = new Map<
      string,
      ReturnType<typeof AnnotationPopover.itemFromAnnotation>
    >();
    for (const id of ids) {
      const primary =
        document.comments.find((comment) => comment.id === id) ??
        document.highlights.find((highlight) => highlight.id === id);
      if (!primary || primary.orphaned) continue;
      const related =
        "content" in primary
          ? [primary]
          : attachedMarkdownComments(primary, document.comments);
      for (const annotation of related.length ? related : [primary])
        items.set(
          annotation.id,
          AnnotationPopover.itemFromAnnotation(annotation),
        );
    }
    if (!items.size) {
      unwrapStaleHighlight(mark);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.surface(ownerDocument).popover.show({
      rect: mark.getBoundingClientRect(),
      sourcePath: file.path,
      items: [...items.values()],
    });
  }

  private async renderReadingHighlights(
    element: HTMLElement,
    context: MarkdownPostProcessorContext,
  ): Promise<void> {
    if (
      !context.sourcePath ||
      element.closest(".axl-sidebar,.axl-annotation-popover,.axl-sticky-note")
    )
      return;
    const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
    if (!(file instanceof TFile) || !isMarkdownFile(file)) return;
    const section = context.getSectionInfo(element);
    const document = await this.store.getDocument(file);
    if (this.disposed) return;
    const owner = this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .find(
        (view) =>
          view instanceof MarkdownView &&
          view.file?.path === file.path &&
          view.containerEl.contains(element),
      );
    const source = normalizeMarkdownSource(
      owner instanceof MarkdownView
        ? owner.getViewData()
        : (this.store.getSource(file.path) ??
            (await this.app.vault.cachedRead(file))),
    );
    // 实时预览的表格渲染器可能传入局部 Markdown，行号不一定属于全文。
    const hint =
      this.renderHint(element) ??
      (section && normalizeMarkdownSource(section.text) === source
        ? sourceRangeForLines(source, section.lineStart, section.lineEnd)
        : undefined);
    const pending = refreshReadingViewHighlights(
      element,
      visibleMarkdownMarks(document),
      { source, filePath: file.path, hint },
    );
    this.refreshNestedEditors(element);
    const previousStatuses =
      this.pendingReadingLocations.get(file.path) ?? new Set<string>();
    const statuses = new Set(previousStatuses);
    for (const id of pending) statuses.add(id);
    for (const mark of Array.from(
      element.querySelectorAll<HTMLElement>(
        ".axl-reading-highlight[data-axl-id]",
      ),
    ))
      if (mark.dataset.axlId) statuses.delete(mark.dataset.axlId);
    this.pendingReadingLocations.set(file.path, statuses);
    if (
      statuses.size !== previousStatuses.size ||
      [...statuses].some((id) => !previousStatuses.has(id))
    ) {
      for (const leaf of this.app.workspace.getLeavesOfType(
        ANNOTATION_SIDEBAR_VIEW,
      )) {
        if (leaf.view instanceof AnnotationSidebarView)
          await leaf.view.render();
      }
    }
  }
}

function createAnchorForSnapshot(source: string, snapshot: SelectionSnapshot) {
  source = normalizeMarkdownSource(source);
  let anchor = createTextAnchor(
    snapshot.source ?? source,
    snapshot.startOffset,
    snapshot.endOffset,
  );
  if (snapshot.source !== undefined && snapshot.source !== source) {
    const mapped = mapTextAnchor(
      source,
      anchor,
      sourceChanges(snapshot.source, source),
    );
    if (mapped.orphaned) return null;
    anchor = mapped.anchor;
  }
  const selectedText = snapshot.selectedText.replace(/\r\n/g, "\n").trim();
  const sourceText = anchor.selectedText.replace(/\r\n/g, "\n").trim();
  if (!selectedText || selectedText === sourceText) {
    return anchor;
  }

  return {
    ...anchor,
    selectedText,
  };
}

function unwrapStaleHighlight(mark: HTMLElement): void {
  const parent = mark.parentNode;
  if (!parent) {
    mark.remove();
    return;
  }

  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);
  parent.normalize();
}

function isMarkdownFile(file: TFile): boolean {
  return file.extension.toLowerCase() === "md";
}

function isAnnotatableFile(file: TFile): boolean {
  return ["md", "pdf"].includes(file.extension.toLowerCase());
}

async function writeClipboardText(
  text: string,
  ownerDocument: Document,
): Promise<void> {
  try {
    await ownerDocument.defaultView?.navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = ownerDocument.body.createEl("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    try {
      textarea.select();
      if (!ownerDocument.execCommand("copy")) {
        throw new Error("execCommand copy failed");
      }
    } finally {
      textarea.remove();
    }
  }
}

function isHtmlElement(target: EventTarget | null): target is HTMLElement {
  return (
    target !== null &&
    "nodeType" in target &&
    target.nodeType === 1 &&
    "closest" in target &&
    typeof target.closest === "function" &&
    "style" in target
  );
}
