/**
 * [INPUT]: 依赖 Obsidian PluginSettingTab/Setting 与 storage/types 的设置模型
 * [OUTPUT]: 对外提供 AnnotationSettingsTab，负责默认颜色、便签栏、窄屏折叠、连接线、作者、备份、重命名迁移设置
 * [POS]: settings 模块的用户配置界面，被 main.ts 注册
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

import { PluginSettingTab, Setting } from "obsidian";

import type OverlayAnnotationsPlugin from "../../main";
import { ANNOTATION_COLORS, AnnotationColor, SidebarSide, COLOR_LABELS } from "../storage/types";

export class AnnotationSettingsTab extends PluginSettingTab {
  constructor(private readonly plugin: OverlayAnnotationsPlugin) {
    super(plugin.app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Axl Light Fog" });

    new Setting(containerEl)
      .setName("默认高亮颜色")
      .addDropdown((dropdown) => {
        for (const color of ANNOTATION_COLORS) {
          dropdown.addOption(color, COLOR_LABELS[color]);
        }
        dropdown.setValue(this.plugin.settings.defaultHighlightColor).onChange(async (value) => {
          this.plugin.settings.defaultHighlightColor = value as AnnotationColor;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("便签宽度")
      .addSlider((slider) => {
        slider
          .setLimits(220, 420, 10)
          .setValue(this.plugin.settings.stickyWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.stickyWidth = value;
            await this.plugin.saveSettings();
            this.plugin.refreshAnnotations();
          });
      });

    new Setting(containerEl)
      .setName("便签位置")
      .setDesc("默认显示在右侧；也可以选择左侧。")
      .addDropdown((dropdown) => {
        dropdown.addOption("right", "右侧");
        dropdown.addOption("left", "左侧");
        dropdown.setValue(this.plugin.settings.stickySide).onChange(async (value) => {
          this.plugin.settings.stickySide = value as SidebarSide;
          await this.plugin.saveSettings();
          this.plugin.refreshAnnotations();
        });
      });

    new Setting(containerEl)
      .setName("收起便签栏的宽度阈值")
      .setDesc("编辑区域宽度小于此值时，便签将以弹窗显示。")
      .addSlider((slider) => {
        slider
          .setLimits(640, 1200, 20)
          .setValue(this.plugin.settings.stickyCollapseWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.stickyCollapseWidth = value;
            await this.plugin.saveSettings();
            this.plugin.refreshAnnotations();
          });
      });

    new Setting(containerEl)
      .setName("显示连接线")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showLeaderLines).onChange(async (value) => {
          this.plugin.settings.showLeaderLines = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAnnotations();
        });
      });

    new Setting(containerEl)
      .setName("默认作者")
      .addText((text) => {
        text.setValue(this.plugin.settings.defaultAuthor).onChange(async (value) => {
          this.plugin.settings.defaultAuthor = value.trim() || "阅读者";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("数据备份频率")
      .setDesc("预留备份功能的间隔（分钟）；注释数据仍会立即保存。")
      .addSlider((slider) => {
        slider
          .setLimits(5, 240, 5)
          .setValue(this.plugin.settings.backupFrequencyMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.backupFrequencyMinutes = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("重命名时迁移注释")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.migrateOnRename).onChange(async (value) => {
          this.plugin.settings.migrateOnRename = value;
          await this.plugin.saveSettings();
        });
      });
  }
}
