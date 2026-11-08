import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { clearSessionCache, scanClosedSessions, zstdAvailable } from '../closed.js'

const root = join(process.cwd(), 'test', `.tmp-closed-${process.pid}`)

function makeSessionFile(dir, id, cwd, title) {
  const sessionDir = join(root, dir, id)
  mkdirSync(sessionDir, { recursive: true })
  const header = JSON.stringify({ type: 'session', version: 4, id, createdAt: 1000, cwd })
  const titleEvent = JSON.stringify({ type: 'session/title', seq: 1, data: { title } })
  const frames = Buffer.concat([
    zstdCompressSync(Buffer.from(`${header}\n`, 'utf8')),
    zstdCompressSync(Buffer.from(`${titleEvent}\n`, 'utf8')),
  ])
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), frames)
}

test('scanClosedSessions: 读头部 cwd 与标题，跳过坏文件', (t) => {
  if (!zstdAvailable()) {
    t.skip('当前 Node 没有 zstd')
    return
  }
  rmSync(root, { recursive: true, force: true })
  makeSessionFile('ws-a', 'session-11111111-1111-1111-1111-111111111111', 'C:\\work\\alpha', '关掉的会话')
  makeSessionFile('ws-b', 'session-22222222-2222-2222-2222-222222222222', 'C:\\work\\beta', '另一个工作区')

  // 坏文件：不该让整体失败
  const badDir = join(root, 'ws-a', 'session-33333333-3333-3333-3333-333333333333')
  mkdirSync(badDir, { recursive: true })
  writeFileSync(join(badDir, 'session.v4.jsonl.zstd'), Buffer.from('not zstd'))

  clearSessionCache()
  const { sessions, error } = scanClosedSessions(root)
  assert.equal(error, null)
  const byId = new Map(sessions.map((session) => [session.id, session]))
  assert.equal(byId.size, 2)
  assert.equal(byId.get('session-11111111-1111-1111-1111-111111111111').cwd, 'C:\\work\\alpha')
  assert.equal(byId.get('session-11111111-1111-1111-1111-111111111111').title, '关掉的会话')

  // 第二次走缓存，结果一致
  const again = scanClosedSessions(root)
  assert.equal(again.sessions.length, 2)

  rmSync(root, { recursive: true, force: true })
})
