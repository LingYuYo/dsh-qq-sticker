/**
 * 面板任务表：单飞 + 进度 + 最近结果（`GET /state` 的 `jobs` 字段就是它）。
 *
 * 为什么放内存不落盘：任务只在面板打开时才有意义，DSH 重启后"跑到一半"的任务
 * 也没法续跑（runner 的进度、模型调用全都丢了）。落盘只会让 UI 显示一堆假任务。
 *
 * 形状严格按 `sticker-ui-contract.md` §3：
 *   { id, kind, label, status, startedAt, endedAt,
 *     progress: { done, total, label }, result, error }
 *  · status: 'running' | 'done' | 'error'
 *  · progress.total === 0 表示「总量未知」（UI 走 indeterminate）
 *  · 每个 kind 同时只允许一个在跑（单飞）
 */
const DEFAULT_MAX_KEEP = 10

/** 生成任务 id：`job-` + 6 位十六进制（够短、够唯一，UI 直接显示）。 */
function nextJobId(seq) {
  return `job-${(seq >>> 0).toString(16).padStart(6, '0')}`
}

/**
 * 建任务表。
 *
 * @param {object} [options]
 * @param {(level:string, message:string)=>void} [options.log] 插件日志函数
 * @param {number} [options.maxKeep] 列表最多保留几条（默认 10）
 * @returns {{
 *   list: () => Array<object>,
 *   get: (id: string) => object | undefined,
 *   start: (kind: string, label: string, runner: (progress: Function) => any) => object,
 * }}
 */
export function createJobs({ log, maxKeep = DEFAULT_MAX_KEEP } = {}) {
  /** @type {Array<object>} 最近的任务，新在前 */
  const all = []
  /** @type {Map<string, object>} kind → 正在跑的任务 */
  const running = new Map()
  const keep = Number.isFinite(maxKeep) && maxKeep > 0 ? Math.floor(maxKeep) : DEFAULT_MAX_KEEP
  let seq = 0

  const note = (level, message) => {
    try { log?.(level, message) } catch { /* 日志失败不能影响任务本身 */ }
  }

  /** 对外只给快照：调用方拿到的是副本，改不到内部状态。 */
  const snapshot = (job) => ({
    id: job.id,
    kind: job.kind,
    label: job.label,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    progress: { done: job.progress.done, total: job.progress.total, label: job.progress.label },
    result: job.result,
    error: job.error,
  })

  const list = () => all.map(snapshot)

  const get = (id) => {
    const job = all.find((entry) => entry.id === id)
    return job ? snapshot(job) : undefined
  }

  /**
   * 超量时丢最旧的一条。
   * 正在跑的任务不丢（丢了 UI 看不到进度；真丢完了完成时也会补回列表，见 finish）。
   */
  const trim = () => {
    while (all.length > keep) {
      let index = all.length - 1
      while (index >= 0 && all[index].status === 'running') index--
      if (index < 0) return
      all.splice(index, 1)
    }
  }

  const finish = (job, status, result, error) => {
    job.status = status
    job.endedAt = Date.now()
    job.result = result ?? null
    job.error = error ?? null
    if (running.get(job.kind) === job) running.delete(job.kind)
    // 完了就把进度补满（total === 0 是"总量未知"，保持 0 让 UI 走 indeterminate）
    if (status === 'done' && job.progress.total > 0) job.progress.done = job.progress.total
    // 兜底：万一这期间被 trim 掉了，补回列表（新在前）
    if (!all.includes(job)) {
      all.unshift(job)
      trim()
    }
    if (status === 'error') note('warn', `任务失败：${job.kind} ${job.label} —— ${job.error}`)
    else note('debug', `任务完成：${job.kind} ${job.label}`)
  }

  /**
   * 启动一个任务。**不 await**：`Promise.resolve().then()` 排到微任务，
   * 保证 `/action` 立刻拿到 { ok: true, job }。
   *
   * @param {string} kind 动作名（同时用来做单飞键）
   * @param {string} label 给人看的名字
   * @param {(progress: (done?: number, total?: number, label?: string) => void) => any} runner
   * @returns {{ok:true, job:object} | {ok:false, reason:'already-running', job:object} | {ok:false, reason:string}}
   */
  const start = (kind, label, runner) => {
    const key = String(kind ?? '').trim()
    if (!key) return { ok: false, reason: '缺少任务 kind' }
    if (typeof runner !== 'function') return { ok: false, reason: '缺少任务实现' }

    const busy = running.get(key)
    if (busy) return { ok: false, reason: 'already-running', job: snapshot(busy) }

    const job = {
      id: nextJobId(++seq),
      kind: key,
      label: String(label ?? key),
      status: 'running',
      startedAt: Date.now(),
      endedAt: 0,
      progress: { done: 0, total: 0, label: '' },
      result: null,
      error: null,
    }
    running.set(key, job)
    all.unshift(job)
    trim()
    note('debug', `任务开始：${job.kind} ${job.label}`)

    /**
     * 进度回调：`progress(done, total, label)`。
     * 允许只传文字（collect 这类总量未知的任务）：`progress(0, 0, '正在收集…')`。
     */
    const progress = (done, total, text) => {
      if (typeof done === 'number' && Number.isFinite(done)) {
        job.progress.done = Math.max(0, Math.round(done))
      }
      if (typeof total === 'number' && Number.isFinite(total)) {
        job.progress.total = Math.max(0, Math.round(total))
      }
      if (typeof text === 'string') job.progress.label = text
    }

    Promise.resolve()
      .then(() => runner(progress))
      .then((value) => finish(job, 'done', value, null))
      .catch((error) => finish(job, 'error', null, String(error?.message ?? error)))

    return { ok: true, job: snapshot(job) }
  }

  return { list, get, start }
}
