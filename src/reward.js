/**
 * 互动结算 + 奖励记账。
 *
 * 一次发图之后 3 分钟回看群里的反应，把结果写回那张图：
 *   U = 说话的**不同群友**人数（排除机器人自己）
 *   M = 有效回复条数
 *   写回 interactShown / interactUsers / interactReplies → 影响下一次挑图
 *
 * 基础奖励 E 每 20 秒最多一次（防止连发几十张刷分）。
 *
 * 全部读本地窗口（tracker），不花 token。
 */
import { num } from './util.js'

/** 回看窗口：发图后等多久再结算。 */
export const INTERACT_WINDOW_MS = 3 * 60 * 1000
/** 待结算队列上限。 */
const PENDING_MAX = 60

/** 评分权重（与原插件一致；E 不参与选图，只记账）。 */
export const REWARD = { C: 0.10, E: 0.25, I: 0.25, N: 0.25, D: 0.15 }

/** 基础发送奖励的最小间隔。 */
const BASE_REWARD_MIN_GAP_MS = 20_000

/** 互动奖励的两个 0.125：人数满 3 人、回复满 5 条即满分。 */
const FULL_USERS = 3
const FULL_REPLIES = 5

/**
 * 结算器。
 *
 * @param {object} opts
 * @param {import('./library.js').Library} opts.library
 * @param {import('./tracker.js').SessionTracker} opts.tracker
 * @param {(level:string,message:string)=>void} [opts.log]
 */
export class RewardSettler {
  constructor({ library, tracker, log }) {
    this.library = library
    this.tracker = tracker
    this.log = log ?? (() => {})
    /** @type {Array<{sessionId:string, itemKey:string, at:number, baseGapOk:boolean, timer:any}>} */
    this.pending = []
    this.lastBaseRewardAt = 0
  }

  /**
   * 登记一次发送，3 分钟后自动结算。
   *
   * @param {object} opts
   * @param {string} opts.sessionId
   * @param {string} opts.itemKey
   * @param {number} [opts.now]
   */
  register({ sessionId, itemKey, now = Date.now() }) {
    if (!sessionId || !itemKey) return
    const baseGapOk = now - num(this.lastBaseRewardAt, 0) >= BASE_REWARD_MIN_GAP_MS
    if (baseGapOk) this.lastBaseRewardAt = now
    this.pending.push({ sessionId, itemKey, at: now, baseGapOk, timer: null })
    while (this.pending.length > PENDING_MAX) {
      const dropped = this.pending.shift()
      if (dropped?.timer) clearTimeout(dropped.timer)
    }
    const timer = setTimeout(() => {
      void this.settle(sessionId, itemKey, now)
    }, INTERACT_WINDOW_MS + 1000)
    timer.unref?.()
    const entry = this.pending[this.pending.length - 1]
    if (entry) entry.timer = timer
  }

  /**
   * 结算一张图（也允许手动触发：测试/工具用）。
   *
   * @param {string} sessionId
   * @param {string} itemKey
   * @param {number} sentAt
   * @returns {Promise<{ok:boolean, users?:number, replies?:number, reward?:number, reason?:string}>}
   */
  async settle(sessionId, itemKey, sentAt) {
    try {
      const idx = this.pending.findIndex((entry) => entry.sessionId === sessionId && entry.itemKey === itemKey)
      const entry = idx >= 0 ? this.pending.splice(idx, 1)[0] : { baseGapOk: true, at: sentAt, timer: null }
      if (entry?.timer) clearTimeout(entry.timer)

      const since = num(entry.at, sentAt) + 500 // 只要发出去之后的
      const reaction = this.tracker.reactionSince(sessionId, since)
      const item = this.library.items.find((row) => row.key === itemKey)
      if (!item) return { ok: false, reason: '这张图已经不在库里了' }

      item.interactShown = num(item.interactShown, 0) + 1
      item.interactUsers = num(item.interactUsers, 0) + Math.min(reaction.users, FULL_USERS)
      item.interactReplies = num(item.interactReplies, 0) + Math.min(reaction.replies, FULL_REPLIES)
      const reward = (entry.baseGapOk ? REWARD.E : 0) + interactionScore(reaction.users, reaction.replies)
      item.lastReward = Number(reward.toFixed(3))
      this.library.touch()
      this.log('debug', `互动结算 #${itemKey.slice(4, 14)}：回应人数 ${reaction.users}、回复 ${reaction.replies} 条 → 本轮奖励 ${item.lastReward}`)
      return { ok: true, users: reaction.users, replies: reaction.replies, reward: item.lastReward }
    } catch (error) {
      this.log('warn', `互动结算失败（不影响任何功能）：${error?.message ?? error}`)
      return { ok: false, reason: String(error?.message ?? error) }
    }
  }

  /** 卸载时清掉未结算的定时器（不写盘，下次发图重新计）。 */
  dispose() {
    for (const entry of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.pending.length = 0
  }

  snapshot() {
    return { pending: this.pending.length, lastBaseRewardAt: this.lastBaseRewardAt }
  }
}

/**
 * 互动奖励：0.125·min(U/3,1) + 0.125·min(M/5,1)，满分 0.25。
 * （与原插件同公式；改数值会破坏已被用户调过的排序手感。）
 */
export function interactionScore(users, replies) {
  const u = Math.min(1, Math.max(0, num(users, 0)) / FULL_USERS)
  const m = Math.min(1, Math.max(0, num(replies, 0)) / FULL_REPLIES)
  return 0.125 * u + 0.125 * m
}
