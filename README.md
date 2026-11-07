# dsh-agent-forward

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

一个 DSH（DeepSeek Harness）插件：把一条消息转发给**另一个活着的会话**，等它这一轮答完，把回答取回来。

> A DSH plugin that forwards a message to another **live** session and returns that turn's reply.
> Same workspace is trusted by default; cross-workspace access requires explicit per-session grants.

## 为什么需要它

DSH 里每个标签页是一个独立会话。想「让隔壁那个正在跑任务的会话顺便查一下」时，
手动复制粘贴既丢失上下文，又拿不到这一轮的完整结果。本插件给模型两个工具，
让会话之间能真正对话，同时把访问控制做在服务端（不依赖模型自觉）。

## 能力

| 能力 | 形态 |
| --- | --- |
| 列出可转发的会话 | 工具 `agent_list` |
| 投递并取回这一轮的回复 | 工具 `agent_send` |
| 跨工作区授权 / 撤销 / 查看 | 命令 `/agent-forward allow <id>`、`revoke <id>`、`list` |

## 访问分级

| 层级 | 范围 | 默认 | 如何授权 |
| --- | --- | --- | --- |
| L0 | 同工作区（`cwd` 规范化后相等） | ✅ 允许 | 无需配置 |
| L1 | 工作区外 | ❌ 拒绝 | `/agent-forward allow <sessionId>` |
| L2 | 总闸 | — | 配置里 `workspaceInterop: false` 关闭全部转发 |

「同工作区」的判定：绝对路径 + 尽量展开符号链接 + 去尾斜杠；Windows 大小写不敏感；
**只做相等比较，不做前缀匹配**——`C:\repo` 与 `C:\repo-2` 是两个工作区。

## 安装

### 方式一：插件管理器

DSH → 插件管理器 → 添加插件 → 填入本目录的绝对路径（或仓库地址）。

### 方式二：`plugin_manager` 工具

```
install_bundle  target: <本目录绝对路径 或 包名>
```

### 从源码安装

```bash
git clone https://github.com/Zjsaaaa/dsh-agent-forward.git
```

然后在插件管理器里把上面克隆出来的目录加进去。本插件无运行时依赖，不需要 `npm install`。

**卸载**：插件管理器里移除 `dsh-agent-forward`，两个工具和命令一起消失。

## 配置

每个工作区一份：`<工作区>/.dsh/agent-forward.json`

```json
{
  "workspaceInterop": true,
  "allowCross": [
    { "sessionId": "session-xxxx", "title": "隔壁项目", "grantedAt": 1794050000000 }
  ],
  "maxWaitMs": 120000,
  "maxChars": 2000,
  "maxPerMinute": 5
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `workspaceInterop` | `true` | L2 总闸；设 `false` 后本工作区任何转发都拒绝 |
| `allowCross` | `[]` | 已授权的跨工作区会话，由 `/agent-forward allow` 写入 |
| `maxWaitMs` | `120000` | 等一轮结束的上限；超时返回 `timeout`，消息仍在对方队列里 |
| `maxChars` | `2000` | 单次转发正文上限，超了返回 `rejected` |
| `maxPerMinute` | `5` | 同一对 `(from, to)` 每分钟最多几次 |

配置每次调用都重新读，改完不用重启；`/agent-forward` 写入时会保留你手写的其它字段。

## 三条硬约束

1. **来源可见**：每条转发都带 `agent-message`（`form: 'relay'`）来源，正文首行是
   `[来自「X」的转发 · 原因：…]`；`reason` 必填。
2. **只读回传**：回复只返回给调用方，代码里只有一个 `followup` 调用点，不做二次转发。
3. **有界**：单次 ≤ `maxChars`；同一对会话每分钟 ≤ `maxPerMinute`；未授权的外部会话
   在 `agent_list` 里根本不出现（避免模型反复尝试）。

## 实现要点：为什么不能等 `whenIdle()`

`whenIdle()` 观察的是**整个 agent 的活动**，不认领具体某条消息。目标本来在跑自己的任务时，
`followup` 只是排队；等 `whenIdle()` 返回，抓到的可能是它自己那一轮，甚至两轮混在一起。

所以本插件走：`agent/inbox/claimed` 拿到我们这条消息被认领的 **turn** → 等同一个 turn 的 `turn/end`
→ 只取 `seq ∈ (投递前, 该轮结束]` 且 `turn` 相同的 `assistant/message`。

这段逻辑全部在 `core.js`，不 import 任何 `@deepseek-ai/*`，可以直接 `node --test` 验证。

## 开发

```bash
node test/core.test.js   # 纯逻辑单测：配置 / 工作区判定 / 拼装 / 限流 / 捕获状态机（16 项）
node test/smoke.mjs      # 无桩冒烟：同工作区放行、跨区拒绝、命令授权、撤销、总闸
npm test                 # 两者一起跑
```

## 已知边界（v0.2 不做）

- 不接 `ctx.jobs`：同步等，最长 `maxWaitMs`；后台化需要再加一个取结果的工具。
- 只支持活着的会话（打开的标签页），不支持 `resume` 冷会话。
- 不回传流式增量，只取这一轮的最终文本。

## License

[MIT](LICENSE)
