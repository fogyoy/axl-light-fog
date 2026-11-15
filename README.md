# Axl Light Fog

Axl Light Fog 是 Obsidian 的 Markdown 与 PDF 阅读标注插件。它以浮层高亮、旁注和总览帮助整理阅读内容，标注保存在 vault 内的 `.obsidian-annotations/` 旁注数据中，不修改原始 Markdown 或 PDF。

本项目是对 [Epiphany Xiao 的 little-pond/axl-light](https://github.com/little-pond/axl-light) 的公开 fork。原作者为 Epiphany Xiao，当前维护者为 fogyoy；上游 git 历史与 MIT 许可证均予以保留。本 fork 的插件 ID 为 `axl-light-fog`，显示名为 **Axl Light Fog**，首版为 **0.4.0**，最低支持 Obsidian **1.15.1**，仅支持桌面端。开发和正式实机验收以 macOS 为优先；Windows 与 Linux 尚未验证。

## 功能

- 在 Markdown 编辑视图、阅读视图和 PDF 阅读器中添加颜色高亮。
- 通过选区工具栏创建旁注，并在侧栏搜索、筛选、排序、跳转和导出标注。
- 使用文本锚点在文档编辑后恢复标注位置；PDF 标注按页码和相对矩形定位。
- 以独立 JSON 旁注保存高亮和旁注，保持源文档不变。

## 本 fork 的修复

本版本整合了中文标注场景的修复与回归覆盖，包括 Markdown 源码与渲染文本之间的定位映射、跨视图选区隔离、PDF 选区与文件切换保护、旁注数据校验和写入失败保护，以及并发写入、重命名迁移和侧栏标注操作的改进。细节以当前版本实现和测试为准。

## 安装

从 [GitHub Releases](https://github.com/fogyoy/axl-light-fog/releases) 下载对应版本的 ZIP。压缩包内应包含 `axl-light-fog/` 插件目录，目录中有 `main.js`、`manifest.json`、`styles.css` 和 `LICENSE`。解压后将整个 `axl-light-fog` 文件夹复制到 vault 的插件目录：

```text
<vault>/.obsidian/plugins/axl-light-fog/
```

在 Obsidian 中重新载入插件列表，然后到 **设置 → 第三方插件** 启用 **Axl Light Fog**。如果升级已有安装，直接覆盖插件目录中的发行文件即可；插件设置和 `.obsidian-annotations/` 旁注数据保存在 vault 中，不随插件文件升级而删除。升级前仍建议备份 vault。

## 使用

在 Markdown 或 PDF 中选择文本，使用浮动工具栏创建高亮或旁注。侧栏总览可搜索和筛选标注、跳回原文、编辑旁注，并将标注导出为 Markdown。

![Markdown 与 PDF 选区高亮示意](docs/images/highlight-with-axl-light.png)

![旁注与总览侧栏示意](docs/images/sticky-notes-overview.png)

原文保持不变；停用或移除插件不会删除 `.obsidian-annotations/` 中的数据。请勿手动删除该目录，除非你已备份或确定不再需要这些标注。

## 已知边界

- 仅桌面端；本 fork 目前以 macOS 为优先验收环境，其他操作系统尚未验证。
- 阅读视图依赖 Obsidian 渲染后的 DOM。主题或插件若大幅改写渲染结构，标注位置可能变化。
- PDF 定位依赖 Obsidian 内置 PDF 阅读器的页面结构；旋转页面或特殊版式可能影响选区定位。
- 超大标注集合会直接显示在总览中，尚无虚拟滚动。

## 问题反馈

请在本仓库的 [Issues](https://github.com/fogyoy/axl-light-fog/issues) 提交缺陷或功能建议。描述 Obsidian 版本、操作系统、复现步骤和预期结果。请不要上传个人 vault、真实阅读内容或私人旁注；使用公开、合成的示例文本，并在发布前检查截图和日志是否包含个人信息。

本项目由维护者个人维护，按个人时间处理反馈，不承诺响应或修复时限。

## 开发

本地开发与验证命令见[维护说明](docs/维护.md)。正式实机验收必须使用独立测试 vault；常规 CI 只运行自动化检查，不连接维护者的本机或个人 vault。

## 许可

本项目使用 MIT 许可证，见 [LICENSE](LICENSE)。
