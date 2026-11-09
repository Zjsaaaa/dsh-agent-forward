import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const root = join(process.cwd(), 'test', `.tmp-smoke-${process.pid}`)
const home = join(root, 'home')
const sessions = join(home, 'sessions')
const alpha = join(root, 'alpha')
const beta = join(root, 'beta')
mkdirSync(sessions, { recursive: true })
mkdirSync(alpha, { recursive: true })
mkdirSync(beta, { recursive: true })
process.env.DSH_HOME = home

const { apply } = await import('../index.js')
const { shortSessionId } = await import('../core.js')

function writeClosedSession(dirName, id, cwd, title) {
  const dir = join(sessions, dirName, id)
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id, createdAt: 1000, cwd }),
    JSON.stringify({ type: 'session/title', seq: 1, data: { title } }),
  ].join('\n')
  const frames = Buffer.concat([zstdCompressSync(Buffer.from(`${lines.split('\n')[0]}\n`)), zstdCompressSync(Buffer.from(`${lines.split('\n')[1]}\n`))])
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frames)
}

const CLOSED_ALPHA = 'session-aaaa1111-1111-1111-1111-111111111111'
const CLOSED_BETA = 'session-bbbb2222-2222-2222-2222-222222222222'
const CLOSED_ALPHA_2 = 'session-cccc3333-3333-3333-3333-333333333333'
writeClosedSession('ws-alpha', CLOSED_ALPHA, alpha, '关掉的同区会话')
writeClosedSession('ws-beta', CLOSED_BETA, beta, '关掉的跨区会话')
writeClosedSession('ws-alpha', CLOSED_ALPHA_2, alpha, '第二个关掉的会话')

function makeSession(id, cwd, title) {
  const events = [{ type: 'session/title', seq: 0, data: { title } }]
  let next = 1
  return {
    id,
    header: { cwd },
    events,
    ownEvents() {
      return this.events
    },
    push(event) {
      event.seq = next
      next += 1
      this.events.push(event)
      return event
    },
    append(type, data, opts) {
      return this.push({ type, data, ...(opts ? { surfaceOp: opts.surfaceOp } : {}) })
    },
  }
}

const listeners = new Map()
const emit = (name, ...args) => {
  for (const fn of [...(listeners.get(name) ?? [])]) fn(...args)
}

let turnSeq = 100

function makeAgent(id, session) {
  const queue = []
  const agent = {
    id,
    status: 'idle',
    session,
    queue,
    followup(message) {
      const turn = (turnSeq += 1)
      queueMicrotask(() => {
        emit('agent/inbox/claimed', { agent, message, turn })
        session.push({ type: 'user/message', data: message })
        session.push({
          type: 'assistant/message',
          data: { turn, message: { content: [{ type: 'text', text: `${id} 的回答` }] } },
        })
        const last = session.events[session.events.length - 1]
        emit('session/event', session, { type: 'turn/end', seq: last.seq, data: { turn } })
      })
    },
    send(message, target, wakeup) {
      queue.push({ message, target, wakeup })
    },
  }
  return agent
}

const sessionA = makeSession('session-a', alpha, '小齐')
const sessionB = makeSession('session-b', alpha, '小全')
const sessionC = makeSession('session-c', beta, '隔壁项目')
const agentA = makeAgent('session-a', sessionA)
const agentB = makeAgent('session-b', sessionB)
const agentC = makeAgent('session-c', sessionC)
const resumedAgents = new Map()

const tools = new Map()
const commands = new Map()
const ctx = {
  tools: { register: (definition) => (tools.set(definition.name, definition), () => {}) },
  commands: { register: (definition) => (commands.set(definition.name, definition), () => {}) },
  agents: {
    roots: () => [agentA, agentB, agentC],
    get: (id) => [agentA, agentB, agentC].find((agent) => agent.id === id) ?? resumedAgents.get(id),
    async resume({ resumeSessionId }) {
      const existing = resumedAgents.get(resumeSessionId)
      if (existing) return { agent: existing }
      const session = makeSession(resumeSessionId, alpha, '恢复的会话')
      const agent = makeAgent(resumeSessionId, session)
      resumedAgents.set(resumeSessionId, agent)
      return { agent }
    },
  },
  on(name, fn) {
    const list = listeners.get(name) ?? []
    list.push(fn)
    listeners.set(name, list)
    return () => listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== fn))
  },
}

apply(ctx)
assert.deepEqual([...tools.keys()], ['agent_list', 'agent_send', 'agent_reply'])
assert.deepEqual([...commands.keys()], ['agent-forward'])

const runCommand = (rawInput) => commands.get('agent-forward').handler({ agent: agentA, rawInput })
const callSend = (args) => tools.get('agent_send').execute(args, { agent: agentA, signal: new AbortController().signal })

// 1. 列表：同区 live + 同区 closed；跨区未授权不出现
let list = await tools.get('agent_list').execute({}, { agent: agentA })
const listed = new Map(list.agents.map((agent) => [agent.id, agent]))
assert.equal(listed.get('session-b').state, 'live')
assert.equal(listed.get('session-b').scope, 'workspace')
assert.equal(listed.get(CLOSED_ALPHA).state, 'closed')
assert.equal(listed.get(CLOSED_ALPHA).scope, 'workspace')
assert.equal(listed.has('session-c'), false)
assert.equal(listed.has(CLOSED_BETA), false)

// 2. 默认投递不阻塞，返回 token；接收方拿到带来源块的 user 消息
const delivered = await callSend({ session_id: 'session-b', text: '迁移顺序怎么排？', reason: '需要确认' })
assert.equal(delivered.status, 'delivered')
assert.equal(delivered.delivered, true)
assert.equal(delivered.woke, true)
assert.match(delivered.replyToken, /^m-[0-9a-z]{1,16}-[0-9a-z]{8}$/)
const received = sessionB.events.find((event) => event.type === 'user/message').data
const receivedText = received.content[0].text
assert.match(receivedText, new RegExp(`^\\[协作请求 #${delivered.replyToken}\\]`))
assert.match(receivedText, /发起者：另一个智能体（不是你本人）/)
assert.match(receivedText, /\[hop:1\]/)
assert.equal(received.source.fromKind, 'agent')
assert.equal(received.source.senderSessionId, 'session-a')

// 发起侧留痕：直接 append 的 user/message（不进 inbox、不产生 turn）
const notice = sessionA.events.filter((event) => event.type === 'user/message' && event.data.source?.kind === 'agent-forward').at(-1)
assert.ok(notice, '发起方会话里应有一条通知')
assert.equal(notice.surfaceOp, 'append')
assert.match(notice.data.content[0].text, /^系统通知 · 非用户输入\n/)
assert.match(notice.data.content[0].text, /已投递给「小全」/)
assert.equal(notice.data.source.kind, 'agent-forward')
assert.equal(notice.data.source.form, 'notice')
assert.equal(agentA.queue.length, 0, '通知不能走 inbox.send')

// 3. B 回复 → A 收到 [回复 #token]；重复回复被拒
const token = delivered.replyToken
const reply = await tools.get('agent_reply').execute({ reply_token: token, text: '先建索引，再迁数据' }, { agent: agentB })
assert.equal(reply.status, 'delivered')
const back = sessionA.events.filter((event) => event.type === 'user/message').at(-1).data
assert.match(back.content[0].text, new RegExp(`\\[回复 #${token}\\]`))
assert.match(back.content[0].text, /先建索引，再迁数据/)
const replyNotice = () => sessionB.events.filter((event) => event.type === 'user/message' && event.data.source?.kind === 'agent-forward').at(-1)
assert.match(replyNotice().data.content[0].text, /已回复「小齐」/)
const duplicate = await tools.get('agent_reply').execute({ reply_token: token, text: '再说一次' }, { agent: agentB })
assert.equal(duplicate.code, 'DUPLICATE_REPLY')
assert.match(replyNotice().data.content[0].text, /^系统通知 · 非用户输入\n回复失败：/)

// 4. wait:true 才阻塞取回这一轮
const waited = await callSend({ session_id: 'session-b', text: '现在几点', reason: '测试', wait: true })
assert.equal(waited.status, 'replied')
assert.match(waited.text, /session-b 的回答/)


// 5. hop 超限：只投递不唤醒
const hop3 = await callSend({ session_id: 'session-b', text: '继续 [hop:3]', reason: '测试' })
assert.equal(hop3.delivered, true)
assert.equal(hop3.woke, false)
assert.match(hop3.text, /最大转发深度/)

// 6. 跨工作区未授权：拒绝且目标零新消息
const beforeC = sessionC.events.length
const denied = await callSend({ session_id: 'session-c', text: '你好', reason: '测试' })
assert.equal(denied.code, 'NOT_ALLOWED')
assert.equal(sessionC.events.length, beforeC)

// 7. 授权后跨区可投递，列表标 external
assert.equal((await runCommand('allow session-c')).kind, 'success')
list = await tools.get('agent_list').execute({}, { agent: agentA })
assert.equal(list.agents.find((agent) => agent.id === 'session-c').scope, 'external')
const cross = await callSend({ session_id: 'session-c', text: '帮我核对', reason: '核对结论' })

// 7b. 回归：wait:true 期间对方用 agent_reply 投递了正文 → 工具返回值不再重复搬运正文
//     （否则发送方会同时从「工具返回值」和「消息」看到同一段文字）
const earlyC = await callSend({ session_id: 'session-c', text: '先问一句', reason: '测试' })
const realFollowupC = agentC.followup
agentC.followup = (message) => setTimeout(() => realFollowupC.call(agentC, message), 20)
const pendingC = callSend({ session_id: 'session-c', text: '再问一句', reason: '测试', wait: true })
await new Promise((resolve) => setTimeout(resolve, 5))
await tools.get('agent_reply').execute({ reply_token: earlyC.replyToken, text: '这段正文只应出现一次' }, { agent: agentC })
const deduped = await pendingC
agentC.followup = realFollowupC
assert.equal(deduped.status, 'replied')
assert.match(deduped.text, /正文已作为消息送达/)
assert.doesNotMatch(deduped.text, /session-c 的回答/)
assert.equal(cross.status, 'delivered')
assert.equal(cross.scope, 'external')

// 8. closed 目标：同区自动 resume 并投递
const closedSend = await callSend({ session_id: CLOSED_ALPHA, text: '你还在吗', reason: '测试' })
assert.equal(closedSend.status, 'delivered')
assert.equal(closedSend.state, 'closed')
assert.equal(closedSend.resumed, true)

// 9. closed 跨区未授权：不 resume，直接拒绝
const resumeCalls = []
const originalResume = ctx.agents.resume
ctx.agents.resume = async (options) => {
  resumeCalls.push(options.resumeSessionId)
  return originalResume(options)
}
const closedDenied = await callSend({ session_id: CLOSED_BETA, text: '越界', reason: '测试' })
assert.equal(closedDenied.code, 'NOT_ALLOWED')
assert.deepEqual(resumeCalls, [])

// 10. resumeClosed=false：closed 目标直接拒绝（且不 resume）
writeFileSync(join(alpha, '.dsh', 'agent-forward.json'), JSON.stringify({ resumeClosed: false }, null, 2))
const resumeCalls2 = []
ctx.agents.resume = async (options) => {
  resumeCalls2.push(options.resumeSessionId)
  return originalResume(options)
}
const disabled = await callSend({ session_id: CLOSED_ALPHA_2, text: '还在吗', reason: '测试' })
assert.equal(disabled.code, 'CLOSED_DISABLED')
assert.deepEqual(resumeCalls2, [])

// 11. 主人经命令转达 → 接收方看到 owner-via
const commandSend = await runCommand('send session-b 主人让你看一眼')
assert.equal(commandSend.kind, 'success')
const ownerMsg = sessionB.events.filter((event) => event.type === 'user/message').at(-1).data
assert.match(ownerMsg.content[0].text, /发起者：主人本人（经该会话转达）/)
assert.equal(ownerMsg.source.fromKind, 'owner-via')

// 12. 轮内通知延迟到 turn/end 之后写（不在当前轮里插消息）
agentA.status = 'running'
const noticeCount = () => sessionA.events.filter((event) => event.type === 'user/message' && event.data.source?.kind === 'agent-forward').length
const beforeNotice = noticeCount()
await callSend({ session_id: 'session-b', text: '轮内通知', reason: '测试' })
assert.equal(noticeCount(), beforeNotice, '轮内不应立即 append')
agentA.status = 'idle'
emit('session/event', sessionA, { type: 'turn/end', seq: 0, data: { turn: 99 } })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(noticeCount(), beforeNotice + 1, 'turn/end 之后应 append')

rmSync(root, { recursive: true, force: true })
console.log('smoke ok')
