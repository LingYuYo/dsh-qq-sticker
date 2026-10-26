/**
 * 原始图标记（`[[qqimg:<token>]]`）的解析与对齐。
 *
 * **为什么这条链路存在**：DSH 的附件服务 `@deepseek-ai/dsh-attachment-local`
 * 会对每张图做归一化，而 `canPassThroughNormalization()` 对 `image/gif` 或
 * `animated` 一律返回 false —— 于是 GIF 被重编码成**单帧** webp/jpeg。
 * 实测：一张 240×240 / 105 帧 / 1.2MB 的 GIF，经 DSH 附件后只剩 7KB 单帧。
 *
 * 桥接进程本来就下载到了**原始 Buffer**，它把字节 POST 到
 * `/dsh-qq-sticker/raw-image`（插件存进"原始图池"），同时在发给 DSH 的 prompt
 * 文本块里按图片顺序追加 `[[qqimg:<token>]]` 标记。
 *
 * 插件收到消息时，就是靠这里把"文本里 token 的顺序"映射到"image 块出现的顺序"，
 * 给每个 attachment 挂上 `rawToken` —— 之后 `readImageBytes` 见到 rawToken
 * 就优先取原始字节（GIF 的帧全在），取不到才回落到 DSH 附件。
 *
 * ⚠️ 实时收图（index.js 的 session/event）与回扫收图（collect.js）**必须用同一套
 * 对齐规则**。否则同一张图"实时收是动图、回扫收是静图"，用户会看到随机行为。
 * 所以逻辑统一放在这个文件里，两处都 import 它。
 */

/** 标记正则：token 是 8~64 位 `[A-Za-z0-9_-]`（与 rawstore 的白名单一致）。 */
const TOKEN_RE = /\[\[qqimg:([A-Za-z0-9_-]{8,64})\]\]/g

/** 从文本里按出现顺序抠出所有 token。 */
export function tokensInText(text) {
  const out = []
  if (!text) return out
  TOKEN_RE.lastIndex = 0
  let match
  const raw = String(text)
  while ((match = TOKEN_RE.exec(raw)) !== null) out.push(match[1])
  return out
}

/** 把标记从正文里去掉（给模型/人看的文本不该带它）。 */
export function stripTokens(text) {
  return String(text ?? '').replace(/\[\[qqimg:[A-Za-z0-9_-]{8,64}\]\]\s*/g, '').trim()
}

/**
 * 把文本里的标记按顺序挂到 image 块的 attachment.rawToken 上。
 *
 * ⚠️ **不能原地改**（2026-10-26 真机踩过）：
 *   DSH 里 `session.deriveMessages()` 返回的消息/content/attachment 都是
 *   **冻结对象**（Object.freeze），直接 `attachment.rawToken = x` 会抛
 *   `Cannot add property rawToken, object is not extensible`，整条收集直接失败。
 *   所以这里一律**复制**出新的数组与对象再挂字段。
 *
 * 只挂**池子里真实存在**的 token（过期的、伪造的都跳过），这样：
 *   · 桥接转交失败（超时/404）时，标记留着也挂不上 → 自动回落 DSH 附件；
 *   · 池子清理过期的条目后，旧消息里的死标记不会造成误取。
 *
 * 对齐规则：第 k 个有效 token → 第 k 个 image 块。桥接侧保证了只发**成功前缀**
 * （第 k 张转交失败就截断，不留后面的），所以这个顺序是安全的。
 *
 * @param {Array<object>} content 消息 content blocks（可能是冻结的）
 * @param {{peek:(token:string)=>object|null}} [store] 原始图池
 * @returns {{content:Array<object>, attached:number}} 新 content（不保证与原引用相同）与挂上的张数
 */
export function attachRawTokens(content, store) {
  if (!Array.isArray(content) || !store || typeof store.peek !== 'function') {
    return { content, attached: 0 }
  }
  const tokens = []
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    for (const token of tokensInText(block.text)) {
      // 只认真实存在的（过期的、伪造的都跳过）
      if (store.peek(token)) tokens.push(token)
    }
  }
  if (tokens.length === 0) return { content, attached: 0 }

  let index = 0
  let attached = 0
  // 逐块复制：只给命中的 image 块造新 attachment，其它块原样透传
  const next = content.map((block) => {
    if (block?.type !== 'image' || !block.attachment) return block
    if (index >= tokens.length) return block
    const token = tokens[index++]
    attached++
    return { ...block, attachment: { ...block.attachment, rawToken: token } }
  })
  return { content: next, attached }
}

/** 从 attachment 上取桥接给的原始图 token。 */
export function pickRawToken(ref) {
  const direct = String(ref?.rawToken ?? '').trim()
  if (direct) return direct
  // 兜底：某些实现把 token 直接塞进 attachmentId（不走标准 ref 时）
  const id = String(ref?.attachmentId ?? '')
  return id.startsWith('raw:') ? id.slice(4) : undefined
}
