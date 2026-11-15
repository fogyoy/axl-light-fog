# .github/
> L2 | 父级: ../AGENTS.md

成员清单
workflows/ci.yml: PR 与 main push 的只读权限 CI，运行 npm ci 和 npm run verify。
ISSUE_TEMPLATE/bug_report.yml: 中文缺陷模板，要求公开合成复现信息。
ISSUE_TEMPLATE/feature_request.yml: 中文功能建议模板，要求公开合成示例。
ISSUE_TEMPLATE/config.yml: 禁用空白 issue，使用结构化模板收集反馈。

法则: 仅托管 runner 验证·固定 action 到版本提交 SHA·不给 CI 本机凭据

[PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
