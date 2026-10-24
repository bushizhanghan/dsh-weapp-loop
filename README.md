# dsh-weapp-loop — 小程序开发闭环（DSH 插件）

> 把「改代码 → 开开发者工具 → 等编译 → 找报错 → 贴二维码」这条人肉接力链，变成 agent 的一工具调用。

微信小程序开发时，DevTools 的 CLI 是一个**已登录、已打开项目**的 IDE 的遥控器。这个插件把那条遥控线接到 DeepSeek-Harness 上：agent 能查状态、启动 IDE、触发预览、解析编译报错，二维码直接贴进对话让你手机扫；右栏还有一块面板常驻显示 IDE 状态、最近预览和错误清单。

## 安装

```sh
dsh plugin --profile desktop add @bushizhanghan/dsh-weapp-loop
```

或本地开发（link 到目录）。重启 DSH 后生效。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `weapp_status` | 检测 IDE 是否安装/在运行/已就绪，并列出开发者工具记录过的项目。**先用它** |
| `weapp_projects` | 列出开发者工具记住的所有小程序项目（读 User Data，只读不猜） |
| `weapp_open` | 启动 IDE 并打开项目，轮询等待就绪（首次需你扫码登录） |
| `weapp_preview` | 触发预览，返回 **base64 二维码数据 URL** + 编译结果 + 结构化错误 |
| `weapp_errors` | 把任意 IDE 控制台/CLI 输出解析成结构化错误（file/line/column/kind） |
| `weapp_upload` | 上传开发版本（生产动作，必须 `confirmed=true` 才执行） |

## 它解决的真实问题

改完 `pages/index/index.wxml`，以前你要：切到 DevTools → 等它自己编译 → 在一堆日志里翻报错 → 复制回对话 → 再改。

现在：

```
你：导航栏改好了，真机上看看
agent: weapp_preview(project)
       → 编译失败 → 拿到 [{file: 'pages/index/index.wxml', line: 23, kind: 'error', message: '标签闭合错误'}]
       → 直接告诉你哪一行、为什么，顺手修掉
       → 编译成功 → 二维码贴进对话 → 你手机扫
```

右栏「小程序」面板同时显示：IDE 就绪状态、最近预览的二维码、编译问题清单。

## 配置（cordis patch 的 config 字段）

| 字段 | 默认 | 说明 |
|---|---|---|
| `projectPath` | `''` | 默认项目目录。缺省时从开发者工具的 `last_all_projects` 推断（只有一个项目时自动用它） |
| `cliTimeoutMs` | `20000` | 单次 CLI 调用超时。CLI 在 IDE 未登录时会挂起，所以必须有界 |
| `openWaitMs` | `60000` | `weapp_open` 等待就绪的时长 |

环境变量：`WECHAT_DEVTOOLS_PATH` 指向安装目录（含 `cli.bat`），默认依次探测 `D:\微信web开发者工具`、`C:\Program Files (x86)\Tencent\微信web开发者工具`。

## ⚠️ 诚实的能力边界

1. **首次必须人工扫码登录**。DevTools 的登录态插不了手——`weapp_open` 会启动 IDE 并等你登录，未就绪时其他工具明确返回 `ide-not-ready`，不会假装预览成功。
2. **编译报错解析是逆向的**。DevTools 控制台没有稳定的机器格式；解析不了的行会原样进 `raw` 字段，不丢信息，但也不假装结构化。
3. **上传需显式确认**。`weapp_upload` 不带 `confirmed=true` 只会返回「将上传什么」的预览。

## 工作原理

```
感知  tasklist 探 IDE 进程 + User Data 的 last_all_projects 读项目清单
      cli.bat preview/open/upload 走官方 CLI（不碰 UI 自动化）
记忆  ~/.dsh/dsh-weapp-loop/state.json 存最近二维码/预览时间/错误清单
决策  编译错误按 file:line:col 解析；未就绪时如实上报而不是假成功
行动  二维码数据 URL 回给 agent → 贴进对话；错误清单进右栏面板
```

host 半注册 `GET /dsh-weapp-loop/config` 与 `/health` 两条路由，右栏面板每 3 秒轮询一次拿到同一份状态。

## 开发

```sh
node --test test/                     # engine 单测（11 个）
node test/integration.test.mjs        # 全链路集成测试（9 项，fake ctx + 真实引擎）
```

## License

MIT
