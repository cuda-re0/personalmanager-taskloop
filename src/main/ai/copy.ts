/**
 * AI 相关、**会直接显示在界面上**的句子，集中一处。
 *
 * 为什么要单独一个文件：04 §1.1 规定"界面文案必须先在表里登记，没有登记的串不许写进代码"，
 * 而 AI 这四个码（AI_NOT_CONFIGURED / AI_UPSTREAM_ERROR / AI_RATE_LIMITED / AI_PARSE_FAILED）
 * 在 04 §1.1 里还没有行。本轮 04 不在授权范围内（开工词 §3），所以先把它们收在这里，
 * 交付报告里逐条列出，由架构方补登记——**散落在代码里就再也收不回来了**。
 *
 * 写句子的口径（04 §1）：一句话、说清"发生了什么 + 用户能做什么"，不写"哎呀""抱歉"，
 * 不写技术细节（HTTP 状态码、finish_reason 只进 detail 与日志）。
 */
export const AI_COPY = {
  /** AI_NOT_CONFIGURED：没配 Key，重试也没用 → retryable: false */
  notConfigured: '模型 Key 还没配置',
  /** AI_UPSTREAM_ERROR：网络/5xx/超时，等一会儿可能就好 → retryable: true */
  upstream: '模型服务暂时没有响应，稍后再试',
  /** AI_RATE_LIMITED：限流 → retryable: true */
  rateLimited: '模型调用太频繁，稍后再试',
  /** AI_PARSE_FAILED：拿到回复但读不懂 → retryable: true（用户点重试有意义） */
  parseFailed: '这次没读懂模型的回复，再试一次',
  /** 硬闸门命中时审核卡的 reason 行（followup 会盖在 reason 位置上显示，04 §3.3） */
  needEvidenceReason: '还没有看到能证明完成的凭据',
  /** 硬闸门命中时的追问。不指定具体要什么文件，因为不同任务要的东西不一样 */
  needEvidenceFollowup: '发一张截图或文件，我按它判',
  /** 一次超过 4 张图时拼在 reply 末尾（开工词 §4.6：丢掉多的、在 reply 里说明，不报错） */
  imagesDropped: '（一次最多看 4 张图，多出来的没看）'
} as const
