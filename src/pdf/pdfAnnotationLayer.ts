/**
 * [INPUT]: 依赖 Obsidian workspace/vault、PDF viewer DOM selection、storage/types 的 PDF 注释模型
 * [OUTPUT]: 对外提供 PdfAnnotationLayer，在 PDF 页面上绘制非侵入式高亮与弹层批注
 * [POS]: pdf 模块的渲染与选区控制器，与 Markdown/CM6 通道并列，共享 sidecar store
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import {
  App,
  Component,
  MarkdownRenderer,
  Notice,
  setIcon,
  TFile,
} from "obsidian";

import {
  AnnotationColor,
  AnnotationPluginSettings,
  FileAnnotationDocument,
  PdfAnchor,
  PdfCommentAnnotation,
  PdfHighlightAnnotation,
} from "../storage/types";

interface PdfAnnotationLayerOptions {
  app: App;
  component: Component;
  getSettings: () => AnnotationPluginSettings;
  getDocument: (file: TFile) => Promise<FileAnnotationDocument>;
  getCachedDocument: (filePath: string) => FileAnnotationDocument | null;
  addHighlight: (
    file: TFile,
    highlight: PdfHighlightAnnotation,
  ) => Promise<void>;
  addComment: (file: TFile, comment: PdfCommentAnnotation) => Promise<void>;
  updateComment: (file: TFile, comment: PdfCommentAnnotation) => Promise<void>;
  deleteAnnotation: (file: TFile, annotationId: string) => Promise<void>;
}

export interface PdfSelectionSnapshot {
  file: TFile;
  anchor: PdfAnchor;
}

const PDF_PAGE_SELECTOR = ".pdf-page, .page[data-page-number], .page";
const PDF_VIEWER_SELECTOR =
  ".pdf-container, .pdf-viewer, .pdf-embed, .workspace-leaf-content[data-type='pdf']";

export class PdfAnnotationLayer {
  private root: HTMLElement | null = null;
  private popover: HTMLElement | null = null;
  private observer: MutationObserver | null = null;
  private frame: number | null = null;
  private lastSelection: PdfSelectionSnapshot | null = null;

  private destroyed = false;
  constructor(
    private readonly options: PdfAnnotationLayerOptions,
    private readonly ownerDocument: Document = document,
  ) {}
  private get ownerWindow(): Window & typeof globalThis {
    return this.ownerDocument.defaultView ?? window;
  }

  register(): void {
    this.options.component.registerDomEvent(
      this.ownerDocument,
      "selectionchange",
      () => this.captureSelection(),
    );
    this.options.component.registerDomEvent(
      this.ownerDocument,
      "mouseup",
      () => {
        this.ownerWindow.setTimeout(() => this.captureSelection(), 0);
      },
    );
    this.options.component.registerDomEvent(
      this.ownerDocument,
      "pointerdown",
      (event) => {
        if (
          event.target instanceof this.ownerWindow.Element &&
          !event.target.closest(".axl-selection-toolbar,.modal")
        )
          this.lastSelection = null;
      },
    );
    this.options.component.registerDomEvent(
      this.ownerDocument,
      "click",
      (event) => {
        void this.handleClick(event);
      },
    );
    this.options.component.registerEvent(
      this.options.app.workspace.on("active-leaf-change", () =>
        this.scheduleRender(),
      ),
    );
    this.options.component.registerEvent(
      this.options.app.workspace.on("layout-change", () =>
        this.scheduleRender(),
      ),
    );

    this.observer = new this.ownerWindow.MutationObserver((mutations) => {
      if (
        mutations.some(
          (mutation) =>
            !(
              mutation.target instanceof this.ownerWindow.Element
                ? mutation.target
                : mutation.target.parentElement
            )?.closest(
              ".axl-pdf-layer,.axl-pdf-popover,.axl-selection-toolbar",
            ),
        )
      )
        this.scheduleRender();
    });
    this.observer.observe(this.ownerDocument.body, {
      childList: true,
      subtree: true,
    });
    this.options.component.registerDomEvent(
      this.ownerDocument,
      "scroll",
      this.scheduleRender,
      { capture: true, passive: true },
    );
    this.options.component.registerDomEvent(
      this.ownerWindow,
      "resize",
      this.scheduleRender,
    );
    this.options.component.register(() => this.destroy());
    this.scheduleRender();
  }

  async createHighlight(color: AnnotationColor): Promise<boolean> {
    const snapshot = this.resolveSelection();
    if (!snapshot) {
      new Notice("请先在 PDF 中选中文本。");
      return true;
    }

    await this.options.addHighlight(snapshot.file, {
      id: crypto.randomUUID(),
      color,
      anchor: snapshot.anchor,
      createdAt: new Date().toISOString(),
    });
    this.clearSelection();
    this.scheduleRender();
    return true;
  }

  selectionForCommand(): PdfSelectionSnapshot | null {
    return this.resolveSelection();
  }

  async createComment(
    color: AnnotationColor,
    content: string,
    author: string,
    title = "",
    captured?: PdfSelectionSnapshot,
  ): Promise<boolean> {
    const snapshot = captured
      ? captured.file.path === this.activePdfFile()?.path
        ? captured
        : null
      : this.resolveSelection();
    if (!snapshot) {
      new Notice("请先在 PDF 中选中文本。");
      return true;
    }

    const now = new Date().toISOString();
    await this.options.addComment(snapshot.file, {
      id: crypto.randomUUID(),
      anchor: snapshot.anchor,
      title,
      content,
      color,
      position: { offsetX: 0, offsetY: 0 },
      collapsed: false,
      author,
      createdAt: now,
      updatedAt: now,
      replies: [],
      resolved: false,
    });
    this.clearSelection();
    this.scheduleRender();
    return true;
  }

  isPdfActive(): boolean {
    return this.activePdfFile() !== null;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame !== null) {
      this.ownerWindow.cancelAnimationFrame(this.frame);
    }
    this.observer?.disconnect();
    this.root?.remove();
    this.popover?.remove();
  }

  private scheduleRender = (): void => {
    if (this.destroyed || this.frame !== null) {
      return;
    }
    this.frame = this.ownerWindow.requestAnimationFrame(() => {
      this.frame = null;
      void this.render();
    });
  };

  private async render(): Promise<void> {
    const file = this.activePdfFile();
    const viewer = this.activeViewer();
    if (!file || !viewer) {
      this.root?.remove();
      this.root = null;
      return;
    }

    const document = await this.options.getDocument(file);
    if (
      this.destroyed ||
      this.activePdfFile()?.path !== file.path ||
      this.activeViewer() !== viewer
    )
      return;
    const settings = this.options.getSettings();
    const host =
      viewer.closest<HTMLElement>(".workspace-leaf-content") ?? viewer;
    host.addClass("axl-pdf-host");
    host.style.setProperty("--axl-sticky-width", `${settings.stickyWidth}px`);

    if (!this.root || this.root.parentElement !== host) {
      this.root?.remove();
      this.root = host.createDiv({ cls: "axl-pdf-layer" });
    }

    this.renderHighlights(host, document);
  }

  private renderHighlights(
    host: HTMLElement,
    document: FileAnnotationDocument,
  ): void {
    if (!this.root) {
      return;
    }

    this.root
      .querySelectorAll(".axl-pdf-highlight")
      .forEach((item) => item.remove());
    const hostRect = host.getBoundingClientRect();
    const annotations = [
      ...document.pdfHighlights,
      ...document.pdfComments,
    ].filter((item) => !item.orphaned);

    for (const annotation of annotations) {
      for (const rect of annotation.anchor.rects) {
        const page = this.pageElement(rect.pageNumber);
        if (!page) {
          continue;
        }

        const pageRect = page.getBoundingClientRect();
        const highlight = this.root.createDiv({
          cls: `axl-pdf-highlight axl-pdf-highlight--${annotation.color}`,
          attr: {
            "data-axl-id": annotation.id,
            "data-axl-color": annotation.color,
          },
        });
        highlight.style.left = `${pageRect.left - hostRect.left + rect.left * pageRect.width}px`;
        highlight.style.top = `${pageRect.top - hostRect.top + rect.top * pageRect.height}px`;
        highlight.style.width = `${rect.width * pageRect.width}px`;
        highlight.style.height = `${rect.height * pageRect.height}px`;
        highlight.style.setProperty(
          "background-color",
          pdfHighlightBackground(annotation.color),
          "important",
        );
      }
    }
  }

  private captureSelection(): void {
    const file = this.activePdfFile();
    if (!file) {
      this.lastSelection = null;
      return;
    }

    const selection = this.ownerDocument.getSelection();
    const selectedText = selection?.toString().trim() ?? "";
    if (!selection || selection.rangeCount === 0 || !selectedText) {
      if (
        !this.ownerDocument.activeElement?.closest(
          ".axl-selection-toolbar,.modal,.prompt",
        )
      )
        this.lastSelection = null;
      return;
    }

    const container = selectionContainer(selection);
    if (!container || !this.activeViewer()?.contains(container)) {
      this.lastSelection = null;
      return;
    }

    const anchor = this.anchorFromSelection(selection, selectedText);
    this.lastSelection = anchor ? { file, anchor } : null;
  }

  private anchorFromSelection(
    selection: Selection,
    selectedText: string,
  ): PdfAnchor | null {
    const rects: PdfAnchor["rects"] = [];
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) {
          continue;
        }

        const page = this.pageElementFromRect(rect);
        if (!page) {
          continue;
        }

        const pageRect = page.getBoundingClientRect();
        rects.push({
          pageNumber: this.pageNumber(page),
          left: (rect.left - pageRect.left) / pageRect.width,
          top: (rect.top - pageRect.top) / pageRect.height,
          width: rect.width / pageRect.width,
          height: rect.height / pageRect.height,
        });
      }
    }

    if (rects.length === 0) {
      return null;
    }

    return {
      pageNumber: rects[0].pageNumber,
      selectedText,
      rects,
      createdScale: this.currentScale(),
    };
  }

  private async handleClick(event: MouseEvent): Promise<void> {
    const target = event.target;
    if (!(target instanceof this.ownerWindow.HTMLElement)) {
      return;
    }

    const highlight = target.closest<HTMLElement>(".axl-pdf-highlight");
    if (!highlight) {
      if (!target.closest(".axl-pdf-popover")) {
        this.hidePopover();
      }
      return;
    }

    const file = this.activePdfFile();
    const id = highlight.dataset.axlId;
    if (!file || !id) {
      return;
    }

    const document =
      this.options.getCachedDocument(file.path) ??
      (await this.options.getDocument(file));
    const annotation =
      document.pdfComments.find((item) => item.id === id) ??
      document.pdfHighlights.find((item) => item.id === id);
    if (!annotation) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.showPopover(file.path, highlight.getBoundingClientRect(), annotation);
  }

  private showPopover(
    sourcePath: string,
    rect: DOMRect,
    annotation: PdfHighlightAnnotation | PdfCommentAnnotation,
  ): void {
    this.hidePopover();
    this.popover = this.ownerDocument.body.createDiv({
      cls: "axl-pdf-popover axl-annotation-popover is-visible",
    });
    const header = this.popover.createDiv({ cls: "axl-popover-header" });
    header.createSpan({
      cls: "axl-popover-title",
      text: `PDF 第 ${annotation.anchor.pageNumber} 页`,
    });
    const close = header.createEl("button", {
      cls: "axl-icon-button",
      attr: { type: "button", title: "关闭" },
    });
    setIcon(close, "x");
    close.addEventListener("click", () => this.hidePopover());

    const card = this.popover.createDiv({
      cls: "axl-popover-card",
      attr: {
        "data-axl-color": annotation.color,
        "data-axl-id": annotation.id,
      },
    });
    card.createDiv({
      cls: "axl-popover-quote",
      text: annotation.anchor.selectedText,
    });
    if ("content" in annotation && annotation.content) {
      const body = card.createDiv({ cls: "axl-popover-body" });
      MarkdownRenderer.render(
        this.options.app,
        annotation.content,
        body,
        sourcePath,
        this.options.component,
      );
    }

    const width = Math.min(320, this.ownerWindow.innerWidth - 24);
    this.popover.style.width = `${width}px`;
    this.popover.style.left = `${Math.max(12, Math.min(this.ownerWindow.innerWidth - width - 12, rect.left))}px`;
    this.popover.style.top = `${Math.max(12, Math.min(this.ownerWindow.innerHeight - 240, rect.bottom + 8))}px`;
  }

  private hidePopover(): void {
    this.popover?.remove();
    this.popover = null;
  }

  private resolveSelection(): PdfSelectionSnapshot | null {
    this.captureSelection();
    return this.lastSelection?.file.path === this.activePdfFile()?.path
      ? this.lastSelection
      : null;
  }

  private clearSelection(): void {
    this.ownerDocument.getSelection()?.removeAllRanges();
    this.lastSelection = null;
  }

  private pageElementFromRect(rect: DOMRect): HTMLElement | null {
    const element = this.ownerDocument.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return element?.closest<HTMLElement>(PDF_PAGE_SELECTOR) ?? null;
  }

  private pageElement(pageNumber: number): HTMLElement | null {
    const pages = this.pages();
    return pages.find((page) => this.pageNumber(page) === pageNumber) ?? null;
  }

  private pages(): HTMLElement[] {
    const viewer = this.activeViewer();
    return viewer
      ? Array.from(viewer.querySelectorAll<HTMLElement>(PDF_PAGE_SELECTOR))
      : [];
  }

  private pageNumber(page: HTMLElement): number {
    const attr = page.dataset.pageNumber ?? page.getAttr("data-page-number");
    const parsed = attr ? Number.parseInt(attr, 10) : NaN;
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    return Math.max(1, this.pages().indexOf(page) + 1);
  }

  private currentScale(): number {
    const page = this.pages()[0];
    return page
      ? page.getBoundingClientRect().width / Math.max(1, page.offsetWidth)
      : 1;
  }

  private activeViewer(): HTMLElement | null {
    const active = (
      this.options.app.workspace.getMostRecentLeaf()?.view as
        | { containerEl?: HTMLElement }
        | undefined
    )?.containerEl;
    const root =
      active?.ownerDocument === this.ownerDocument
        ? active
        : this.ownerDocument.querySelector<HTMLElement>(
            ".workspace-leaf.mod-active",
          );
    if (!root) {
      return null;
    }
    return root.matches(PDF_VIEWER_SELECTOR)
      ? root
      : root.querySelector<HTMLElement>(PDF_VIEWER_SELECTOR);
  }

  private activePdfFile(): TFile | null {
    const viewer = this.activeViewer();
    const file = this.options.app.workspace
      .getLeavesOfType("pdf")
      .find((leaf) => viewer && leaf.view.containerEl.contains(viewer))?.view;
    const candidate = file && "file" in file ? file.file : null;
    return candidate instanceof TFile &&
      candidate.extension.toLowerCase() === "pdf"
      ? candidate
      : null;
  }
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function selectionContainer(selection: Selection): Element | null {
  if (selection.rangeCount === 0) {
    return null;
  }

  const node = selection.getRangeAt(0).commonAncestorContainer;
  const ElementType = node.ownerDocument?.defaultView?.Element;
  return ElementType && node instanceof ElementType ? node : node.parentElement;
}

function pdfHighlightBackground(color: AnnotationColor): string {
  const colors: Record<AnnotationColor, string> = {
    yellow: "rgba(255, 213, 0, 0.35)",
    orange: "rgba(255, 140, 0, 0.35)",
    pink: "rgba(255, 105, 180, 0.35)",
    green: "rgba(82, 196, 26, 0.35)",
    blue: "rgba(22, 119, 255, 0.35)",
    purple: "rgba(114, 46, 209, 0.35)",
  };

  return colors[color] ?? colors.yellow;
}
