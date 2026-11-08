/**
 * agent-forward 的纯逻辑。
 *
 * 这个文件刻意不 import 任何 @deepseek-ai/* 包：配置解析、工作区判定、标题提取、
 * 回复拼装、限流和「单轮捕获」状态机都在这里，可以直接用 node --test 验证。
 */

import path from 'node:path'

/** 缺省配置：同工作区默认可转发，跨工作区默认谁都不行。 */
export const DEFAULT_CONFIG = Object.freeze({
  workspaceInterop: true,
  allowCross: [],
  resumeClosed: true,
  maxWaitMs: 120000,
  maxResumeMs: 60000,
  maxChars: 2000,
  maxPerMinute: 5,
  maxPerMinuteClosed: 2,
  hopLimit: 3,
})

const positive = (value, fallback, min) =>
  Number.isFinite(value) && value >= min ? value : fallback

/** 把任意配置对象收敛成受控形状；非法值一律回落到默认值。 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}

  const grants = []
  const seen = new Set()
  if (Array.isArray(source.allowCross)) {
    for (const entry of source.allowCross) {
      if (!entry || typeof entry !== 'object') continue
      if (typeof entry.sessionId !== 'string' || entry.sessionId.trim() === '') continue
      const sessionId = entry.sessionId.trim()
      if (seen.has(sessionId)) continue
      seen.add(sessionId)
      grants.push({
        sessionId,
        title: typeof entry.title === 'string' ? entry.title : '',
        grantedAt: Number.isFinite(entry.grantedAt) ? entry.grantedAt : 0,
      })
    }
  }

  return {
    workspaceInterop: source.workspaceInterop !== false,
    allowCross: grants,
    resumeClosed: source.resumeClosed !== false,
    maxWaitMs: positive(source.maxWaitMs, DEFAULT_CONFIG.maxWaitMs, 1000),
    maxResumeMs: positive(source.maxResumeMs, DEFAULT_CONFIG.maxResumeMs, 1000),
    maxChars: positive(source.maxChars, DEFAULT_CONFIG.maxChars, 1),
    maxPerMinute: positive(source.maxPerMinute, DEFAULT_CONFIG.maxPerMinute, 1),
    maxPerMinuteClosed: positive(source.maxPerMinuteClosed, DEFAULT_CONFIG.maxPerMinuteClosed, 1),
    hopLimit: positive(source.hopLimit, DEFAULT_CONFIG.hopLimit, 1),
  }
}

/** 解析配置文件文本；语法错误必须以 error 暴露，不能悄悄当成空配置。 */
export function parseConfigText(text) {
  try {
    return { config: normalizeConfig(JSON.parse(text)), error: null }
  } catch (error) {
    return { config: null, error }
  }
}

/**
 * 读取配置文件。
 * - 文件不存在：返回默认配置并标记 missing（同工作区仍可用，跨工作区自然全拒）
 * - 解析失败：config 为 null，调用方必须按「拒绝」处理
 */
export function readConfig(filePath, readFile) {
  let text
  try {
    text = readFile(filePath)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { config: { ...DEFAULT_CONFIG }, error: null, missing: true }
    }
    return { config: null, error, missing: false }
  }
  return { ...parseConfigText(text), missing: false }
}

/**
 * 规范化工作区路径再做相等比较。
 * - 先 resolve 成绝对路径，再尽量展开符号链接；
 * - 去掉尾部分隔符；Windows 下大小写不敏感；
 * - 只做「相等」判断，绝不做前缀匹配（/repo 与 /repo-2 是两个工作区）。
 */
export function normalizeWorkspacePath(input, options = {}) {
  const { platform = process.platform, realpath } = options
  if (typeof input !== 'string' || input.trim() === '') return null
  const original = input.trim()
  let resolved
  try {
    resolved = path.resolve(original)
  } catch {
    return null
  }
  if (typeof realpath === 'function') {
    try {
      resolved = realpath(resolved)
    } catch {
      // 路径还不存在时保留 resolve 的结果
    }
  }
  const root = path.parse(resolved).root
  if (resolved.length > root.length) {
    resolved = resolved.replace(/[\\/]+$/, '')
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 两个 cwd 是否属于同一个工作区；任一缺失都按「不是」处理（fail closed）。 */
export function sameWorkspace(left, right, options = {}) {
  const a = normalizeWorkspacePath(left, options)
  const b = normalizeWorkspacePath(right, options)
  return a !== null && b !== null && a === b
}

/** 只取 text 块，reasoning 不进入回传。 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export function textOfMessage(message) {
  return textOfContent(message && message.content)
}

/** 会话事件列表；非 Session 形状返回空数组。 */
function eventsOf(session) {
  if (!session || typeof session.ownEvents !== 'function') return []
  const events = session.ownEvents()
  return Array.isArray(events) ? events : []
}

/** 会话的最新 seq；空日志为 -1。 */
export function lastSeq(session) {
  const events = eventsOf(session)
  const last = events[events.length - 1]
  return last && Number.isFinite(last.seq) ? last.seq : -1
}

/**
 * 会话标题：优先最后一条 session/title 事件，其次首条 user 消息前 24 字，
 * 最后退到 sessionId 前 8 位。SessionHeader 本身没有 title 字段。
 */
export function sessionTitle(session) {
  const events = eventsOf(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && event.type === 'session/title') {
      const title = event.data && event.data.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    }
  }
  for (const event of events) {
    if (event && event.type === 'user/message') {
      const text = textOfMessage(event.data)
      if (text) return text.replace(/\s+/g, ' ').slice(0, 24)
    }
  }
  const id = session && typeof session.id === 'string' ? session.id : ''
  return id ? id.slice(0, 8) : '未知会话'
}

/** 会话的工作目录（SessionHeader.cwd）；缺失返回 null。 */
export function sessionCwd(session) {
  const cwd = session && session.header && session.header.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null
}

/** 会话 id 的短码：session-<uuid> → uuid 去掉连字符后的前 8 位。 */
export function shortSessionId(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId : ''
  const uuid = text.startsWith('session-') ? text.slice('session-'.length) : text
  const short = uuid.replace(/-/g, '').slice(0, 8)
  return short || 'unknown'
}

/** 自描述回复令牌：m-<发起方短码>-<nonce>，不依赖内存路由表。 */
export function makeReplyToken(sessionId, nonce) {
  return `m-${shortSessionId(sessionId)}-${nonce}`
}

/** 解析回复令牌；非法返回 null。 */
export function parseReplyToken(token) {
  const match = /^m-([0-9a-z]{4,16})-([0-9a-z]{4,16})$/i.exec(String(token || '').trim())
  if (!match) return null
  return { short: match[1].toLowerCase(), nonce: match[2].toLowerCase() }
}

/** 从正文里读转发深度标注 [hop:N]；没有则为 0。 */
export function parseHop(text) {
  const match = /\[hop:(\d+)\]/i.exec(String(text || ''))
  if (!match) return 0
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 取某一轮里 seq ∈ (baseline, endSeq] 的全部 assistant/message，按步序拼成文本。
 * 只认 turn 相同的消息——这就是「不串轮」的落点。
 */
export function collectTurnText(session, baseline, endSeq, turn) {
  const parts = []
  for (const event of eventsOf(session)) {
    if (!event || !Number.isFinite(event.seq)) continue
    if (event.seq <= baseline || event.seq > endSeq) continue
    if (event.type !== 'assistant/message') continue
    if (!event.data || event.data.turn !== turn) continue
    const text = textOfMessage(event.data.message)
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

/** 进程内滑动窗口限流：同一 key 在 windowMs 内最多 limit 次。 */
export class SlidingWindow {
  constructor(limit, windowMs = 60000, now = () => Date.now()) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
    this.hits = new Map()
  }

  /** 记录一次并返回是否放行。 */
  take(key, limit = this.limit) {
    const now = this.now()
    const from = now - this.windowMs
    const kept = (this.hits.get(key) || []).filter((time) => time > from)
    if (kept.length >= limit) {
      this.hits.set(key, kept)
      return false
    }
    kept.push(now)
    this.hits.set(key, kept)
    return true
  }
}

/**
 * 投递并捕获「这一轮」的回复。
 *
 * 顺序是硬要求：先挂监听 → 记 baseline → followup → 等 claimed 认领 turn →
 * 等同一个 turn 的 turn/end → 按 seq 窗口取 assistant/message。
 * 绝不能用 whenIdle()（它观察整个 agent 的活动，不认领具体消息）。
 *
 * @param {object} options
 * @param {{on: Function}} options.bus - 事件总线（生产环境是 ctx）
 * @param {object} options.session - 目标 Agent 的 Session
 * @param {string} options.targetId - 目标 SessionId
 * @param {string} options.messageId - 我们刚投递的 UserMessage.id
 * @param {number} options.maxWaitMs - 最长等待
 * @param {AbortSignal=} options.signal - 调用方取消信号
 * @param {Function} options.followup - 真正执行投递的函数
 * @param {Function=} options.now - 时钟，测试可注入
 * @returns {Promise<{status: string, turn: number, text: string, elapsedMs: number, code?: string}>}
 */
export function captureTurn(options) {
  const { bus, session, targetId, messageId, maxWaitMs, signal, followup, now = () => Date.now() } = options
  const startedAt = now()
  const baseline = lastSeq(session)

  return new Promise((resolve, reject) => {
    let settled = false
    let turn = null
    let timer = null
    const disposers = []

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
      }
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // 注销失败不影响结果
        }
      }
    }

    const settle = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const onAbort = () =>
      settle({
        status: 'timeout',
        turn: turn === null ? 0 : turn,
        text: '调用方已取消，没有等到这一轮结束',
        elapsedMs: now() - startedAt,
        code: 'cancelled',
      })

    if (signal && signal.aborted) {
      resolve({
        status: 'timeout',
        turn: 0,
        text: '调用方已取消，消息未投递',
        elapsedMs: 0,
        code: 'cancelled',
      })
      return
    }

    disposers.push(
      bus.on('agent/inbox/claimed', (payload) => {
        if (settled) return
        if (!payload || !payload.agent || payload.agent.id !== targetId) return
        if (!payload.message || payload.message.id !== messageId) return
        if (typeof payload.turn === 'number') turn = payload.turn
      }),
    )

    disposers.push(
      bus.on('session/event', (changed, event) => {
        if (settled) return
        if (!changed || changed.id !== targetId) return
        if (!event || event.type !== 'turn/end') return
        if (turn === null || !event.data || event.data.turn !== turn) return
        settle({
          status: 'replied',
          turn,
          text: collectTurnText(session, baseline, event.seq, turn),
          elapsedMs: now() - startedAt,
        })
      }),
    )

    if (maxWaitMs > 0) {
      timer = setTimeout(
        () =>
          settle({
            status: 'timeout',
            turn: turn === null ? 0 : turn,
            text: `超过 ${Math.round(maxWaitMs / 1000)}s 仍未答完；消息已入队，稍后可在目标会话看到结果`,
            elapsedMs: now() - startedAt,
          }),
        maxWaitMs,
      )
    }

    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      followup()
    } catch (error) {
      fail(error)
    }
  })
}
