import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  SlidingWindow,
  captureTurn,
  collectTurnText,
  lastSeq,
  normalizeConfig,
  normalizeWorkspacePath,
  parseConfigText,
  readConfig,
  sameWorkspace,
  sessionCwd,
  sessionTitle,
  textOfMessage,
} from '../core.js'

function fakeSession(id, events = [], cwd) {
  return {
    id,
    header: cwd === undefined ? {} : { cwd },
    events,
    ownEvents() {
      return this.events
    },
  }
}

function fakeBus() {
  const listeners = new Map()
  return {
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((item) => item !== fn),
        )
      }
    },
    emit(name, ...args) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(...args)
    },
    count(name) {
      return (listeners.get(name) ?? []).length
    },
  }
}

test('normalizeConfig: 缺省值是「同工作区放行、跨工作区全拒」', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.workspaceInterop, true)
  assert.deepEqual(config.allowCross, [])
  assert.equal(config.maxWaitMs, DEFAULT_CONFIG.maxWaitMs)
  assert.equal(config.maxChars, DEFAULT_CONFIG.maxChars)
  assert.equal(config.maxPerMinute, DEFAULT_CONFIG.maxPerMinute)
})

test('normalizeConfig: allowCross 去重、丢弃非法项、workspaceInterop=false 生效', () => {
  const config = normalizeConfig({
    workspaceInterop: false,
    allowCross: [
      { sessionId: ' s1 ', title: 'A', grantedAt: 5 },
      { sessionId: 's1', title: '重复' },
      { sessionId: '', title: '空' },
      null,
      { title: '没有 id' },
      { sessionId: 's2' },
    ],
    maxWaitMs: -1,
    maxChars: 0,
    maxPerMinute: 2,
  })
  assert.equal(config.workspaceInterop, false)
  assert.deepEqual(
    config.allowCross.map((entry) => entry.sessionId),
    ['s1', 's2'],
  )
  assert.equal(config.allowCross[0].title, 'A')
  assert.equal(config.allowCross[1].grantedAt, 0)
  assert.equal(config.maxWaitMs, DEFAULT_CONFIG.maxWaitMs)
  assert.equal(config.maxChars, DEFAULT_CONFIG.maxChars)
  assert.equal(config.maxPerMinute, 2)
})

test('parseConfigText: 坏 JSON 必须暴露 error，而不是空配置', () => {
  const broken = parseConfigText('{ nope')
  assert.equal(broken.config, null)
  assert.ok(broken.error instanceof Error)
})

test('readConfig: 文件不存在时返回默认配置并标记 missing', () => {
  const missing = readConfig('C:/nope/agent-forward.json', () => {
    const error = new Error('not found')
    error.code = 'ENOENT'
    throw error
  })
  assert.equal(missing.missing, true)
  assert.equal(missing.config.workspaceInterop, true)
})

test('readConfig: 正常读取', () => {
  const loaded = readConfig(
    'C:/x.json',
    () => '{"workspaceInterop":false,"allowCross":[{"sessionId":"s1","title":"A","grantedAt":9}]}',
  )
  assert.equal(loaded.missing, false)
  assert.equal(loaded.config.workspaceInterop, false)
  assert.equal(loaded.config.allowCross[0].sessionId, 's1')
})

test('normalizeWorkspacePath: 尾斜杠、空值、Windows 大小写', () => {
  assert.equal(normalizeWorkspacePath('', {}), null)
  assert.equal(normalizeWorkspacePath(undefined, {}), null)
  const win = { platform: 'win32' }
  assert.equal(
    normalizeWorkspacePath('C:\\Work\\Alpha\\', win),
    normalizeWorkspacePath('c:\\work\\alpha', win),
  )
  assert.notEqual(
    normalizeWorkspacePath('C:\\Work\\Alpha\\', win),
    normalizeWorkspacePath('C:\\Work\\Alpha-2', win),
  )
})

test('sameWorkspace: 只做相等判定，不存在前缀关系', () => {
  const win = { platform: 'win32' }
  assert.equal(sameWorkspace('C:\\repo', 'c:\\REPO\\', win), true)
  assert.equal(sameWorkspace('C:\\repo', 'C:\\repo-2', win), false)
  assert.equal(sameWorkspace('/repo', '/repo/sub', { platform: 'linux' }), false)
  assert.equal(sameWorkspace('/repo', undefined, { platform: 'linux' }), false)
})

test('sessionCwd: 取 SessionHeader.cwd，缺失返回 null', () => {
  assert.equal(sessionCwd(fakeSession('s', [], 'C:\\work')), 'C:\\work')
  assert.equal(sessionCwd(fakeSession('s')), null)
  assert.equal(sessionCwd({}), null)
})

test('sessionTitle: 优先 session/title，其次首条用户消息，最后 sessionId', () => {
  const titled = fakeSession('session-abcdef', [
    { type: 'session/title', seq: 0, data: { title: '小全' } },
  ])
  assert.equal(sessionTitle(titled), '小全')

  const fromUser = fakeSession('session-abcdef', [
    { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '帮我核对一下这个方案' }] } },
  ])
  assert.equal(sessionTitle(fromUser), '帮我核对一下这个方案')

  assert.equal(sessionTitle(fakeSession('session-abcdef')), 'session-')
})

test('textOfMessage: 只拼 text 块', () => {
  assert.equal(
    textOfMessage({ content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '答' }] }),
    '答',
  )
})

test('lastSeq: 空日志为 -1', () => {
  assert.equal(lastSeq(fakeSession('s')), -1)
  assert.equal(lastSeq(fakeSession('s', [{ type: 'turn/start', seq: 4, data: { turn: 1 } }])), 4)
})

test('collectTurnText: 只取窗口内、同一 turn 的 assistant/message', () => {
  const session = fakeSession('s', [
    { type: 'assistant/message', seq: 1, data: { turn: 1, message: { content: [{ type: 'text', text: '旧轮' }] } } },
    { type: 'assistant/message', seq: 3, data: { turn: 2, message: { content: [{ type: 'text', text: '第一段' }] } } },
    { type: 'tool/call', seq: 4, data: { turn: 2 } },
    { type: 'assistant/message', seq: 5, data: { turn: 2, message: { content: [{ type: 'text', text: '第二段' }] } } },
    { type: 'assistant/message', seq: 6, data: { turn: 3, message: { content: [{ type: 'text', text: '下一轮' }] } } },
  ])
  assert.equal(collectTurnText(session, 2, 5, 2), '第一段\n\n第二段')
  assert.equal(collectTurnText(session, 2, 4, 2), '第一段')
})

test('SlidingWindow: 达到上限后拒绝，窗口滑过后放行', () => {
  let now = 1000
  const limiter = new SlidingWindow(2, 60000, () => now)
  assert.equal(limiter.take('a>b'), true)
  assert.equal(limiter.take('a>b'), true)
  assert.equal(limiter.take('a>b'), false)
  assert.equal(limiter.take('a>c'), true)
  now += 60001
  assert.equal(limiter.take('a>b'), true)
})

test('captureTurn: 先挂监听再 followup，命中认领的 turn 后按窗口取回复', async () => {
  const bus = fakeBus()
  const session = fakeSession('session-target', [
    { type: 'assistant/message', seq: 0, data: { turn: 0, message: { content: [{ type: 'text', text: '历史' }] } } },
  ])
  let sawListeners = false

  const pending = captureTurn({
    bus,
    session,
    targetId: 'session-target',
    messageId: 'msg-1',
    maxWaitMs: 5000,
    followup() {
      sawListeners = bus.count('agent/inbox/claimed') === 1 && bus.count('session/event') === 1
      bus.emit('session/event', { id: 'session-other' }, { type: 'turn/end', seq: 9, data: { turn: 1 } })
      bus.emit('agent/inbox/claimed', { agent: { id: 'session-other' }, message: { id: 'msg-1' }, turn: 1 })
      bus.emit('agent/inbox/claimed', { agent: { id: 'session-target' }, message: { id: 'msg-1' }, turn: 7 })
      session.events.push(
        { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '转发' }] } },
        { type: 'assistant/message', seq: 2, data: { turn: 7, message: { content: [{ type: 'text', text: '收到，我来看看' }] } } },
      )
      bus.emit('session/event', { id: 'session-target' }, { type: 'turn/end', seq: 2, data: { turn: 7 } })
    },
  })

  const result = await pending
  assert.equal(sawListeners, true)
  assert.equal(result.status, 'replied')
  assert.equal(result.turn, 7)
  assert.equal(result.text, '收到，我来看看')
  assert.equal(bus.count('agent/inbox/claimed'), 0, '结算后必须注销监听')
  assert.equal(bus.count('session/event'), 0, '结算后必须注销监听')
})

test('captureTurn: 超时返回 timeout，且消息已入队的语义写在 text 里', async () => {
  const bus = fakeBus()
  const session = fakeSession('session-target')
  const result = await captureTurn({
    bus,
    session,
    targetId: 'session-target',
    messageId: 'msg-2',
    maxWaitMs: 20,
    followup() {},
  })
  assert.equal(result.status, 'timeout')
  assert.equal(result.turn, 0)
  assert.match(result.text, /已入队/)
  assert.equal(bus.count('agent/inbox/claimed'), 0)
})

test('captureTurn: 调用方取消 → timeout + cancelled', async () => {
  const bus = fakeBus()
  const session = fakeSession('session-target')
  const controller = new AbortController()
  const pending = captureTurn({
    bus,
    session,
    targetId: 'session-target',
    messageId: 'msg-3',
    maxWaitMs: 5000,
    signal: controller.signal,
    followup() {
      controller.abort()
    },
  })
  const result = await pending
  assert.equal(result.status, 'timeout')
  assert.equal(result.code, 'cancelled')
})
