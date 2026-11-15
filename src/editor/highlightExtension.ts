/**
 * [INPUT]: 依赖 CodeMirror Decoration API、obsidian editorInfoField、storage/types 的注释文档
 * [OUTPUT]: 对外提供 createHighlightExtension，仅在全文编辑器渲染高亮，按文档订阅刷新并释放监听
 * [POS]: editor 模块的 CM6 高亮投影层，只画视觉效果不修改 doc
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { RangeSetBuilder, StateEffect, type ChangeDesc } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { editorInfoField } from "obsidian";

import { FileAnnotationDocument } from "../storage/types";
import { editorCellScope } from "./sourceProjection";
import { highlightBackground } from "./readingViewHighlight";
import { visibleMarkdownMarks } from "../storage/visibleMarks";

interface HighlightExtensionOptions {
  getDocument: (filePath: string) => FileAnnotationDocument | null;
  getSource: (filePath: string) => string | undefined;
  getVersion: () => number;
  onDocumentChange: (listener: (filePath: string) => void) => () => void;
  trackSource: (
    filePath: string,
    before: string,
    after: string,
    changes: ChangeDesc,
  ) => void;
  rememberSelection: (
    filePath: string,
    startOffset: number,
    endOffset: number,
    text: string,
    document: Document,
    source: string,
  ) => void;
}

export const refreshHighlightsEffect = StateEffect.define<null>();

export function createHighlightExtension(options: HighlightExtensionOptions) {
  return ViewPlugin.fromClass(
    class HighlightPlugin {
      decorations: DecorationSet;
      private version = -1;
      private destroyed = false;
      private readonly unsubscribe: () => void;

      constructor(private readonly view: EditorView) {
        this.decorations = this.buildDecorations();
        this.version = options.getVersion();
        this.captureSelection();
        this.unsubscribe = options.onDocumentChange((filePath) => {
          if (filePath === this.filePath())
            queueMicrotask(() => {
              if (!this.destroyed) this.view.dispatch({});
            });
        });
      }

      destroy(): void {
        this.destroyed = true;
        this.unsubscribe();
      }

      update(update: ViewUpdate): void {
        const filePath = this.filePath();
        if (filePath && this.isMainEditor() && update.docChanged)
          options.trackSource(
            filePath,
            update.startState.doc.toString(),
            update.state.doc.toString(),
            update.changes,
          );
        const nextVersion = options.getVersion();
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshHighlightsEffect))) ||
          this.version !== nextVersion
        ) {
          this.version = nextVersion;
          this.decorations = this.buildDecorations();
        }

        if (update.selectionSet) {
          this.captureSelection();
        }
      }

      private buildDecorations(): DecorationSet {
        const filePath = this.filePath();
        if (!filePath) {
          return Decoration.none;
        }

        const document = options.getDocument(filePath);
        if (!document) {
          return Decoration.none;
        }

        const builder = new RangeSetBuilder<Decoration>();
        const docLength = this.view.state.doc.length;
        const scope = this.scope();
        if (!scope) return Decoration.none;
        const marks = visibleMarkdownMarks(document).sort(
          (a, b) => a.anchor.startOffset - b.anchor.startOffset,
        );

        for (const mark of marks) {
          if (mark.orphaned) {
            continue;
          }

          const from = mark.anchor.startOffset - scope.from;
          const to = mark.anchor.endOffset - scope.from;
          if (
            from < 0 ||
            to > docLength ||
            this.view.state.sliceDoc(from, to) !==
              (mark.anchor.sourceText ?? mark.anchor.selectedText)
          )
            continue;
          if (from === to) {
            continue;
          }

          builder.add(
            from,
            to,
            Decoration.mark({
              class: `axl-highlight axl-highlight--${mark.color}`,
              attributes: {
                "data-axl-color": mark.color,
                "data-axl-id": mark.id,
                "data-axl-file": filePath,
                style: `background-color: ${highlightBackground(mark.color)} !important;`,
              },
            }),
          );
        }

        return builder.finish();
      }

      private captureSelection(): void {
        const filePath = this.filePath();
        if (!filePath) {
          return;
        }

        const selection = this.view.state.selection.main;
        if (selection.empty) {
          return;
        }

        options.rememberSelection(
          filePath,
          selection.from + (this.scope()?.from ?? 0),
          selection.to + (this.scope()?.from ?? 0),
          this.view.state.sliceDoc(selection.from, selection.to),
          this.view.dom.ownerDocument,
          options.getSource(filePath) ?? this.view.state.doc.toString(),
        );
      }

      private isMainEditor(): boolean {
        return (
          this.view.dom
            .closest(".markdown-source-view")
            ?.querySelector(".cm-editor") === this.view.dom
        );
      }
      private scope(): { from: number; to: number } | null {
        if (this.isMainEditor())
          return { from: 0, to: this.view.state.doc.length };
        const path = this.view.state.field(editorInfoField, false)?.file?.path;
        const source = path ? options.getSource(path) : undefined;
        return source === undefined
          ? null
          : editorCellScope(
              this.view.dom,
              source,
              this.view.state.doc.toString(),
            );
      }
      private filePath(): string | null {
        return this.scope()
          ? (this.view.state.field(editorInfoField, false)?.file?.path ?? null)
          : null;
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
    },
  );
}
