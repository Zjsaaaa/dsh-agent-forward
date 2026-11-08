/**
 * 已关闭会话的只读索引。
 *
 * DSH 的会话日志是 `<DSH_HOME>/sessions/<工作区目录>/<sessionId>/session.v4.jsonl.zstd`，
 * zstd 多帧追加。这里只读文件头（第一帧给 sessionId / cwd）与标题事件（session/title），
 * 不写任何东西；失败就跳过该会话，绝不因为一个坏文件让 agent_list 整体失败。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const LOG_NAME = 'session.v4.jsonl.zstd'
const cache = new Map()

export function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function'
}

/** zstd 帧边界（多帧追加，Node 的 decompress 只认第一帧）。 */
function frameOffsets(buffer) {
  const offsets = []
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    if (
      buffer[index] === MAGIC[0] &&
      buffer[index + 1] === MAGIC[1] &&
      buffer[index + 2] === MAGIC[2] &&
      buffer[index + 3] === MAGIC[3]
    ) {
      offsets.push(index)
    }
  }
  offsets.push(buffer.length)
  return offsets
}

/** 逐帧解压，收集事件；找到标题就提前停。 */
function readEvents(file, maxFrames) {
  const buffer = readFileSync(file)
  const offsets = frameOffsets(buffer)
  const events = []
  let pending = ''

  for (let index = 0; index < offsets.length - 1 && index < maxFrames; index += 1) {
    let chunk
    try {
      chunk = zlib.zstdDecompressSync(buffer.subarray(offsets[index], offsets[index + 1])).toString('utf8')
    } catch {
      break
    }
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // 坏行跳过
      }
    }
    if (events.some((event) => event && event.type === 'session/title')) break
  }
  return events
}

function readSessionInfo(file, updatedAt, maxFrames) {
  const events = readEvents(file, maxFrames)
  const header = events.find((event) => event && event.type === 'session')
  if (!header || typeof header.id !== 'string') return null

  let title = ''
  for (const event of events) {
    if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      title = event.data.title.trim()
    }
  }

  return {
    id: header.id,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    title,
    createdAt: Number.isFinite(header.createdAt) ? header.createdAt : 0,
    updatedAt,
  }
}

/**
 * 扫描所有已持久化的会话。
 * @param {string} sessionsRoot - <DSH_HOME>/sessions
 * @param {{maxFrames?: number}} [options]
 * @returns {{sessions: Array<object>, error: Error|null}}
 */
export function scanClosedSessions(sessionsRoot, options = {}) {
  if (!zstdAvailable()) {
    return { sessions: [], error: new Error('当前运行时没有 zlib.zstdDecompressSync，无法读取会话索引') }
  }
  const maxFrames = Number.isFinite(options.maxFrames) ? options.maxFrames : 80
  const sessions = []

  let workspaceDirs
  try {
    workspaceDirs = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    return { sessions: [], error }
  }

  for (const workspaceDir of workspaceDirs) {
    if (!workspaceDir.isDirectory()) continue
    const workspacePath = join(sessionsRoot, workspaceDir.name)
    let sessionDirs
    try {
      sessionDirs = readdirSync(workspacePath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue
      const file = join(workspacePath, sessionDir.name, LOG_NAME)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      if (!stat.isFile()) continue

      const cached = cache.get(file)
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        sessions.push(cached.info)
        continue
      }
      try {
        const info = readSessionInfo(file, stat.mtimeMs, maxFrames)
        if (info) {
          cache.set(file, { mtimeMs: stat.mtimeMs, info })
          sessions.push(info)
        }
      } catch {
        // 单个会话坏了不影响整体
      }
    }
  }

  return { sessions, error: null }
}

/** 测试用：清掉按文件缓存。 */
export function clearSessionCache() {
  cache.clear()
}
