# scripts/

维护入口统一从插件清单读取 ID 和版本。

- lib.mjs 提供 CLI 定向、路径核对、校验值、私有备份和旁注快照。
- package.mjs 构建可重复的 ZIP 和 SHA256SUMS。
- check-public.mjs 检查公开文件，拒绝笔记、设置、凭据和个人绝对路径。
- test-vault.mjs 准备独立验收库，避免在日常笔记库运行测试。
- install.mjs、local-install.mjs、rollback.mjs 负责显式指定笔记库的安装、身份迁移和回退。安装日常笔记库前必须使用已验收产物并保留备份，不能覆盖旁注。
- release.mjs 要求稳定 main 的 CI、同提交实机验收与一致的产物，禁止覆盖不同内容的同名版本。

改动脚本后更新相关测试和维护说明。真实功能测试使用专用测试库，正式安装通过明确路径和备份独立执行。

merge.mjs 在必要检查通过后锁定 PR 提交，使用 GitHub 匿名邮箱合并自己的维护 PR；匿名邮箱被拒绝时停止，防止服务端合并采用账号默认邮箱。
