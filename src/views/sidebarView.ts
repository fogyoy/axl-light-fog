/**
 * [INPUT]: 依赖 Obsidian ItemView、AnnotationStore 数据与插件主类回调
 * [OUTPUT]: 对外提供 AnnotationSidebarView，仅为 Markdown/PDF 文件渲染 highlight 与关联 note 总览
 * [POS]: views 模块的右侧 Leaf 总览面板，是 sticky lane 移除后的主注释工作台
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import {
  FileView,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

import { COLOR_LABELS } from "../storage/types";

import type OverlayAnnotationsPlugin from "../../main";
import {
  ANNOTATION_COLORS,
  AnnotationColor,
  AnnotationSortMode,
  CommentAnnotation,
  HighlightAnnotation,
  PdfCommentAnnotation,
  PdfHighlightAnnotation,
} from "../storage/types";

export const ANNOTATION_SIDEBAR_VIEW = "axl-light-sidebar";

type AnnotationKind = "highlight" | "note";
type AnnotationMode = "md" | "pdf";
type TypeFilter = "all" | AnnotationKind;

type HighlightSource =
  | {
      mode: "md";
      highlight: HighlightAnnotation;
      note: CommentAnnotation | null;
      pageNumber: null;
      startOffset: number;
    }
  | {
      mode: "pdf";
      highlight: PdfHighlightAnnotation;
      note: PdfCommentAnnotation | null;
      pageNumber: number;
      startOffset: number;
    };

type OrphanNoteSource =
  | {
      mode: "md";
      note: CommentAnnotation;
      pageNumber: null;
      startOffset: number;
    }
  | {
      mode: "pdf";
      note: PdfCommentAnnotation;
      pageNumber: number;
      startOffset: number;
    };

type SidebarCard =
  | {
      id: string;
      kind: "highlight";
      mode: AnnotationMode;
      color: AnnotationColor;
      text: string;
      content: string;
      createdAt: string;
      startOffset: number;
      pageNumber: number | null;
      orphaned?: boolean;
      isCode: boolean;
      highlight: HighlightAnnotation | PdfHighlightAnnotation;
      note: CommentAnnotation | PdfCommentAnnotation | null;
    }
  | {
      id: string;
      kind: "note";
      mode: AnnotationMode;
      color: AnnotationColor;
      text: string;
      content: string;
      createdAt: string;
      startOffset: number;
      pageNumber: number | null;
      orphaned?: boolean;
      isCode: boolean;
      highlight: null;
      note: CommentAnnotation | PdfCommentAnnotation;
    };

export class AnnotationSidebarView extends ItemView {
  private query = "";
  private color: AnnotationColor | "all" = "all";
  private type: TypeFilter = "all";
  private sort: AnnotationSortMode = "document";
  private renderedFilePath: string | null = null;
  private renderVersion = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: OverlayAnnotationsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return ANNOTATION_SIDEBAR_VIEW;
  }

  getDisplayText(): string {
    return "Axl Light";
  }

  getIcon(): string {
    return "axl-light-icon";
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass("axl-sidebar");
    await this.render();
  }

  async render(): Promise<void> {
    const currentPath = this.app.workspace.getActiveFile()?.path ?? null;
    if (
      currentPath === this.renderedFilePath &&
      this.containerEl.querySelector(".axl-ov-edit:not(.hidden)")
    )
      return;
    this.renderedFilePath = currentPath;
    const version = ++this.renderVersion;
    const container = this.containerEl.children[1] ?? this.containerEl;
    container.empty();
    container.addClass("axl-overview");

    const file = this.app.workspace.getActiveFile();
    this.renderHeader(container);
    this.renderControls(container);

    if (!file || !isAnnotatableFile(file)) {
      container.createDiv({
        cls: "axl-empty",
        text: "打开 Markdown 或 PDF 文件以查看注释。",
      });
      return;
    }

    const document = await this.plugin.store.getDocument(file);
    if (
      version !== this.renderVersion ||
      this.app.workspace.getActiveFile()?.path !== file.path
    )
      return;
    const rawCards = this.buildCards(
      document.highlights,
      document.comments,
      document.pdfHighlights,
      document.pdfComments,
    );
    const cards = this.filterCards(rawCards);
    const highlightCount =
      document.highlights.filter((highlight) => !highlight.orphaned).length +
      document.pdfHighlights.filter((highlight) => !highlight.orphaned).length;
    const noteCount =
      document.comments.filter((comment) => !comment.orphaned).length +
      document.pdfComments.filter((comment) => !comment.orphaned).length;
    container.createDiv({
      cls: "axl-ov-count",
      text: `${highlightCount} 处高亮 · ${noteCount} 条便签`,
    });

    const uncertain = rawCards.filter(
      (card) =>
        card.orphaned ||
        this.plugin.pendingReadingLocations.get(file.path)?.has(card.id),
    ).length;
    if (uncertain)
      container.createDiv({
        cls: "axl-empty",
        text: `${uncertain} 处标注的位置待确认；内容已保留，不会自动绑定其他同词。`,
      });
    const list = container.createDiv({ cls: "axl-ov-list" });
    if (!cards.length) {
      list.createDiv({ cls: "axl-empty", text: "没有符合条件的注释。" });
    } else {
      for (const card of cards) {
        this.renderCard(list, file, card);
      }
    }

    this.renderExportFooter(container, file);
  }

  private buildCards(
    highlights: HighlightAnnotation[],
    comments: CommentAnnotation[],
    pdfHighlights: PdfHighlightAnnotation[],
    pdfComments: PdfCommentAnnotation[],
  ): SidebarCard[] {
    const usedNotes = new Set<string>();
    const cards: SidebarCard[] = [];

    for (const source of this.markdownHighlightSources(
      highlights,
      comments,
      usedNotes,
    )) {
      cards.push(this.highlightCard(source));
    }

    for (const source of this.pdfHighlightSources(
      pdfHighlights,
      pdfComments,
      usedNotes,
    )) {
      cards.push(this.highlightCard(source));
    }

    for (const source of this.orphanNoteSources(
      comments,
      pdfComments,
      usedNotes,
    )) {
      cards.push(this.orphanNoteCard(source));
    }

    return cards;
  }

  private markdownHighlightSources(
    highlights: HighlightAnnotation[],
    comments: CommentAnnotation[],
    usedNotes: Set<string>,
  ): HighlightSource[] {
    return highlights.map((highlight) => {
      const note = this.findAttachedMarkdownNote(
        highlight,
        comments,
        usedNotes,
      );
      if (note) {
        usedNotes.add(note.id);
      }

      return {
        mode: "md",
        highlight,
        note,
        pageNumber: null,
        startOffset: highlight.anchor.startOffset,
      };
    });
  }

  private pdfHighlightSources(
    highlights: PdfHighlightAnnotation[],
    comments: PdfCommentAnnotation[],
    usedNotes: Set<string>,
  ): HighlightSource[] {
    return highlights.map((highlight) => {
      const note = this.findAttachedPdfNote(highlight, comments, usedNotes);
      if (note) {
        usedNotes.add(note.id);
      }

      return {
        mode: "pdf",
        highlight,
        note,
        pageNumber: highlight.anchor.pageNumber,
        startOffset: Number.MAX_SAFE_INTEGER,
      };
    });
  }

  private orphanNoteSources(
    comments: CommentAnnotation[],
    pdfComments: PdfCommentAnnotation[],
    usedNotes: Set<string>,
  ): OrphanNoteSource[] {
    return [
      ...comments
        .filter((note) => !usedNotes.has(note.id))
        .map(
          (note): OrphanNoteSource => ({
            mode: "md",
            note,
            pageNumber: null,
            startOffset: note.anchor.startOffset,
          }),
        ),
      ...pdfComments
        .filter((note) => !usedNotes.has(note.id))
        .map(
          (note): OrphanNoteSource => ({
            mode: "pdf",
            note,
            pageNumber: note.anchor.pageNumber,
            startOffset: Number.MAX_SAFE_INTEGER,
          }),
        ),
    ];
  }

  private findAttachedMarkdownNote(
    highlight: HighlightAnnotation,
    comments: CommentAnnotation[],
    usedNotes: Set<string>,
  ): CommentAnnotation | null {
    return (
      comments.find(
        (note) => !usedNotes.has(note.id) && note.highlightId === highlight.id,
      ) ??
      comments.find((note) => {
        return (
          !usedNotes.has(note.id) &&
          !note.highlightId &&
          note.anchor.startOffset === highlight.anchor.startOffset &&
          note.anchor.selectedText === highlight.anchor.selectedText
        );
      }) ??
      null
    );
  }

  private findAttachedPdfNote(
    highlight: PdfHighlightAnnotation,
    comments: PdfCommentAnnotation[],
    usedNotes: Set<string>,
  ): PdfCommentAnnotation | null {
    return (
      comments.find(
        (note) => !usedNotes.has(note.id) && note.highlightId === highlight.id,
      ) ??
      comments.find((note) => {
        return (
          !usedNotes.has(note.id) &&
          !note.highlightId &&
          note.anchor.pageNumber === highlight.anchor.pageNumber &&
          note.anchor.selectedText === highlight.anchor.selectedText
        );
      }) ??
      null
    );
  }

  private highlightCard(source: HighlightSource): SidebarCard {
    return {
      id: source.highlight.id,
      kind: "highlight",
      mode: source.mode,
      color: source.highlight.color,
      text: source.highlight.anchor.selectedText,
      content: source.note?.content ?? "",
      createdAt: source.highlight.createdAt,
      startOffset: source.startOffset,
      pageNumber: source.pageNumber,
      orphaned: source.highlight.orphaned || source.note?.orphaned,
      isCode: isCodeAnchor(source.highlight.anchor),
      highlight: source.highlight,
      note: source.note,
    };
  }

  private orphanNoteCard(source: OrphanNoteSource): SidebarCard {
    return {
      id: source.note.id,
      kind: "note",
      mode: source.mode,
      color: source.note.color,
      text: source.note.anchor.selectedText,
      content: source.note.content,
      createdAt: source.note.createdAt,
      startOffset: source.startOffset,
      pageNumber: source.pageNumber,
      orphaned: source.note.orphaned,
      isCode: isCodeAnchor(source.note.anchor),
      highlight: null,
      note: source.note,
    };
  }

  private renderHeader(container: Element): void {
    const header = container.createDiv({ cls: "axl-ov-head" });
    header.createSpan({ cls: "axl-ov-title", text: "Axl Light" });
    const close = header.createEl("button", {
      cls: "axl-icon-btn axl-ov-close",
      attr: {
        type: "button",
        title: "关闭面板",
        "aria-label": "关闭 Axl Light 面板",
      },
    });
    setIcon(close, "x");
    close.addEventListener("click", () => {
      void this.leaf.detach();
    });
  }

  private renderControls(container: Element): void {
    const searchRow = container.createDiv({ cls: "axl-ov-search-row" });
    const search = searchRow.createEl("input", {
      cls: "axl-ov-search",
      attr: { type: "search", placeholder: "搜索注释…" },
    });
    search.value = this.query;
    search.addEventListener("input", async () => {
      this.query = search.value;
      await this.render();
    });
    const filterButton = searchRow.createEl("button", {
      cls: "axl-icon-btn",
      attr: { type: "button", title: "筛选" },
    });
    setIcon(filterButton, "filter");

    const filterRow = container.createDiv({ cls: "axl-ov-filter-row" });
    const color = filterRow.createEl("select", { cls: "axl-filter-select" });
    color.createEl("option", { text: "所有颜色", value: "all" });
    for (const item of ANNOTATION_COLORS) {
      color.createEl("option", { text: COLOR_LABELS[item], value: item });
    }
    color.value = this.color;
    color.addEventListener("change", async () => {
      this.color = color.value as AnnotationColor | "all";
      await this.render();
    });

    const type = filterRow.createEl("select", { cls: "axl-filter-select" });
    type.createEl("option", { text: "所有类型", value: "all" });
    type.createEl("option", { text: "高亮", value: "highlight" });
    type.createEl("option", { text: "便签", value: "note" });
    type.value = this.type;
    type.addEventListener("change", async () => {
      this.type = type.value as TypeFilter;
      await this.render();
    });

    const sort = filterRow.createEl("select", { cls: "axl-filter-select" });
    for (const item of ["document", "newest", "oldest"] as const) {
      sort.createEl("option", {
        text: {
          document: "按文档顺序",
          newest: "最新优先",
          oldest: "最早优先",
        }[item],
        value: item,
      });
    }
    sort.value = this.sort;
    sort.addEventListener("change", async () => {
      this.sort = sort.value as AnnotationSortMode;
      await this.render();
    });
  }

  private renderCard(list: Element, file: TFile, cardData: SidebarCard): void {
    const card = list.createDiv({
      cls: `axl-ov-card axl-ov-card--${cardData.color}`,
      attr: this.cardAttributes(cardData),
    });
    card.toggleClass("is-orphaned", !!cardData.orphaned);

    const head = card.createDiv({ cls: "axl-ov-card-head" });
    head.createSpan({
      cls: `axl-ov-label axl-label--${cardData.color}`,
      text: COLOR_LABELS[cardData.color],
    });
    head.createSpan({ cls: "axl-ov-meta", text: cardData.mode });
    head.createSpan({ cls: "axl-ov-dot", text: "·" });
    const title = cardData.note?.title ?? "";
    const type = head.createSpan({
      cls: "axl-ov-type",
      text: title ? getTitleLabel(title) : cardData.note ? "便签" : "高亮",
    });
    if (title) {
      type.dataset.title = title;
    }
    head.createSpan({
      cls: "axl-ov-time",
      text: formatTime(cardData.createdAt),
    });

    const quote = card.createDiv({ cls: "axl-ov-quote" });
    quote.textContent = cardData.text;
    quote.toggleClass(
      "is-code",
      cardData.isCode || isCodeLikeText(cardData.text),
    );
    this.addExpandToggle(quote, card);
    if (cardData.content) {
      const content = card.createDiv({ cls: "axl-ov-content" });
      void MarkdownRenderer.render(
        this.app,
        cardData.content,
        content,
        file.path,
        this,
      ).then(() => {
        this.addExpandToggle(content, card);
      });
    }

    const source = card.createDiv({ cls: "axl-ov-source" });
    source.createSpan({ cls: "axl-ov-file", text: file.name });
    source.createSpan({
      cls: "axl-ov-mode",
      text: cardData.pageNumber ? `第 ${cardData.pageNumber} 页` : "Markdown",
    });

    const actions = card.createDiv({ cls: "axl-ov-actions" });
    if (cardData.note) {
      const edit = actions.createEl("button", {
        cls: "axl-ov-btn axl-ov-btn--icon",
        attr: { type: "button", title: "编辑便签", "data-action": "edit-note" },
      });
      setIcon(edit, "pencil");
      edit.addEventListener("click", () =>
        this.openInlineEditor(card, file, cardData, cardData.content),
      );
    } else if (cardData.highlight) {
      const addNote = actions.createEl("button", {
        cls: "axl-ov-btn",
        text: "添加便签",
        attr: { type: "button", "data-action": "add-note" },
      });
      addNote.addEventListener("click", () => {
        addNote.addClass("hidden");
        this.openInlineEditor(card, file, cardData, "");
      });
    }

    const jump = actions.createEl("button", {
      cls: "axl-ov-btn",
      text: "跳转",
      attr: { type: "button", "data-action": "jump" },
    });
    jump.addEventListener("click", () => {
      void this.jumpTo(file, cardData);
    });

    const remove = actions.createEl("button", {
      cls: "axl-ov-btn axl-ov-btn--danger",
      text: "删除",
      attr: { type: "button", "data-action": "delete" },
    });
    remove.addEventListener("click", async () => {
      await this.deleteCard(file, cardData);
      new Notice("已删除注释");
      await this.plugin.refreshAnnotations();
    });

    const edit = card.createDiv({ cls: "axl-ov-edit hidden" });
    const textarea = edit.createEl("textarea", {
      cls: "axl-ov-textarea",
      attr: { placeholder: "写下你的想法..." },
    });
    const editActions = edit.createDiv({ cls: "axl-ov-edit-actions" });
    editActions.createEl("button", {
      cls: "axl-ov-save",
      text: "保存",
      attr: { type: "button" },
    });
    editActions.createEl("button", {
      cls: "axl-ov-cancel",
      text: "取消",
      attr: { type: "button" },
    });
  }

  private cardAttributes(card: SidebarCard): Record<string, string> {
    const attrs: Record<string, string> = { "data-id": card.id };
    if (card.highlight) {
      attrs["data-highlight-id"] = card.highlight.id;
    }
    if (card.note) {
      attrs["data-note-id"] = card.note.id;
    }
    return attrs;
  }

  private openInlineEditor(
    card: HTMLElement,
    file: TFile,
    cardData: SidebarCard,
    initialValue: string,
  ): void {
    const edit = card.querySelector<HTMLElement>(".axl-ov-edit");
    const textarea =
      card.querySelector<HTMLTextAreaElement>(".axl-ov-textarea");
    const save = card.querySelector<HTMLButtonElement>(".axl-ov-save");
    const cancel = card.querySelector<HTMLButtonElement>(".axl-ov-cancel");
    const addNote = card.querySelector<HTMLElement>('[data-action="add-note"]');
    if (!edit || !textarea || !save || !cancel) {
      return;
    }

    textarea.value = initialValue;
    edit.removeClass("hidden");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const saveContent = async (): Promise<void> => {
      await this.saveCardContent(file, cardData, textarea.value);
      edit.addClass("hidden");
      await this.plugin.refreshAnnotations();
    };

    save.onclick = () => {
      void saveContent();
    };
    cancel.onclick = () => {
      textarea.value = initialValue;
      edit.addClass("hidden");
      addNote?.removeClass("hidden");
      void this.render();
    };
    textarea.onkeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void saveContent();
      }
      if (event.key === "Escape") {
        textarea.value = initialValue;
        edit.addClass("hidden");
        addNote?.removeClass("hidden");
      }
    };
  }

  private addExpandToggle(
    contentEl: HTMLElement,
    wrapperEl: HTMLElement,
  ): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const lineHeight = parseFloat(getComputedStyle(contentEl).lineHeight);
        const threshold = lineHeight * 3 + 10;
        if (contentEl.scrollHeight <= threshold + 2) {
          return;
        }

        const button = document.createElement("span");
        button.className = "axl-ov-expand-btn";
        button.textContent = "展开";
        button.tabIndex = 0;
        button.setAttribute("role", "button");
        contentEl.insertAdjacentElement("afterend", button);
        const toggle = (): void => {
          const expanded = contentEl.hasClass("expanded");
          contentEl.toggleClass("expanded", !expanded);
          button.setText(expanded ? "展开" : "收起");
        };
        button.addEventListener("click", toggle);
        button.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        });
      });
    });
  }

  private async saveCardContent(
    file: TFile,
    card: SidebarCard,
    content: string,
  ): Promise<void> {
    if (card.note && card.mode === "pdf") {
      await this.plugin.store.updatePdfCommentContent(
        file,
        card.note.id,
        content,
        card.note.title,
      );
      return;
    }

    if (card.note && card.mode === "md") {
      await this.plugin.store.updateCommentContent(
        file,
        card.note.id,
        content,
        card.note.title,
      );
      return;
    }

    if (card.highlight && card.mode === "pdf") {
      const now = new Date().toISOString();
      const highlight = (
        await this.plugin.store.getDocument(file)
      ).pdfHighlights.find((item) => item.id === card.highlight?.id);
      if (!highlight) throw new Error("Annotation no longer exists");
      await this.plugin.store.addPdfComment(file, {
        id: crypto.randomUUID(),
        highlightId: highlight.id,
        anchor: highlight.anchor,
        content,
        color: highlight.color,
        position: { offsetX: 20, offsetY: 0 },
        collapsed: false,
        author: this.plugin.settings.defaultAuthor,
        createdAt: now,
        updatedAt: now,
        replies: [],
        resolved: false,
      });
      return;
    }

    if (card.highlight && card.mode === "md") {
      const now = new Date().toISOString();
      const highlight = (
        await this.plugin.store.getDocument(file)
      ).highlights.find((item) => item.id === card.highlight?.id);
      if (!highlight) throw new Error("Annotation no longer exists");
      await this.plugin.store.addComment(file, {
        id: crypto.randomUUID(),
        highlightId: highlight.id,
        anchor: highlight.anchor,
        content,
        color: highlight.color,
        position: { offsetX: 20, offsetY: 0 },
        collapsed: false,
        author: this.plugin.settings.defaultAuthor,
        createdAt: now,
        updatedAt: now,
        replies: [],
        resolved: false,
      });
    }
  }

  private async deleteCard(file: TFile, card: SidebarCard): Promise<void> {
    if (card.highlight) {
      await this.plugin.store.removeAnnotation(file, card.highlight.id);
    }
    if (card.note) {
      await this.plugin.store.removeAnnotation(file, card.note.id);
    }
  }

  private filterCards(cards: SidebarCard[]): SidebarCard[] {
    return cards
      .filter((card) => this.color === "all" || card.color === this.color)
      .filter((card) => {
        if (this.type === "all") {
          return true;
        }
        if (this.type === "highlight") {
          return card.kind === "highlight" && !card.note;
        }
        return Boolean(card.note);
      })
      .filter((card) => {
        const haystack = `${card.text} ${card.content}`.toLowerCase();
        return haystack.includes(this.query.toLowerCase());
      })
      .sort((a, b) => {
        if (this.sort === "newest") {
          return this.cardUpdatedAt(b).localeCompare(this.cardUpdatedAt(a));
        }
        if (this.sort === "oldest") {
          return this.cardUpdatedAt(a).localeCompare(this.cardUpdatedAt(b));
        }
        return (
          (a.pageNumber ?? 0) - (b.pageNumber ?? 0) ||
          a.startOffset - b.startOffset
        );
      });
  }

  private cardUpdatedAt(card: SidebarCard): string {
    return card.note?.updatedAt ?? card.createdAt;
  }

  private renderExportFooter(container: Element, file: TFile | null): void {
    const footer = container.createDiv({ cls: "axl-ov-foot" });
    const exportButton = footer.createEl("button", {
      cls: "axl-export-btn",
      text: "↑ 导出注释",
      attr: { type: "button" },
    });
    exportButton.disabled = !file;
    exportButton.addEventListener("click", async () => {
      if (!file) {
        return;
      }
      const exported = await this.plugin.store.exportNotes(file);
      new Notice(`注释已导出至 ${exported.path}`);
    });
    footer.createDiv({
      cls: "axl-ov-export-note",
      text: "导出为 Markdown 摘要",
    });
  }

  private async jumpTo(file: TFile, card: SidebarCard): Promise<void> {
    if (card.orphaned) {
      new Notice("原标注位置已失效，注释内容仍保留，请确认后重新标注。");
      return;
    }
    const workspace = this.app.workspace;
    const recent = workspace.getMostRecentLeaf();
    const matchesFile = (leaf: WorkspaceLeaf): boolean =>
      leaf.view instanceof FileView && leaf.view.file?.path === file.path;
    const type = file.extension.toLowerCase() === "pdf" ? "pdf" : "markdown";
    const leaf =
      recent && matchesFile(recent)
        ? recent
        : (workspace.getLeavesOfType(type).find(matchesFile) ??
          workspace.getLeaf(false));

    if (!matchesFile(leaf)) await leaf.openFile(file);
    await workspace.revealLeaf(leaf);

    if (type === "pdf") {
      const pageNumber = card.pageNumber;
      if (pageNumber === null) return;
      const page = await waitForElement(() =>
        leaf.view.containerEl.querySelector<HTMLElement>(
          `.pdf-page[data-page-number="${pageNumber}"], .page[data-page-number="${pageNumber}"]`,
        ),
      );
      if (!page) {
        new Notice("无法定位到 PDF 页面，请稍后重试。");
        return;
      }
      page.scrollIntoView({ block: "center" });
      flashElement(page);
      return;
    }

    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      new Notice("无法打开标注所在的笔记。");
      return;
    }

    const position = view.editor.offsetToPos(card.startOffset);
    if (view.getMode() === "preview") {
      await waitForElement(() =>
        view.previewMode.containerEl.querySelector<HTMLElement>(
          '.markdown-preview-section > div[class^="el-"]',
        ),
      );
      await new Promise<void>((resolve) =>
        (
          view.containerEl.ownerDocument.defaultView ?? window
        ).requestAnimationFrame(() => resolve()),
      );
      view.previewMode.applyScroll(position.line);
      const id = card.highlight?.id ?? card.note?.id;
      const mark = await waitForElement(
        () =>
          Array.from(
            view.previewMode.containerEl.querySelectorAll<HTMLElement>(
              ".axl-reading-highlight[data-axl-id]",
            ),
          ).find((element) => element.dataset.axlId === id) ?? null,
      );
      if (mark) {
        mark.scrollIntoView({ block: "center" });
        flashElement(mark);
      } else {
        new Notice("已跳转到标注所在行；未能显示精确位置。");
      }
      return;
    }

    view.editor.setCursor(position);
    view.editor.scrollIntoView({ from: position, to: position }, true);
    view.editor.focus();
    const mark = Array.from(
      view.containerEl.querySelectorAll<HTMLElement>(
        ".axl-highlight[data-axl-id]",
      ),
    ).find(
      (element) =>
        element.dataset.axlId === (card.highlight?.id ?? card.note?.id),
    );
    if (mark) flashElement(mark);
  }
}

async function waitForElement(
  find: () => HTMLElement | null,
): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const element = find();
    if (element) return element;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
  }
  return null;
}

function flashElement(element: HTMLElement): void {
  element.removeClass("axl-flash-target");
  void element.offsetWidth;
  element.addClass("axl-flash-target");
  window.setTimeout(() => element.removeClass("axl-flash-target"), 850);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getTitleLabel(title: string): string {
  const labels: Record<string, string> = {
    Insight: "💡 洞见",
    Question: "❓ 问题",
    Reminder: "🔔 提醒",
  };
  return labels[title] ?? title;
}

function isCodeAnchor(
  anchor: HighlightAnnotation["anchor"] | PdfHighlightAnnotation["anchor"],
): boolean {
  return "isCode" in anchor && Boolean(anchor.isCode);
}

function isCodeLikeText(text: string): boolean {
  return /^[ \t]{2,}/m.test(text) || /\n[ \t]{2,}\S/.test(text);
}

function isAnnotatableFile(file: TFile): boolean {
  return ["md", "pdf"].includes(file.extension.toLowerCase());
}
