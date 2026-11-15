/**
 * [INPUT]: 依赖 obsidian App/Vault/Adapter 的文件读写能力，依赖 storage/types 的 sidecar JSON 合约
 * [OUTPUT]: 对外提供 AnnotationStore，负责 sidecar、索引、缓存、迁移、导出与按文档的变更通知
 * [POS]: storage 模块的唯一持久化入口，隔离原始 Markdown 与注释数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import type { ChangeDesc } from "@codemirror/state";
import {
  relocateDocumentAnchors,
  normalizeMarkdownSource,
} from "../anchor/textAnchor";
import { COLOR_LABELS } from "./types";
import { App, normalizePath, TFile, Notice, FileSystemAdapter } from "obsidian";
import { parseAnnotationDocument, parseAnnotationIndex } from "./validation";

import {
  AnnotationIndex,
  AnnotationIndexEntry,
  CommentAnnotation,
  FileAnnotationDocument,
  HighlightAnnotation,
  TextAnchor,
  PdfCommentAnnotation,
  PdfHighlightAnnotation,
} from "./types";

const STORE_DIR = ".obsidian-annotations";
const INDEX_PATH = normalizePath(`${STORE_DIR}/index.json`);
const SIDECAR_SLUG_MAX_LENGTH = 72;
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

export class AnnotationStore {
  private readonly documents = new Map<string, FileAnnotationDocument>();
  private index: AnnotationIndex = { version: 1, files: {} };
  private readonly loading = new Map<string, Promise<FileAnnotationDocument>>();
  private writes: Promise<void> = Promise.resolve();
  private changeVersion = 0;
  private readonly sources = new Map<string, string>();
  private readonly deletedAnchors = new Map<
    string,
    Map<string, { source: string; anchor: TextAnchor }>
  >();
  private readonly documentVersions = new Map<string, number>();
  private readonly listeners = new Set<(filePath: string) => void>();

  constructor(private readonly app: App) {}

  get version(): number {
    return this.changeVersion;
  }

  getDocumentVersion(filePath: string): number {
    return this.documentVersions.get(this.toCacheKey(filePath)) ?? 0;
  }

  onDocumentChange(listener: (filePath: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    await this.ensureStoreDir();
    this.index = await this.readJson(
      INDEX_PATH,
      { version: 1, files: {} },
      parseAnnotationIndex,
    );
  }

  getCachedDocument(filePath: string): FileAnnotationDocument | null {
    return this.documents.get(this.toCacheKey(filePath)) ?? null;
  }

  async getDocument(file: TFile): Promise<FileAnnotationDocument> {
    const key = this.toCacheKey(file.path);
    const cached = this.documents.get(key);
    if (cached) return cached;
    const pending = this.loading.get(key);
    if (pending) return pending;
    const load = this.loadDocument(file);
    this.loading.set(key, load);
    try {
      return await load;
    } finally {
      this.loading.delete(key);
    }
  }

  private async loadDocument(file: TFile): Promise<FileAnnotationDocument> {
    const filePath = this.normalizeVaultPath(file.path);
    const cacheKey = this.toCacheKey(filePath);
    const cached = this.documents.get(cacheKey);
    if (cached) {
      return cached;
    }

    const sidecarPath = this.toSidecarPath(filePath);
    const fallback = await this.createEmptyDocument(file);
    const document = await this.readDocumentForPath(
      filePath,
      sidecarPath,
      fallback,
    );
    const source =
      file.extension.toLowerCase() === "md"
        ? normalizeMarkdownSource(await this.app.vault.cachedRead(file))
        : undefined;
    const resolved =
      source === undefined
        ? document
        : relocateDocumentAnchors(
            source,
            document,
            undefined,
            undefined,
            document.fileHash === fallback.fileHash,
          );
    this.documents.set(cacheKey, resolved);
    if (source !== undefined) this.sources.set(cacheKey, source);
    this.notifyDocumentChanged(filePath);
    return this.documents.get(cacheKey)!;
  }

  getSource(filePath: string): string | undefined {
    return this.sources.get(this.toCacheKey(filePath));
  }

  trackSource(
    filePath: string,
    source: string,
    before?: string,
    changes?: ChangeDesc,
  ): void {
    source = normalizeMarkdownSource(source);
    const key = this.toCacheKey(filePath),
      previous = this.sources.get(key),
      document = this.documents.get(key);
    if (previous === source) return;
    if (document) {
      let relocated = relocateDocumentAnchors(
        source,
        document,
        previous,
        previous === before ? changes : undefined,
      );
      const deleted =
        this.deletedAnchors.get(key) ??
        new Map<string, { source: string; anchor: TextAnchor }>();
      const nextMarks = [...relocated.highlights, ...relocated.comments];
      for (const mark of [...document.highlights, ...document.comments]) {
        if (
          !mark.orphaned &&
          nextMarks.find((next) => next.id === mark.id)?.orphaned &&
          previous !== undefined
        ) {
          deleted.set(mark.id, { source: previous, anchor: mark.anchor });
        }
      }
      // 撤销确实恢复了删除前的完整源码时，才允许恢复原锚点。
      const restore = <
        T extends { id: string; anchor: TextAnchor; orphaned?: boolean },
      >(
        mark: T,
      ): T => {
        const original = deleted.get(mark.id);
        if (!mark.orphaned || original?.source !== source) return mark;
        deleted.delete(mark.id);
        return { ...mark, anchor: original.anchor, orphaned: false };
      };
      relocated = {
        ...relocated,
        highlights: relocated.highlights.map(restore),
        comments: relocated.comments.map(restore),
      };
      if (this.deletedAnchors.size >= 8 && !this.deletedAnchors.has(key))
        this.deletedAnchors.delete(
          this.deletedAnchors.keys().next().value ?? "",
        );
      this.deletedAnchors.set(key, deleted);
      this.documents.set(key, relocated);
    }
    this.sources.set(key, source);
    this.notifyDocumentChanged(filePath);
  }

  async saveDocument(document: FileAnnotationDocument): Promise<void> {
    const snapshot = structuredClone(document);
    return this.enqueueWrite(() => this.commitDocument(snapshot));
  }

  private enqueueWrite<T>(action: () => Promise<T>): Promise<T> {
    const next = this.writes.then(action);
    this.writes = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private async commitDocument(
    document: FileAnnotationDocument,
  ): Promise<void> {
    const filePath = this.normalizeVaultPath(document.filePath);
    const sidecarPath = this.toSidecarPath(filePath);
    const normalized = structuredClone(
      this.normalizeDocument(document, filePath),
    );
    parseAnnotationDocument(normalized);
    const previous = this.documents.get(this.toCacheKey(filePath));
    this.documents.set(this.toCacheKey(filePath), normalized);
    let sidecarSaved = false;
    try {
      await this.ensureStoreDir();
      await this.writeJson(sidecarPath, normalized);
      sidecarSaved = true;
      this.index.files[filePath] = this.toIndexEntry(normalized, sidecarPath);
      await this.writeIndex();
      await this.deleteLegacySidecar(filePath, sidecarPath);
      this.notifyDocumentChanged(filePath);
    } catch (error) {
      if (
        !sidecarSaved &&
        previous &&
        this.documents.get(this.toCacheKey(filePath)) === normalized
      )
        this.documents.set(this.toCacheKey(filePath), previous);
      if (sidecarSaved) this.notifyDocumentChanged(filePath);
      new Notice(
        sidecarSaved
          ? "注释内容已保存，但索引更新失败，请检查磁盘后重试。"
          : "注释保存失败，原有数据已保留，请检查磁盘后重试。",
      );
      throw error;
    }
  }

  private notifyDocumentChanged(filePath: string): void {
    this.changeVersion += 1;
    const cacheKey = this.toCacheKey(filePath);
    this.documentVersions.set(cacheKey, this.getDocumentVersion(filePath) + 1);
    for (const listener of this.listeners) listener(filePath);
  }

  private updateDocument(
    file: TFile,
    update: (document: FileAnnotationDocument) => FileAnnotationDocument,
  ): Promise<FileAnnotationDocument> {
    return this.enqueueWrite(async () => {
      const next = update(structuredClone(await this.getDocument(file)));
      next.lastModified = new Date().toISOString();
      await this.commitDocument(next);
      return next;
    });
  }

  addHighlight(
    file: TFile,
    highlight: HighlightAnnotation,
  ): Promise<FileAnnotationDocument> {
    return this.updateDocument(file, (document) => ({
      ...document,
      highlights: [...document.highlights, highlight].sort(
        (a, b) => a.anchor.startOffset - b.anchor.startOffset,
      ),
    }));
  }
  addComment(
    file: TFile,
    comment: CommentAnnotation,
  ): Promise<FileAnnotationDocument> {
    return this.updateDocument(file, (document) => ({
      ...document,
      comments: [...document.comments, comment].sort(
        (a, b) => a.anchor.startOffset - b.anchor.startOffset,
      ),
    }));
  }
  addPdfHighlight(
    file: TFile,
    highlight: PdfHighlightAnnotation,
  ): Promise<FileAnnotationDocument> {
    return this.updateDocument(file, (document) => ({
      ...document,
      pdfHighlights: [...document.pdfHighlights, highlight].sort(
        (a, b) => a.anchor.pageNumber - b.anchor.pageNumber,
      ),
    }));
  }
  addPdfComment(
    file: TFile,
    comment: PdfCommentAnnotation,
  ): Promise<FileAnnotationDocument> {
    return this.updateDocument(file, (document) => ({
      ...document,
      pdfComments: [...document.pdfComments, comment].sort(
        (a, b) => a.anchor.pageNumber - b.anchor.pageNumber,
      ),
    }));
  }
  updateComment(
    file: TFile,
    comment: CommentAnnotation,
  ): Promise<FileAnnotationDocument> {
    return this.updateDocument(file, (document) => ({
      ...document,
      comments: document.comments.map((item) =>
        item.id === comment.id ? comment : item,
      ),
    }));
  }
  updatePdfComment(
    file: TFile,
    comment: PdfCommentAnnotation,
  ): Promise<FileAnnotationDocument> {
    return this.updateDocument(file, (document) => ({
      ...document,
      pdfComments: document.pdfComments.map((item) =>
        item.id === comment.id ? comment : item,
      ),
    }));
  }
  updateCommentContent(
    file: TFile,
    id: string,
    content: string,
    title?: string,
  ): Promise<FileAnnotationDocument> {
    return this.updateDocument(file, (document) => ({
      ...document,
      comments: document.comments.map((item) =>
        item.id === id
          ? { ...item, content, title, updatedAt: new Date().toISOString() }
          : item,
      ),
    }));
  }
  updatePdfCommentContent(
    file: TFile,
    id: string,
    content: string,
    title?: string,
  ): Promise<FileAnnotationDocument> {
    return this.updateDocument(file, (document) => ({
      ...document,
      pdfComments: document.pdfComments.map((item) =>
        item.id === id
          ? { ...item, content, title, updatedAt: new Date().toISOString() }
          : item,
      ),
    }));
  }
  removeAnnotation(file: TFile, id: string): Promise<FileAnnotationDocument> {
    return this.updateDocument(file, (document) => ({
      ...document,
      highlights: document.highlights.filter((item) => item.id !== id),
      comments: document.comments.filter((item) => item.id !== id),
      pdfHighlights: document.pdfHighlights.filter((item) => item.id !== id),
      pdfComments: document.pdfComments.filter((item) => item.id !== id),
    }));
  }

  async migrateFilePath(oldPath: string, file: TFile): Promise<void> {
    return this.enqueueWrite(async () => {
      const normalizedOldPath = this.normalizeVaultPath(oldPath);
      const oldDocument = {
        document:
          this.getCachedDocument(normalizedOldPath) ??
          (await this.readExistingDocument(normalizedOldPath)).document,
      };
      if (!oldDocument.document) {
        return;
      }

      const nextDocument: FileAnnotationDocument = {
        ...oldDocument.document,
        filePath: this.normalizeVaultPath(file.path),
        fileHash: await this.hashFile(file),
        lastModified: new Date().toISOString(),
      };

      const oldKey = this.toCacheKey(normalizedOldPath),
        newKey = this.toCacheKey(nextDocument.filePath);
      const source = this.sources.get(oldKey);
      if (source !== undefined) this.sources.set(newKey, source);
      this.sources.delete(oldKey);
      const deleted = this.deletedAnchors.get(oldKey);
      if (deleted) this.deletedAnchors.set(newKey, deleted);
      this.deletedAnchors.delete(oldKey);
      await this.commitDocument(nextDocument);
      await this.deleteSidecarsForPath(
        normalizedOldPath,
        new Set([this.toSidecarPath(nextDocument.filePath)]),
      );
      delete this.index.files[normalizedOldPath];
      await this.writeIndex();
      this.documents.delete(this.toCacheKey(normalizedOldPath));
    });
  }

  async exportNotes(file: TFile): Promise<TFile> {
    const document = await this.getDocument(file);
    const baseName = file.basename || file.name.replace(/\.md$/i, "");
    const targetPath = normalizePath(
      `${file.parent?.path ?? ""}/${baseName}-notes.md`,
    );
    const lines = [
      `# ${file.path} 的注释`,
      "",
      `导出时间：${new Date().toISOString()}`,
      "",
      "## 高亮",
      "",
      ...document.highlights.map((highlight) => {
        return `- ==${highlight.anchor.selectedText}== (${COLOR_LABELS[highlight.color]}, ${highlight.createdAt})`;
      }),
      ...document.pdfHighlights.map((highlight) => {
        return `- ==${highlight.anchor.selectedText}== (PDF 第 ${highlight.anchor.pageNumber} 页, ${COLOR_LABELS[highlight.color]}, ${highlight.createdAt})`;
      }),
      "",
      "## 便签",
      "",
      ...document.comments.map((comment) => {
        return [
          `### ${comment.anchor.selectedText}`,
          "",
          `颜色：${COLOR_LABELS[comment.color]}`,
          `创建时间：${comment.createdAt}`,
          "",
          comment.content,
          "",
        ].join("\n");
      }),
      ...document.pdfComments.map((comment) => {
        return [
          `### PDF 第 ${comment.anchor.pageNumber} 页： ${comment.anchor.selectedText}`,
          "",
          `颜色：${COLOR_LABELS[comment.color]}`,
          `创建时间：${comment.createdAt}`,
          "",
          comment.content,
          "",
        ].join("\n");
      }),
    ];

    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, lines.join("\n"));
      return existing;
    }

    return this.app.vault.create(targetPath, lines.join("\n"));
  }

  async touchFileHash(file: TFile): Promise<void> {
    const hash = await this.hashFile(file);
    await this.updateDocument(file, (document) => ({
      ...document,
      fileHash: hash,
    }));
  }

  async hashFile(file: TFile): Promise<string> {
    if (file.extension.toLowerCase() === "md") {
      return this.hashString(await this.app.vault.cachedRead(file));
    }

    const bytes = await this.app.vault.readBinary(file);
    return this.hashBytes(bytes);
  }

  toSidecarPath(filePath: string): string {
    const normalizedPath = this.normalizeVaultPath(filePath).toLowerCase();
    const slug = this.toSidecarSlug(normalizedPath);
    const hash = this.hashPath(normalizedPath);
    return normalizePath(`${STORE_DIR}/axl--${slug}--${hash}.json`);
  }

  private async createEmptyDocument(
    file: TFile,
  ): Promise<FileAnnotationDocument> {
    return {
      filePath: this.normalizeVaultPath(file.path),
      fileHash: await this.hashFile(file),
      lastModified: new Date().toISOString(),
      highlights: [],
      comments: [],
      pdfHighlights: [],
      pdfComments: [],
    };
  }

  private normalizeDocument(
    document: FileAnnotationDocument,
    filePath: string,
  ): FileAnnotationDocument {
    return {
      filePath,
      fileHash: document.fileHash ?? "",
      lastModified: document.lastModified ?? new Date().toISOString(),
      highlights: document.highlights ?? [],
      comments: document.comments ?? [],
      pdfHighlights: document.pdfHighlights ?? [],
      pdfComments: document.pdfComments ?? [],
    };
  }

  private toIndexEntry(
    document: FileAnnotationDocument,
    sidecarPath: string,
  ): AnnotationIndexEntry {
    return {
      filePath: document.filePath,
      sidecarPath,
      fileHash: document.fileHash,
      highlightCount:
        document.highlights.length + document.pdfHighlights.length,
      commentCount: document.comments.length + document.pdfComments.length,
      updatedAt: document.lastModified,
    };
  }

  private async ensureStoreDir(): Promise<void> {
    const storeDir = normalizePath(STORE_DIR);
    if (!(await this.app.vault.adapter.exists(storeDir))) {
      await this.app.vault.adapter.mkdir(storeDir);
    }
  }

  private async writeIndex(): Promise<void> {
    await this.ensureStoreDir();
    await this.writeJson(INDEX_PATH, this.index);
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const adapter = this.app.vault.adapter;
    const text = JSON.stringify(value, null, 2);
    if (!adapter.rename) {
      await adapter.write(path, text);
      return;
    }
    const temporary = `${path}.tmp`;
    await adapter.write(temporary, text);
    if (FileSystemAdapter && adapter instanceof FileSystemAdapter) {
      // Obsidian 的 rename 拒绝覆盖已有文件；桌面文件系统使用同目录原子替换。
      const { rename }: typeof import("fs/promises") = require("fs").promises;
      await rename(adapter.getFullPath(temporary), adapter.getFullPath(path));
    } else if (!(await adapter.exists(path)))
      await adapter.rename(temporary, path);
    else {
      await adapter.write(path, text);
      await adapter.remove(temporary);
    }
  }

  private async readDocumentForPath(
    filePath: string,
    sidecarPath: string,
    fallback: FileAnnotationDocument,
  ): Promise<FileAnnotationDocument> {
    const existing = await this.readExistingDocument(filePath);
    if (!existing.document) {
      return fallback;
    }

    const normalized = this.normalizeDocument(existing.document, filePath);

    return normalized;
  }

  private async readExistingDocument(filePath: string): Promise<{
    document: FileAnnotationDocument | null;
    sidecarPath: string | null;
  }> {
    for (const sidecarPath of this.toCandidateSidecarPaths(filePath)) {
      const document = await this.readJson<FileAnnotationDocument | null>(
        sidecarPath,
        null,
        parseAnnotationDocument,
      );
      if (document) {
        return { document, sidecarPath };
      }
    }

    return { document: null, sidecarPath: null };
  }

  private async readJson<T>(
    path: string,
    fallback: T,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const normalizedPath = normalizePath(path);
    if (!(await this.app.vault.adapter.exists(normalizedPath))) {
      return fallback;
    }

    try {
      return parse(
        JSON.parse(await this.app.vault.adapter.read(normalizedPath)),
      );
    } catch (error) {
      new Notice(
        `无法读取注释数据：${normalizedPath}。已停止写入，原文件未修改。`,
      );
      throw error;
    }
  }

  private async deleteIfExists(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    if (await this.app.vault.adapter.exists(normalizedPath)) {
      await this.app.vault.adapter.remove(normalizedPath);
    }
  }

  private async deleteLegacySidecar(
    filePath: string,
    currentSidecarPath: string,
  ): Promise<void> {
    await this.deleteSidecarsForPath(filePath, new Set([currentSidecarPath]));
  }

  private normalizeVaultPath(filePath: string): string {
    return normalizePath(filePath);
  }

  private toCacheKey(filePath: string): string {
    return this.normalizeVaultPath(filePath).toLowerCase();
  }

  private toCandidateSidecarPaths(filePath: string): string[] {
    return Array.from(
      new Set([
        this.toSidecarPath(filePath),
        this.toLegacySidecarPath(filePath),
      ]),
    );
  }

  private toLegacySidecarPath(filePath: string): string {
    const safeName = this.normalizeVaultPath(filePath)
      .toLowerCase()
      .split(/[\\/]/)
      .map((part) => encodeURIComponent(part))
      .join("__");
    return normalizePath(`${STORE_DIR}/${safeName}.json`);
  }

  private toSidecarSlug(filePath: string): string {
    const slug = filePath
      .split(/[\\/]/)
      .filter(Boolean)
      .join("__")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/_{3,}/g, "__")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, SIDECAR_SLUG_MAX_LENGTH)
      .replace(/[.-]+$/g, "");

    return slug || "file";
  }

  private async deleteSidecarsForPath(
    filePath: string,
    keepPaths: Set<string>,
  ): Promise<void> {
    for (const sidecarPath of this.toCandidateSidecarPaths(filePath)) {
      if (!keepPaths.has(sidecarPath)) {
        await this.deleteIfExists(sidecarPath);
      }
    }
  }

  private hashPath(filePath: string): string {
    let hash = FNV_OFFSET_BASIS;

    for (let index = 0; index < filePath.length; index += 1) {
      hash ^= BigInt(filePath.charCodeAt(index));
      hash = (hash * FNV_PRIME) & FNV_MASK;
    }

    return hash.toString(16).padStart(16, "0");
  }

  private async hashString(content: string): Promise<string> {
    return this.hashBytes(new TextEncoder().encode(content));
  }

  private async hashBytes(bytes: BufferSource): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
}
