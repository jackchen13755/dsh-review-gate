import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REPORT_SOURCE_KIND, coverageFromReport, findReviewReport } from '../lib/review-report.js'

const reportEvent = (text, sourceKind = REPORT_SOURCE_KIND) => ({
  type: 'message',
  data: {
    turn: 3,
    message: {
      role: 'user',
      source: { kind: sourceKind },
      content: [{ type: 'text', text }],
    },
  },
})

const writeCall = (name = 'edit') => ({ type: 'tool/call', data: { turn: 4, step: 1, callId: 'c1', name } })
const OTHER = { type: 'message', data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } } }

test('边界输入：空 / 非数组 / undefined 事件不抛，判为没有报告', () => {
  for (const events of [undefined, null, [], 'x', 42, {}]) {
    assert.equal(findReviewReport(events).seen, false)
    assert.equal(coverageFromReport(events).reviewed, false)
  }
})

test('没有评审消息 → no-report', () => {
  assert.equal(coverageFromReport([OTHER]).reason, 'no-report')
})

test('成功报告 + 之后没改代码 → 覆盖当前 diff', () => {
  const events = [OTHER, reportEvent('Here is the completed code review report:\n\n## ok')]
  assert.equal(findReviewReport(events).completed, true)
  assert.deepEqual(coverageFromReport(events), { reviewed: true, reason: 'report-covers-diff' })
})

test('失败报告 → 不算评审', () => {
  const events = [OTHER, reportEvent('The code review did not complete:\n\n操作已中止。')]
  const r = findReviewReport(events)
  assert.equal(r.seen, true)
  assert.equal(r.completed, false)
  assert.equal(coverageFromReport(events).reason, 'report-failed')
})

test('报告之后又改了代码 → changed-after-report（审完又改不算数）', () => {
  const events = [OTHER, reportEvent('Here is the completed code review report: ok'), writeCall('edit')]
  assert.equal(coverageFromReport(events).reason, 'changed-after-report')
})

test('报告之后的非写类工具调用不算改动', () => {
  const events = [OTHER, reportEvent('Here is the completed code review report: ok'), writeCall('read')]
  assert.equal(coverageFromReport(events).reviewed, true)
})

test('取最后一条评审消息：先失败后成功 → 以成功为准', () => {
  const events = [
    reportEvent('The code review did not complete: x'),
    reportEvent('Here is the completed code review report: ok'),
  ]
  assert.equal(coverageFromReport(events).reviewed, true)
})

test('source.kind 不匹配的消息一律忽略（不误认别人的注入）', () => {
  const events = [reportEvent('Here is the completed code review report: ok', 'some-other-plugin')]
  assert.equal(findReviewReport(events).seen, false)
})

test('content 是纯字符串也认（形状容错）', () => {
  const events = [{
    type: 'message',
    data: { message: { role: 'user', source: { kind: REPORT_SOURCE_KIND }, content: 'Here is the completed code review report: ok' } },
  }]
  assert.equal(coverageFromReport(events).reviewed, true)
})

test('畸形消息（无 content / content 非数组）不抛', () => {
  const events = [
    { type: 'message', data: { message: { role: 'user', source: { kind: REPORT_SOURCE_KIND } } } },
    { type: 'message', data: { message: { role: 'user', source: { kind: REPORT_SOURCE_KIND }, content: 42 } } },
  ]
  assert.equal(findReviewReport(events).completed, false)
})
