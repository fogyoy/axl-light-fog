import { StateField } from "@codemirror/state";
export const editorInfoField = StateField.define({
  create: () => ({ file: { path: "A.md" } }),
  update: (value) => value,
});
export class Plugin {
  constructor(app) {
    this.app = app;
  }
  registerDomEvent() {}
  registerEvent() {}
}
export class Component {}
export class FileView {}
export class FileSystemAdapter {}
export class MarkdownView extends FileView {}
export class ItemView extends FileView {}
export class Modal {}
export class PluginSettingTab {}
export class Notice {}
export class Setting {}
export class TFile {
  constructor(path = "A.md") {
    this.path = path;
    this.extension = path.split(".").pop();
  }
}
export const normalizePath = (path) => path.replaceAll("\\", "/");
export const addIcon = () => {};
export const setIcon = () => {};
export class MarkdownRenderer {}
