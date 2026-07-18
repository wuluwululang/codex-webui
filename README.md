# Codex Mobile

在电脑上运行 Codex，在手机或平板浏览器里继续同一批会话。Codex Mobile 通过本机 `codex app-server` 工作，不需要单独填写 OpenAI API Key。

启动后会打印带访问口令的局域网地址和二维码。同一 Wi-Fi 下的移动设备扫码即可访问。

## 让 Codex 帮你安装

把本仓库的 GitHub 链接交给 Codex，然后发送：

> 安装这个项目，运行测试并启动服务；最后告诉我怎样用手机扫码连接。

仓库里的 `AGENTS.md` 会告诉 Codex完成安装、验证和安全初始化所需的步骤。

## 手动安装

要求：

- Node.js 20 或更新版本
- 已安装并登录 Codex CLI，或 Windows 上已安装 Codex 桌面应用

```powershell
npm install
npm run setup
npm test
npm start
```

`npm run setup` 会安装全局 `codexm` 命令，同时把 `codex-mobile-token-manager` 安装到当前用户的 `$HOME/.agents/skills`。Codex 通常会自动检测 skill；如果没有立即出现，重启 Codex。

用户可能在任意已有项目或普通任务中把 GitHub 链接交给 Codex，因此安装任务的工作目录不等于 CodexMobile 的克隆目录。setup 会输出 CodexMobile 的绝对路径，但不会声称它已经成为 Codex 本地项目。安装完成后，在 Codex 桌面端按 `Ctrl+O` 打开该目录，即可把它加入本地项目。Codex 目前没有公开的项目注册 API，因此安装器不会修改桌面端的内部项目数据库。

手机与电脑连接同一局域网，然后扫描终端二维码。Windows 也可以运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-codex-mobile.ps1 -Foreground
```

如果 Windows 防火墙询问是否允许 Node.js 访问专用网络，请选择允许；不要把服务直接暴露到公网。

## Token 管理

Codex Mobile 首次设置时会生成一个本地访问 token。token 是本服务的 bearer 口令，不是 OpenAI API Key。

安装完成后，可以在任意目录使用简短的 `codexm` 命令：

```powershell
# 默认不显示明文，只显示短指纹和目录权限
codexm list

# 创建只能访问一个项目目录的 token
codexm add phone --label "My phone" --cwd "E:\MyProject"

# 一个 token 可允许多个目录
codexm add tablet --cwd "E:\ProjectA" --cwd "E:\ProjectB"

# 生成完整访问地址与二维码（会显示密钥）
codexm qr phone

# 轮换、停用或删除
codexm rotate phone
codexm disable phone
codexm remove phone --yes

# 查看使用情况
codexm stats
codexm stats phone
```

也可以不输入命令，在任意 Codex 对话中直接说：

> 列出我的 Codex Mobile token。
>
> 给 `E:\MyProject` 创建一个名为 `phone` 的手机 token，只允许访问这个目录，并生成二维码。
>
> 给 `tablet` token 增加 `E:\ProjectA` 和 `E:\ProjectB` 两个可访问目录。
>
> 轮换 / 停用 / 删除 `phone` token。
>
> 查看 `phone` token 的使用统计。

Codex 会调用已安装的 [`codex-mobile-token-manager`](.agents/skills/codex-mobile-token-manager/SKILL.md) skill 完成操作。只有在生成访问地址或二维码时才会显示密钥；删除和清空统计等操作会先确认。运行 `codexm help` 可查看完整命令。

运行中的服务会自动重新加载 token 变更。轮换、停用或删除后，旧连接会在下一次请求时断开。

### 统计口径

统计记录每个 Codex Mobile 访问 token 的 HTTP 请求、WebSocket 连接、RPC 请求与错误、上下行 WebSocket 字节、最近使用时间和 RPC 方法分布。它不是 OpenAI 模型 token 数或账单统计；Codex 账号的限额仍由 Codex 自身管理。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `9526` | HTTP/WebSocket 端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `CODEX_MOBILE_CWD` | 仓库目录 | 新会话默认目录 |
| `CODEX_MOBILE_DATA_DIR` | 系统用户数据目录 | token、统计、上传和运行态文件目录 |
| `CODEX_MOBILE_CODEX_PATH` | 自动发现 | `codex` 可执行文件路径 |
| `CODEX_MOBILE_TERMINAL_QR` | `1` | 设为 `0` 可关闭终端二维码 |
| `CODEX_MOBILE_SKILLS_DIR` | `$HOME/.agents/skills` | 覆盖用户 skill 安装目录，主要用于测试或自定义环境 |

为了兼容旧部署，仍支持 `CODEX_MOBILE_TOKEN`、`CODEX_MOBILE_THREAD_FILTER_CWD` 和 `CODEX_MOBILE_TOKEN_SCOPES`。新安装应使用 token CLI；环境变量 token 不会写入本地 token 仓库，也不能热重载。

默认数据目录：

- Windows：`%LOCALAPPDATA%\CodexMobile`
- Linux/macOS：`$XDG_DATA_HOME/codex-mobile`，未设置时为 `~/.local/share/codex-mobile`

二维码 SVG 保存在数据目录的 `qr/` 中。token、二维码和完整访问 URL 都应按密码处理，禁止提交到 Git。

## 安全边界

- 服务可以代表已登录的本机 Codex 账号读取会话、启动任务，并在授权范围内操作文件。
- 请优先为每台设备创建独立、限定目录的 token，设备丢失时立即停用或轮换。
- 局域网 HTTP 不提供传输加密；不要在不可信 Wi-Fi 使用，也不要做公网端口映射。公网部署需要由可信反向代理提供 HTTPS、访问控制和限流。
- token 存储位于本机数据目录，文件权限会尽力限制为当前用户，但仍应保护该操作系统账户。

## 开发

```powershell
npm run check
npm test
```

后端通过 stdio 启动 `codex app-server`，网页的 WebSocket 请求由本服务桥接为 Codex JSON-RPC。允许的方法使用白名单控制，目录受限 token 还会在服务端过滤会话并校验文件访问。

## License

[MIT](LICENSE)
