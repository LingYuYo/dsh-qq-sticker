/**
 * schemastery 的加载垫片。
 *
 * 为什么不做静态 import '@deepseek-ai/schemastery'：
 *  · Host 运行时能解析到它（DSH 自己的模块图里有），但有两条路径：
 *    ① 从 `@deepseek-ai/dsh-tools` 的依赖树；
 *    ② 插件被安装到 profile 后，profile 根 node_modules 里有它（qq-guard 就是这么声明的）。
 *  · 离线测试（纯 node，没有 DSH）里它不存在 —— 静态 import 会把整套测试带崩。
 *
 * 所以：优先真包；拿不到就用一个**只够用**的内建 DSL 兜底（本插件只用到
 * object/string/number/boolean/array/dict/union/any + description/default/min/max/volatile/required/role）。
 * 兜底编出来的"Schema 对象"只用于离线测试读取默认值，不进真机。
 */
let Schema
/** 用的是真包还是兜底（真机上应该是 true；false 说明依赖没装上，设置页会失效）。 */
export let schemaIsReal = false

try {
  const mod = await import('@deepseek-ai/schemastery')
  Schema = mod?.default ?? mod
  schemaIsReal = typeof Schema?.object === 'function'
} catch {
  Schema = makeFallbackSchema()
  schemaIsReal = false
}

if (!schemaIsReal) {
  // 兜底只够跑离线测试：它没有 meta/投影能力，真机上如果走到这里，
  // 插件配置表单会是空的（而且不报错）。所以必须在日志里喊出来。
  console.warn(
    '[dsh-qq-sticker] 没找到 @deepseek-ai/schemastery，正在用兜底 Schema：'
    + '离线测试没问题，但真机上的设置页会失效。请确认插件依赖已安装（pnpm install）。',
  )
}

/**
 * 离线兜底：链式 API 的子集实现。
 *
 * 它不校验、不响应式、不投影表单 —— 只保证 `Config` 能被构造成一棵普通的树，
 * 让测试能读 `description`/`default` 并验证"Schema 与 DEFAULTS 一致"。
 */
function makeFallbackSchema() {
  const chain = (meta) => {
    const api = {
      description(text) { meta.description = text; return api },
      hint(text) { meta.hint = text; return api },
      default(value) { meta.default = value; return api },
      min(value) { meta.minimum = value; return api },
      max(value) { meta.maximum = value; return api },
      required(value = true) { meta.required = value !== false; return api },
      role(kind) { meta.role = kind; return api },
      volatile() { meta.volatile = true; return api },
      secret() { meta.secret = true; return api },
      /** 兜底把树形结构挂到 meta 上，测试/代码可以读。 */
      _meta: meta,
    }
    return api
  }
  const make = (type, extra = {}) => {
    const meta = { type, ...extra }
    return chain(meta)
  }
  const Schema = {
    object(shape) {
      const node = make('object', { items: shape })
      return node
    },
    string() { return make('string') },
    number() { return make('number') },
    boolean() { return make('boolean') },
    any() { return make('any') },
    array(inner) { return make('array', { inner }) },
    dict(inner) { return make('dict', { inner }) },
    union(values) { return make('union', { values }) },
    intersect(list) { return make('intersect', { list }) },
  }
  return { default: Schema, ...Schema }
}

export { Schema }
