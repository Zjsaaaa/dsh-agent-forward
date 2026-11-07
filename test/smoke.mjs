import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { apply } from '../index.js'

const root = join(process.cwd(), 'test', `.tmp-${process.pid}`)
const alpha = join(root, 'alpha')
const beta = join(root, 'beta')
mkdirSync(alpha, { recursive: true })
mkdirSync(beta, { recursive: true })

const makeSession = (id, cwd, events = []) => ({
  id,
  header: { cwd },
  events,
  ownEvents() {
    return this.events
  },
})

const sessionA = makeSession('session-a', alpha, [
  { type: 'session/title', seq: 0, data: { title: '小齐' } },
])
const sessionB = makeSession('session-b', alpha, [
  { type: 'session/title', seq: 0, data: { title: '小全' } },
])
const sessionC = makeSession('session-c', beta, [
  { type: 'session/title', seq: 0, data: { title: '隔壁项目' } },
])

function makeAgent(id, session) {
  const agent = {
    id,
    status: 'idle',
    session,
    followup(message) {
      queueMicrotask(() => {
        emit('agent/inbox/claimed', { agent, message, turn: 9 })
        session.events.push(
          { type: 'user/message', seq: 1, data: message },
          {
            type: 'assistant/message',
            seq: 2,
            data: { turn: 9, message: { content: [{ type: 'text', text: `我是 ${id}，收到。` }] } },
          },
        )
        emit('session/event', session, { type: 'turn/end', seq: 2, data: { turn: 9 } })
      })
    },
  }
  return agent
}

const agentA = makeAgent('session-a', sessionA)
const agentB = makeAgent('session-b', sessionB)
const agentC = makeAgent('session-c', sessionC)

const listeners = new Map()
const emit = (name, ...args) => {
  for (const fn of [...(listeners.get(name) ?? [])]) fn(...args)
}

const tools = new Map()
const commands = new Map()
const ctx = {
  tools: { register: (definition) => (tools.set(definition.name, definition), () => {}) },
  commands: { register: (definition) => (commands.set(definition.name, definition), () => {}) },
  agents: {
    roots: () => [agentA, agentB, agentC],
    get: (id) => [agentA, agentB, agentC].find((agent) => agent.id === id),
  },
  on(name, fn) {
    const list = listeners.get(name) ?? []
    list.push(fn)
    listeners.set(name, list)
    return () => listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== fn))
  },
}

apply(ctx)
assert.deepEqual([...tools.keys()], ['agent_list', 'agent_send'])
assert.deepEqual([...commands.keys()], ['agent-forward'])

const runCommand = (rawInput) => commands.get('agent-forward').handler({ agent: agentA, rawInput })

// 1. 同工作区默认可见；跨工作区未授权不出现
let list = await tools.get('agent_list').execute({}, { agent: agentA })
assert.deepEqual(
  list.agents.map((agent) => [agent.id, agent.scope]),
  [['session-b', 'workspace']],
)

// 2. 跨工作区未授权 → 拒绝，且目标会话没有任何新事件
const before = sessionC.events.length
const denied = await tools
  .get('agent_send')
  .execute({ session_id: 'session-c', text: '你好', reason: '测试' }, { agent: agentA })
assert.equal(denied.status, 'rejected')
assert.equal(denied.code, 'NOT_ALLOWED')
assert.equal(sessionC.events.length, before)

// 3. 授权后：列表标 external，发送成功
const granted = await runCommand('allow session-c')
assert.equal(granted.kind, 'success', granted.text)
list = await tools.get('agent_list').execute({}, { agent: agentA })
assert.deepEqual(
  list.agents.map((agent) => [agent.id, agent.scope]),
  [
    ['session-b', 'workspace'],
    ['session-c', 'external'],
  ],
)

const cross = await tools
  .get('agent_send')
  .execute({ session_id: 'session-c', text: '帮我核对', reason: '核对结论' }, { agent: agentA })
assert.equal(cross.status, 'replied')
assert.equal(cross.scope, 'external')
assert.equal(cross.text, '我是 session-c，收到。')

// 4. include_external=false 隐藏跨工作区
list = await tools.get('agent_list').execute({ include_external: false }, { agent: agentA })
assert.deepEqual(list.agents.map((agent) => agent.id), ['session-b'])
assert.match(list.note ?? '', /隐藏/)

// 5. revoke 后立刻恢复拒绝
const revoked = await runCommand('revoke session-c')
assert.equal(revoked.kind, 'success', revoked.text)
const deniedAgain = await tools
  .get('agent_send')
  .execute({ session_id: 'session-c', text: '再试一次', reason: '测试' }, { agent: agentA })
assert.equal(deniedAgain.code, 'NOT_ALLOWED')

// 6. 同工作区不需要授权，命令直接说明
const same = await runCommand('allow session-b')
assert.equal(same.kind, 'success')
assert.match(same.text, /同工作区/)

// 7. L2 总闸关闭：列表为空、发送拒绝
writeFileSync(
  join(alpha, '.dsh', 'agent-forward.json'),
  JSON.stringify({ workspaceInterop: false, allowCross: [] }, null, 2),
)
list = await tools.get('agent_list').execute({}, { agent: agentA })
assert.deepEqual(list.agents, [])
assert.match(list.note ?? '', /workspaceInterop=false/)

const off = await tools
  .get('agent_send')
  .execute({ session_id: 'session-b', text: '还发吗', reason: '测试' }, { agent: agentA })
assert.equal(off.code, 'WORKSPACE_INTEROP_OFF')

rmSync(root, { recursive: true, force: true })
console.log('smoke ok')
