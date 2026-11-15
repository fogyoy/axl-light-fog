# Axl Light Fog
> L2 | 独立维护仓库

成员清单
.github/AGENTS.md: GitHub Actions CI 与缺陷/功能建议模板地图。
.gitignore: 忽略依赖、构建产物、本地配置与 vault 私有数据。
LICENSE: MIT 许可证，保留原项目授权。
docs/AGENTS.md: README 与维护说明使用的文档资产地图。
package.json: 插件工程依赖与脚本命令入口。
manifest.json: 插件标识、版本、最低 Obsidian 版本与桌面端声明。
versions.json: 插件版本到最低 Obsidian 版本的映射。
tsconfig.json: TypeScript 编译约束与构建目标。
esbuild.config.mjs: 将 main.ts 打包为 Obsidian 插件产物。
styles.css: 插件注释面板与阅读视图样式。
main.ts: 插件入口，装配 Markdown/PDF 注释、存储、视图与设置。
README.md: 中文项目介绍、功能边界、发行安装、升级和反馈说明。
scripts/AGENTS.md: 验证、发行、本地安装与回滚工具地图。
src/AGENTS.md: 核心模块地图。

法则: overlay 优先·原文不动·旁注独立存储·视图解耦

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
