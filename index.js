/**
 * agent-forward：把 DSH 的 Agent.followup() 包成两个模型工具 + 一个授权命令。
 *
 *   agent_list                   — 列出可转发的活会话（同工作区默认列，跨工作区只列已授权）
 *   agent_send                   — 投递给指定会话，等它这一轮答完，把回答取回来
 *   /agent-forward allow|revoke|list — 跨工作区授权的“勾选框”
 *
 * 访问策略（服务端校验，不靠模型自觉）：
 *   L0 同工作区（cwd 规范化后相等）→ 默认允许
 *   L1 跨工作区 → 必须在 <工作区>/.dsh/agent-forward.json 的 allowCross 里逐个授权
 *   L2 workspaceInterop:false → 整个插件关闭转发能力
 *
 * 三条硬约束：来源可见（reason 必填）、只读回传（只有一个 followup 调用点）、有界（2000 字 / 每分钟 5 次）。
 *
 * 本文件不 import 任何 @deepseek-ai/* 包：profile 里安装的插件解析不到宿主内部
 * 模块，所以工具定义与 UserMessage 都按运行时的形状直接构造。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  DEFAULT_CONFIG,
  SlidingWindow,
  captureTurn,
  readConfig,
  sameWorkspace,
  sessionCwd,
  sessionTitle,
} from './core.js'

export const name = 'agent-forward'
export const inject = ['tools', 'agents', 'commands']

const CONFIG_RELATIVE = join('.dsh', 'agent-forward.json')
const limiter = new SlidingWindow(DEFAULT_CONFIG.maxPerMinute)

const safeRealpath = (target) => {
  try {
    return realpathSync.native(target)
  } catch {
    return target
  }
}

function configPathFor(cwd) {
  return join(cwd, CONFIG_RELATIVE)
}

/** 读调用方工作区的配置；没有 cwd 的会话直接按「不可用」处理。 */
function loadConfigFor(cwd) {
  if (!cwd) {
    return { config: null, error: new Error('会话没有工作目录（cwd）'), missing: false, path: null }
  }
  const file = configPathFor(cwd)
  return { ...readConfig(file, (path) => readFileSync(path, 'utf8')), path: file }
}

/** 读原始 JSON（保留用户手写的其它字段）；文件不存在算空对象。 */
function readRawConfig(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    throw error
  }
}

function writeRawConfig(file, raw) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
}

function rejected(text, code) {
  return { status: 'rejected', title: '', turn: 0, text, elapsedMs: 0, code }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

/** 与宿主 createUserMessage 同形：带 id、role、source 的不可变值。 */
function createUserMessage(input) {
  return deepFreeze({ ...structuredClone(input), id: `msg-${randomUUID()}`, role: 'user' })
}

/** 从原始入参里取三个字符串；session_id 与 text 缺一个就返回 null。 */
function readSendArgs(args) {
  if (!args || typeof args !== 'object') return null
  const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : ''
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
  if (sessionId === '' || text === '') return null
  return { sessionId, text, reason }
}

/** workspace / external —— 只做相等比较，绝不做前缀匹配。 */
function scopeOf(callerCwd, targetCwd) {
  return sameWorkspace(callerCwd, targetCwd, { realpath: safeRealpath }) ? 'workspace' : 'external'
}

function grantOf(config, sessionId) {
  return config.allowCross.find((entry) => entry.sessionId === sessionId)
}

function commandUsage() {
  return '用法：/agent-forward allow <sessionId> | revoke <sessionId> | list'
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'agent_list',
    description:
      '列出可以转发的智能体会话。默认返回同工作区的会话（无需授权即可转发）；' +
      '已授权的跨工作区会话也会列出，标注为 external。转发前先用它拿到 id。',
    parameters: {
      type: 'object',
      properties: {
        include_external: {
          type: 'boolean',
          description: '是否列出已授权的外部会话，默认 true；未授权的永远不出现',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          agents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', description: 'idle | running' },
                scope: { type: 'string', description: 'workspace | external' },
              },
              required: ['id', 'title', 'status', 'scope'],
              additionalProperties: false,
            },
          },
          note: { type: 'string' },
        },
        required: ['agents'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = (value.agents || []).map(
          (agent) =>
            `- ${agent.title}（${agent.id}，${agent.status}${agent.scope === 'external' ? '，跨工作区' : ''}）`,
        )
        if (value.note) lines.push('', value.note)
        return [
          {
            type: 'text',
            text: lines.length > 0 ? lines.join('\n') : '（没有可转发的会话）',
          },
        ]
      },
    },
    async execute(args, exec) {
      const caller = exec && exec.agent
      const cwd = sessionCwd(caller && caller.session)
      if (!cwd) {
        return { agents: [], note: '当前会话没有工作目录（cwd），无法判定工作区，按无可转发会话处理。' }
      }

      const loaded = loadConfigFor(cwd)
      if (!loaded.config) {
        return {
          agents: [],
          note: `配置文件 ${loaded.path} 解析失败（${loaded.error && loaded.error.message}），按拒绝处理。`,
        }
      }
      const config = loaded.config
      if (!config.workspaceInterop) {
        return {
          agents: [],
          note: `本工作区已关闭跨会话转发（${loaded.path} 里 workspaceInterop=false）。`,
        }
      }

      const includeExternal = !args || args.include_external !== false
      const agents = []
      let hiddenExternal = 0

      for (const agent of ctx.agents.roots()) {
        if (caller && agent.id === caller.id) continue
        const targetCwd = sessionCwd(agent.session)
        const scope = scopeOf(cwd, targetCwd)
        if (scope === 'external') {
          if (!grantOf(config, agent.id)) continue
          if (!includeExternal) {
            hiddenExternal += 1
            continue
          }
        }
        agents.push({
          id: agent.id,
          title: sessionTitle(agent.session),
          status: agent.status,
          scope,
        })
      }

      const notes = []
      if (loaded.missing) {
        notes.push(`尚未创建 ${loaded.path}：同工作区默认可转发，跨工作区需用 /agent-forward allow 授权。`)
      }
      if (hiddenExternal > 0) {
        notes.push(`另有 ${hiddenExternal} 个已授权跨工作区会话按 include_external=false 隐藏。`)
      }

      return notes.length > 0 ? { agents, note: notes.join('\n') } : { agents }
    },
  })

  ctx.tools.register({
    name: 'agent_send',
    description:
      '把一条消息转发给另一个智能体会话，并等它这一轮回答完，把回答取回来。' +
      '同工作区的会话默认可转发；跨工作区的会话必须先由用户显式授权，否则会被拒绝。' +
      '跨会话操作：只有用户明确要求时才使用。',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '目标会话 id，来自 agent_list' },
        text: { type: 'string', description: '要转发的内容（会作为该会话的一条新输入）' },
        reason: { type: 'string', description: '为什么转发，会写进目标会话，便于追溯' },
      },
      required: ['session_id', 'text', 'reason'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'replied | timeout | rejected' },
          title: { type: 'string' },
          turn: { type: 'number', description: '命中的轮次，timeout 时为 0' },
          text: { type: 'string', description: '对方这一轮的回复，或拒绝原因' },
          elapsedMs: { type: 'number' },
          scope: { type: 'string', description: 'workspace | external' },
          code: { type: 'string', description: 'rejected/timeout 的机器可读原因' },
        },
        required: ['status', 'title', 'turn', 'text', 'elapsedMs'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const where = value.scope === 'external' ? '（跨工作区）' : ''
        if (value.status === 'replied') {
          const header = `${value.title}${where}（${(value.elapsedMs / 1000).toFixed(1)}s）`
          const body = value.text
            ? value.text
            : '这一轮没有产生文本回复（可能被拒绝、被取消，或只调用了工具）。'
          return [{ type: 'text', text: `${header}：\n${body}` }]
        }
        if (value.status === 'timeout') {
          return [{ type: 'text', text: `${value.title || '目标会话'}：${value.text}` }]
        }
        return [{ type: 'text', text: `已拒绝：${value.text}` }]
      },
    },
    async execute(args, exec) {
      const parsed = readSendArgs(args)
      if (!parsed) return rejected('参数不合法：session_id / text / reason 都必须是非空字符串', 'BAD_ARGS')

      const caller = exec && exec.agent
      if (!caller) return rejected('没有调用方 agent 上下文，拒绝转发', 'NO_CALLER')

      const cwd = sessionCwd(caller.session)
      if (!cwd) return rejected('当前会话没有工作目录（cwd），无法判定工作区', 'NO_WORKSPACE')

      const loaded = loadConfigFor(cwd)
      if (!loaded.config) {
        return rejected(
          `配置文件 ${loaded.path} 解析失败：${loaded.error && loaded.error.message}（按拒绝处理）`,
          'CONFIG_INVALID',
        )
      }
      const config = loaded.config
      const { sessionId: targetId, text, reason } = parsed

      if (!config.workspaceInterop) {
        return rejected(
          `本工作区已关闭跨会话转发（${loaded.path} 里 workspaceInterop=false）`,
          'WORKSPACE_INTEROP_OFF',
        )
      }
      if (targetId === caller.id) {
        return rejected('不能把消息转发给自己', 'SELF')
      }
      if (reason === '') {
        return rejected('必须填写 reason：每条转发都要留痕', 'NO_REASON')
      }
      if (text.length > config.maxChars) {
        return rejected(`转发内容 ${text.length} 字，超过上限 ${config.maxChars} 字`, 'TOO_LONG')
      }

      const target = ctx.agents.get(targetId)
      if (!target) {
        return rejected(
          `目标会话 ${targetId} 当前不是活着的 agent（只能转发给打开的会话）`,
          'NOT_LIVE',
        )
      }

      const scope = scopeOf(cwd, sessionCwd(target.session))
      if (scope === 'external' && !grantOf(config, targetId)) {
        return rejected(
          `目标 ${targetId} 在另一个工作区，且没有授权；先执行 /agent-forward allow ${targetId}`,
          'NOT_ALLOWED',
        )
      }

      if (!limiter.take(`${caller.id}>${targetId}`, config.maxPerMinute)) {
        return rejected(
          `同一对会话每分钟最多转发 ${config.maxPerMinute} 次，请稍后再试`,
          'RATE_LIMITED',
        )
      }

      const title = sessionTitle(target.session)
      const fromTitle = sessionTitle(caller.session)
      const body = `[来自「${fromTitle}」的转发 · 原因：${reason}]\n\n${text}`

      // 来源用内置的 agent-message（form: relay）：目标会话的界面会显示成
      // “另一个会话发来的消息”，而不是用户自己说的话；正文首行给模型看来源与原因。
      const message = createUserMessage({
        content: [{ type: 'text', text: body }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: caller.id },
      })

      const result = await captureTurn({
        bus: ctx,
        session: target.session,
        targetId,
        messageId: message.id,
        maxWaitMs: config.maxWaitMs,
        signal: exec.signal,
        followup: () => target.followup(message),
      })

      return {
        status: result.status,
        title,
        turn: result.turn,
        text: result.text,
        elapsedMs: result.elapsedMs,
        scope,
        ...(result.code ? { code: result.code } : {}),
      }
    },
  })

  ctx.commands.register({
    name: 'agent-forward',
    description: '跨会话转发的授权管理：allow <sessionId> / revoke <sessionId> / list',
    input: { hint: 'allow <sessionId> | revoke <sessionId> | list' },
    async handler(invocation) {
      const agent = invocation.agent
      const cwd = sessionCwd(agent && agent.session)
      if (!cwd) return { kind: 'error', text: '当前会话没有工作目录（cwd），无法定位配置文件。' }
      const file = configPathFor(cwd)

      const parts = String(invocation.rawInput || '').trim().split(/\s+/).filter(Boolean)
      const sub = (parts[0] || 'list').toLowerCase()
      const arg = parts[1]

      let raw
      try {
        raw = readRawConfig(file)
      } catch (error) {
        return { kind: 'error', text: `配置文件 ${file} 解析失败：${error.message}` }
      }

      if (sub === 'list') {
        const config = loadConfigFor(cwd).config
        if (!config) return { kind: 'error', text: `配置文件 ${file} 解析失败。` }
        const lines = [
          `工作区：${cwd}`,
          `跨工作区总闸：${config.workspaceInterop ? '开' : '关（workspaceInterop=false）'}`,
          `配置文件：${file}`,
          `已授权跨工作区会话：${config.allowCross.length === 0 ? '（无）' : ''}`,
        ]
        for (const grant of config.allowCross) {
          const live = ctx.agents.get(grant.sessionId)
          const when = grant.grantedAt ? new Date(grant.grantedAt).toLocaleString() : '未知时间'
          lines.push(
            `- ${grant.title || grant.sessionId}（${grant.sessionId}，${when}${live ? '，在线' : '，已关闭'}）`,
          )
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      if (sub === 'allow') {
        if (!arg) return { kind: 'error', text: commandUsage() }
        const target = ctx.agents.get(arg)
        if (!target) {
          return {
            kind: 'error',
            text: `找不到活着的会话 ${arg}。本版只支持打开的会话，请先在界面上打开它。`,
          }
        }
        if (scopeOf(cwd, sessionCwd(target.session)) === 'workspace') {
          return { kind: 'success', text: `「${sessionTitle(target.session)}」与当前会话同工作区，默认就允许，无需授权。` }
        }
        const title = sessionTitle(target.session)
        const list = Array.isArray(raw.allowCross) ? raw.allowCross.filter((entry) => entry && typeof entry === 'object') : []
        const existing = list.find((entry) => entry.sessionId === arg)
        if (existing) {
          existing.title = title
        } else {
          list.push({ sessionId: arg, title, grantedAt: Date.now() })
        }
        raw.allowCross = list
        try {
          writeRawConfig(file, raw)
        } catch (error) {
          return { kind: 'error', text: `写入 ${file} 失败：${error.message}` }
        }
        return {
          kind: 'success',
          text: `已授权跨工作区转发：${title}（${arg}）\n配置文件：${file}\n撤销：/agent-forward revoke ${arg}`,
        }
      }

      if (sub === 'revoke') {
        if (!arg) return { kind: 'error', text: commandUsage() }
        const list = Array.isArray(raw.allowCross) ? raw.allowCross.filter((entry) => entry && typeof entry === 'object') : []
        const next = list.filter((entry) => entry.sessionId !== arg)
        if (next.length === list.length) {
          return { kind: 'error', text: `${file} 里没有 ${arg} 的授权记录。` }
        }
        raw.allowCross = next
        try {
          writeRawConfig(file, raw)
        } catch (error) {
          return { kind: 'error', text: `写入 ${file} 失败：${error.message}` }
        }
        return { kind: 'success', text: `已撤销 ${arg} 的跨工作区授权。` }
      }

      return { kind: 'error', text: commandUsage() }
    },
  })
}
