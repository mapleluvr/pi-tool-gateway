# Pi Tool Gateway

MXC-backed sandboxing and session-scoped filesystem access control for Pi's shell and file tools on Windows.

Pi 的 Windows 工具执行网关。宿主运行 Pi、认证、会话与可信扩展；网关为 Shell、文件和后台任务选择原生执行或 Microsoft Execution Container（MXC）隔离执行，并管理会话级目录访问权限。

## 执行模式

| 模式 | Shell 与文件操作 | 权限来源 |
| --- | --- | --- |
| Native | Shell 在宿主执行，文件操作使用 Pi 内置工具 | Pi 宿主进程的权限 |
| MXC | PowerShell 7 命令及文件 worker 分别由宿主启动顶层 MXC 执行 | 当前工作区、可信运行资源、固定 profile 和会话目录共同形成的策略 |

MXC 生效条件为 Windows、当前会话已启用、实际 Shell 为 PowerShell 7，以及当前配置、运行资源和能力自检通过。文件与命令共享有效模式；Git Bash 与 Windows PowerShell 5.1 使用 Native。

**MXC 不可用时，网关提示原因并自动回退普通 PowerShell；此时文件与命令恢复宿主权限，RO/deny 策略不再提供隔离。** 请求启用与实际隔离生效是两个状态，以 `/mxc status` 和 TUI 当前状态为准。

### 工具与执行位置

| 入口 | 行为 |
| --- | --- |
| `bash`、`bg_run` | 跟随当前模式的命令执行；后台任务保留启动时的 Shell、模式与策略 |
| `read`、`write`、`edit` | Native 使用 Pi 内置执行体；MXC 在容器 Node worker 中执行完整 Pi 文件工具定义，包括路径解析与文件 mutation queue |
| 用户 `!` / `!!`、已启用的 `powershell` 工具 | 跟随网关当前有效模式 |
| Pi 本体、其它扩展、MCP、LSP、浏览器/桌面自动化、子代理 | 按各自的执行位置与权限运行；其宿主代码仍处于可信域 |

每次调用取得启动时的执行 lease。模式或目录策略切换作用于新调用，已有调用和后台任务继续持有旧 lease。RW 操作直接修改宿主文件，数据恢复由项目自身的版本控制与备份承担。

## 运行与安装

- 运行宿主为 Windows、Node.js 24+ 与 Pi coding agent。
- MXC 模式使用 PowerShell 7 和可用的 Windows MXC ProcessContainer 环境。`@microsoft/mxc-sdk` 1.0.1 是锁定的可选资源依赖，提供 `wxc-exec.exe`；实际可用性由完整自检确定。
- Pi 与 TypeBox 由宿主提供，包保留 peer dependencies；Native 模式不装载 MXC native DLL。
- 开发基线为锁定的 Pi 1.4.0；slash 回执已通过 Pi 1.4/1.5 的真实 loader 与 TUI 组件验证。最近一次宿主 Windows watchdog 崩溃仍未归因，本轮未重跑真实 MXC；验证层次与限制见[最新验证记录](docs/validation/slash-feedback.md)。

从 GitHub 安装：

```powershell
pi install git:github.com/mapleluvr/pi-tool-gateway
```

每个同名扩展工具只装载一个提供者。安装配置中已有 `pi-bash-bg` 时，先移除其活动声明，或将其 package 的 `extensions` 设置为 `[]`，保留包与源码均可。

插件、Node、Pi、PowerShell 与只读参考资源的安装位置在工作区之外。启动时进入单独的项目目录：

```powershell
Set-Location D:\Work\my-project
pi --mxc
```

普通 `pi` 从 Native 开始。`--mxc` 指定启动偏好，`/mxc on` 和 `/mxc off` 修改当前会话偏好。

## Shell、命令与后台任务

原生 Shell 的 `auto` 选择顺序为 PowerShell 7 → Git Bash → Windows PowerShell 5.1。自定义路径接受通过 executable 与版本探测的 Bash/PowerShell。命令按所选 Shell 的语法书写，执行器通过明确的 executable、`shell: false` 启动；CMD 不属于后端集合。

```text
/bash-select
/bash-select auto
/bash-select pwsh7
/bash-select gitbash
/bash-select powershell51
/bash-select C:\absolute\path\to\pwsh.exe
```

选择即时更新当前工具元数据并保存 Shell 偏好。菜单标明各 Shell 的 MXC 资格；保存后若执行模式刷新失败，回执分别报告已保存和未完成的部分。

| 工具 | 参数与行为 |
| --- | --- |
| `bash` | `{ command, timeout?, background? }`；默认等待约 5 秒，超过预算返回 `taskId` 并继续后台执行；`timeout` 单位为秒，`background: true` 立即后台化 |
| `bg_run` | `{ command, name? }`；立即创建后台任务 |
| `bg_status` | `{ taskId? }`；查看一个任务或当前注册表中的任务 |
| `bg_logs` | `{ taskId, maxBytes? }`；默认读取末尾 20 KB 输出 |
| `bg_kill` | `{ taskId }`；请求停止所属进程树 |
| `bg_join` | `{ taskId, timeoutSeconds }`；等待预算为 1–3600 秒，预算耗尽后任务继续运行 |

前台调用的取消信号用于终止其所属任务；后台任务可通过 `/mxc tasks` 选择，或 `/mxc stop <完整 taskId>`、`bg_kill` 请求停止。slash 停止入口只接受本插件登记的完整 ID，不接受宿主 PID 或缩写。退出确认来自执行器收尾；仅有 `killed` 记录或取消/清理失败时仍报告退出未确认。`bg_wait` 属于子代理调度，不是此 Shell 任务注册表的等待入口。

## MXC 交互、状态与恢复

```text
/mxc
/mxc help
/mxc status
/mxc on
/mxc off
/mxc retry
/mxc tasks
/mxc stop <完整 taskId>
```

- 无参数 `/mxc` 打开菜单；`help` 和参数补全提供可执行入口。菜单本身不启动环境检查。
- 完整参数直接执行；缺少权限、目录或任务参数时，通过选择、输入和确认补齐。非交互环境需要完整参数。
- `status` 显示请求偏好、有效模式、Shell 和工具覆盖；检查中的状态与 ready/fallback 分别呈现。
- `on` / `off` 设置本会话偏好。会话重建和 reload 重新装载扩展；启动参数提供该次装载的初始偏好。
- `retry` 在 MXC 已请求开启时建立新的检测代次，重新验证运行资源、布局与执行能力；关闭时不会隐式开启。
- 普通文件或网络权限拒绝返回该调用的错误，当前模式保持 MXC。
- 后端不可用时，提示回退及宿主权限。已经执行或执行结果不确定的调用返回失败与可能的副作用信息，该调用不在宿主自动重放。

并发调用共享当前可用性检查；配置代次限定检查结果适用范围。旧检查结果或旧会话的对话选择不覆盖新的配置。

TUI 底栏显示即时模式，临时 widget 显示操作阶段与已等待时间；结束后逐条保留回执。日常回执只报告结果和必要变化，状态与资源详情由用户主动查询。回执不进入模型上下文，也不触发模型轮次；历史回执不恢复权限。RPC 使用通知和基础对话协议。

Escape 可取消尚未提交的选择、输入或确认；关闭界面不等于取消已启动的共享环境检查。

## 文件系统与运行材料

有效 MXC 策略的权限由以下部分组成：

| 资源 | 权限与用途 |
| --- | --- |
| 当前工作区 | RW，承载项目操作 |
| 会话额外目录 | 用户指定的 RO 或 RW |
| 固定 profile 的参考目录与拒绝路径 | RO 或 deny |
| Node、Pi、插件、Shell 等可信运行资源 | RO，支撑执行体 |
| 每作业私有运行材料 | RW，保存本次请求、策略和独立 HOME/TEMP，正常收尾后回收 |

环境变量来自显式白名单，HOME/TEMP 为本次作业私有值。MXC 策略默认拒绝网络出入站及 host-loopback，剪贴板、桌面输入注入和系统设置访问受到限制。需要联网安装依赖等操作时，用户应先决定是否切换到 Native；该切换采用宿主权限。

每个 RW 根与可信运行资源、RO/deny 资源及私有控制存储保持分离。策略准备解析 canonical 路径和符号链接，并检查保护文件与各卷 RW 文件的文件 ID；保护对象已通过硬链接出现在 RW 域时，自检报告 unavailable，而不是删去保护条目。

成功的文件布局审计按 runtime 缓存。宿主或其它可信权限域修改布局后，通过 `/mxc retry` 重新检测；宿主仍拥有自己的权限。普通 RW 域内部硬链接可以存在。

### 固定 profile

`--mxc-policy` 读取一个可信、绝对路径的网关 profile。profile 采用以下格式，而不是 MXC 原始策略格式：

```json
{
  "version": 1,
  "filesystem": {
    "readonlyPaths": ["D:\\Reference\\library"],
    "deniedPaths": ["D:\\Reference\\library\\private.txt"]
  }
}
```

```powershell
pi --mxc --mxc-policy D:\Policies\my-project.json
```

profile 位于全部 RW 根之外且保持单一文件链接。配置修订依据文件内容检测；保护路径与 RW 根的包含关系、别名或文件身份冲突会使当前配置不可用。

### 会话目录授权

```text
/mxc paths
/mxc paths --details
/mxc allow
/mxc revoke
/mxc allow ro "D:\Reference\shared-library"
/mxc allow rw "D:\Shared\my-project"
/mxc revoke "D:\Shared\my-project"
```

- `paths` 列出工作区、固定 profile 和会话目录的权限与来源；`paths --details` 展开可信运行资源和每作业私有材料。Native/fallback 下明确标注目录配置尚未生效。
- `allow` 接受已存在的本地 Windows 绝对目录，以 canonical 路径去重；同一目录可调整 RO/RW。会话目录彼此及与 cwd 分离。
- 目录命令使用当前选定的 PowerShell 7 验证完整候选策略。成功且配置代次仍有效时，新的文件与命令调用一起采用它；失败、超时或过期候选保留原配置。
- MXC 关闭时，目录命令可以验证和登记候选，开关偏好保持关闭。
- `revoke` 撤销会话条目并登记本会话 deny；重新 `allow` 可替换它。其它 RW 根若保留指向撤销对象的硬链接，候选会被拒绝并保留原策略。
- 目录授权存于当前扩展 runtime 内存，会话替换、reload 或退出后结束。插件不创建或删除用户目录，撤销不回收已复制的数据。
- 运行中的调用和后台任务保留旧 lease。确有运行中的旧权限任务时，回执列出对应 ID 与停止命令；`/mxc tasks` 可查询启动身份、退出确认和执行器错误。

跨调用共享数据使用专用会话 RW 目录；每作业 TEMP 的生命周期仅覆盖本次执行。

## 持久状态与日志

| 项目 | 位置或配置 |
| --- | --- |
| Shell 偏好 | `<PI_CODING_AGENT_DIR>/pi-tool-gateway.json`，默认 agent 目录为 `~/.pi/agent` |
| 状态读取 | 优先网关状态文件，缺失时兼容读取同目录 `pi-bash-bg.json`；保存只写网关文件 |
| 默认前台等待预算 | `PI_TOOL_GATEWAY_THRESHOLD_MS`，缺失时兼容 `PI_BASH_BG_THRESHOLD_MS`；默认 5000 ms |
| 命令输出日志 | 系统临时目录下的 `pi-tool-gateway/<id>.log` |
| MXC 私有材料 | 系统临时目录下的 `pi-tool-gateway/mxc/job-*` |

原生命令保留宿主环境及 Pi 的 bin/session 元数据。输出日志保存实际命令输出，应按其内容管理保密性。私有材料清理采用有界重试；失败时报告残留与已有执行效果。

## 开发与验证

```powershell
git clone https://github.com/mapleluvr/pi-tool-gateway.git
Set-Location pi-tool-gateway
npm ci --ignore-scripts
npm run typecheck
npm test
```

隔离测试使用真实 Windows MXC、PowerShell、独立夹具和宿主侧文件/PID 对照；控制流替身只用于控制流判断。完整测试需要可运行的 MXC 环境，不能以平台跳过代替隔离验收。测试中的 Pi loader/CLI 从锁定的开发 peer 定位，而非依赖作者的安装路径。

[最新验证范围与结果](docs/validation/slash-feedback.md) · [初始发布验证](docs/validation/publication.md) · [维护入口](docs/OVERVIEW.md) · [来源与许可证](NOTICE)
