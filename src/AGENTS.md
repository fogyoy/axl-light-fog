# src/
> L2 | 父级: ../AGENTS.md

成员清单
anchor/textAnchor.ts: 文本锚点生成、规范化、定位映射与文档变更映射。
editor/highlightExtension.ts: CodeMirror 6 高亮装饰层，不修改 Markdown 原文。
editor/readingViewHighlight.ts: Reading View 渲染文本与源文档之间的定位及高亮刷新。
editor/sourceProjection.ts: Markdown 源码到渲染文本的映射与选区范围计算。
editor/selectionToolbar.ts: 选区浮动工具栏，提供高亮、旁注与总览入口。
pdf/pdfAnnotationLayer.ts: PDF 选区捕获、矩形锚点和高亮投影。
storage/types.ts: 旁注数据、设置、锚点、高亮与索引类型。
storage/annotationStore.ts: 旁注 JSON 持久化、校验、索引和路径迁移。
storage/validation.ts: 持久化数据结构校验。
storage/visibleMarks.ts: 计算可见 Markdown 标注。
views/annotationPopover.ts: 点击标注后显示内容的弹层。
views/commentModal.ts: 旁注输入弹窗。
views/sidebarView.ts: 右侧总览侧栏，呈现标注并提供搜索、筛选、跳转与编辑。
views/stickyNoteView.ts: 旁注卡片视图。
settings/settingsTab.ts: 插件配置界面。
utils/positioning.ts: 便签避让布局纯函数。

法则: 类型单一真相·业务不依赖存储细节·渲染只做投影·界面只做交互

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
