/**
 * §9 of `docs/落地计划-剩余工程.md` — the generalization scan runs in the
 * BACKGROUND (or exactly as before when there is no job registry).
 *
 * The scan used to `await` inside the turn-stopping hook, so a PASS could not
 * finish until every other workspace had been walked. These tests pin the three
 * properties the change is allowed to have: it never fails the turn, it carries
 * the owning agent, and its cancellation story is honest (the walk is not
 * interruptible, so a cancel request is recorded rather than faked).
 *
 * @module @clue-harness/kb-face/test/generalize-schedule
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GENERALIZE_JOB_KIND, scheduleGeneralizationScan, type JobStarter } from '../src/generalize-schedule.ts'

/** A registry that records the spec it was handed and lets the test drive it. */
function registry(): { jobs: JobStarter; specs: Array<Parameters<JobStarter['start']>[0]> } {
  const specs: Array<Parameters<JobStarter['start']>[0]> = []
  return {
    specs,
    jobs: {
      start: (spec) => {
        specs.push(spec)
        return 'kb-generalize-1'
      },
    },
  }
}

test('有 job 注册表:扫描转后台(不 await 完成),kind/label/owner 都带上', async () => {
  const { jobs, specs } = registry()
  let finished = false
  const result = await scheduleGeneralizationScan({
    scan: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); finished = true },
    jobs,
    owner: { id: 'agent-1' } as never,
    label: '跨项目泛化扫描(kb)',
  })
  assert.equal(result.via, 'job')
  assert.equal(result.jobId, 'kb-generalize-1')
  assert.equal(finished, false, '调度必须立刻返回:扫描还在后台跑')
  assert.equal(specs.length, 1)
  assert.equal(specs[0]?.kind, GENERALIZE_JOB_KIND)
  assert.equal(specs[0]?.label, '跨项目泛化扫描(kb)')
  assert.notEqual(specs[0]?.owner, undefined, '没有 owner 的 job 任何读方都能看到 —— 必须挂到发起它的 agent 上')
  const hooks = specs[0]?.run()
  const outcome = await hooks?.done
  assert.equal(outcome?.status, 'completed')
})

test('有注册表:扫描抛错 ⇒ job 记 failed,调度本身不抛(轮次不受影响)', async () => {
  const { jobs, specs } = registry()
  const warnings: string[] = []
  const result = await scheduleGeneralizationScan({
    scan: async () => { throw new Error('某个工作区读不了') },
    jobs,
    warn: (message) => { warnings.push(message) },
  })
  assert.equal(result.via, 'job')
  const outcome = await specs[0]?.run().done
  assert.equal(outcome?.status, 'failed')
  assert.match(String(outcome?.detail), /某个工作区读不了/)
  assert.ok(warnings.some((line) => line.includes('泛化扫描失败')), '失败要留痕')
})

test('取消是诚实的:请求被记录,扫描跑完才结算,结果标 killed', async () => {
  const { jobs, specs } = registry()
  let finished = false
  await scheduleGeneralizationScan({
    scan: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); finished = true },
    jobs,
  })
  const hooks = specs[0]?.run()
  hooks?.cancel('agent 关了')
  assert.equal(finished, false, '取消请求只是记录意图:扫描不可中断,此刻还没跑完')
  const outcome = await hooks?.done
  assert.equal(finished, true, '取消不会假装把工作停掉 —— 它跑完了')
  assert.equal(outcome?.status, 'killed')
  assert.match(String(outcome?.detail), /不可中断/)
  assert.match(hooks?.readOutput?.() ?? '', /agent 关了/)
})

test('没有注册表:退回同步执行(行为与改动前逐字相同),失败只 warn', async () => {
  let ran = 0
  const ok = await scheduleGeneralizationScan({ scan: async () => { ran += 1 } })
  assert.equal(ok.via, 'sync')
  assert.equal(ok.ok, true)
  assert.equal(ran, 1)

  const warnings: string[] = []
  const failed = await scheduleGeneralizationScan({
    scan: async () => { throw new Error('读不了') },
    warn: (message) => { warnings.push(message) },
  })
  assert.equal(failed.via, 'sync')
  assert.equal(failed.ok, false)
  assert.ok(warnings[0]?.includes('泛化扫描失败(已忽略,不影响本轮)'))
})

test('注册表拒绝(例如没有挂控制器):扫描不丢,退回同步执行', async () => {
  const warnings: string[] = []
  let ran = 0
  const result = await scheduleGeneralizationScan({
    scan: async () => { ran += 1 },
    jobs: { start: () => { throw new Error('no attached controller') } },
    warn: (message) => { warnings.push(message) },
  })
  assert.equal(result.via, 'sync')
  assert.equal(ran, 1, '被拒绝不是丢活的理由')
  assert.ok(warnings.some((line) => line.includes('改为本轮内同步执行')))
})
