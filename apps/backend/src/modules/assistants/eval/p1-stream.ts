/**
 * The P1 evaluation stream (#692, Task 10): 40 synthetic member messages in
 * a three-person team workspace, each labelled with what the Router is
 * expected to do with it. Not used by production code or CI; `run.ts`
 * posts it against a local stack with the real `chat-default` model.
 *
 * - 12 explicit requests: each should get its own ticket (`create_ticket`).
 * - 8 follow-ups / additions to an earlier request: each should be routed
 *   to that request's ticket (`route_to_ticket`, `target` names it).
 * - 4 cancellations of an earlier request: also routed to that request's
 *   ticket, so its worker can drop it (P1 has no separate cancel action).
 * - 16 chatter / thanks / talk between colleagues: `ignore`.
 *
 * Messages are posted phase by phase. Within a phase every message is
 * posted at once (one member sending two in a phase lands in one batch);
 * the next phase starts only once the assistant is idle again, so a
 * follow-up always comes after the ticket it refers to exists. Every
 * follow-up and cancellation is sent by the member who made the request:
 * P1 batches per payer, and the Router's related-ticket list puts the
 * sender's own tickets first.
 */

export type P1Member = "lin" | "zhou" | "chen";

/** Display names; `lin` is the organization owner and the steward. */
export const P1_MEMBERS: Record<P1Member, { name: string; role: "owner" | "member" }> = {
  lin: { name: "Lin", role: "owner" },
  zhou: { name: "Zhou", role: "member" },
  chen: { name: "Chen", role: "member" },
};

export type P1Kind = "request" | "followup" | "cancel" | "chatter";

export type P1Message = {
  /** Stable key, also used to build the message's idempotency key. */
  key: string;
  member: P1Member;
  kind: P1Kind;
  /** For a follow-up or a cancellation: the request it refers to. */
  target?: string;
  text: string;
};

/** What the Router should do with each kind. */
export const P1_EXPECTED_ACTION: Record<P1Kind, "create_ticket" | "route_to_ticket" | "ignore"> = {
  request: "create_ticket",
  followup: "route_to_ticket",
  cancel: "route_to_ticket",
  chatter: "ignore",
};

export const P1_PHASES: P1Message[][] = [
  [
    { key: "R1", member: "lin", kind: "request", text: "帮我把这周所有客户反馈整理成一份摘要，按产品模块分类，周五前给我。" },
    { key: "R2", member: "zhou", kind: "request", text: "Please draft release notes for v2.3 based on the merged PRs since the last release." },
    { key: "H1", member: "chen", kind: "chatter", text: "大家早上好！" },
  ],
  [
    { key: "H2", member: "lin", kind: "chatter", text: "谢谢！" },
    { key: "R3", member: "zhou", kind: "request", text: "帮我查一下上个月的云服务账单，列出费用最高的 5 个服务。" },
    { key: "R4", member: "chen", kind: "request", text: "能不能写一份新员工入职清单？包括开账号、权限申请和第一周的安排。" },
  ],
  [
    { key: "F1", member: "lin", kind: "followup", target: "R1", text: "客户反馈摘要那个，再把移动端的反馈单独拎出来写一节。" },
    { key: "H3", member: "zhou", kind: "chatter", text: "@Chen 你下午的会还开吗？" },
    { key: "R5", member: "chen", kind: "request", text: "整理一下竞品 A 和竞品 B 最近三个月发布的新功能，做个对比表。" },
  ],
  [
    { key: "R6", member: "lin", kind: "request", text: "Can you prepare an agenda for Thursday's quarterly planning meeting? Include a review of last quarter's OKRs." },
    { key: "F2", member: "zhou", kind: "followup", target: "R2", text: "For the v2.3 release notes, please also call out the breaking change in the auth API." },
    { key: "H4", member: "chen", kind: "chatter", text: "收到，辛苦了" },
  ],
  [
    { key: "H5", member: "lin", kind: "chatter", text: "Thanks, that looks great." },
    { key: "R7", member: "zhou", kind: "request", text: "帮我把客服知识库里过时的退款政策文章找出来，列个清单。" },
    { key: "R8", member: "chen", kind: "request", text: "请把昨天用户访谈的要点整理成文档，重点标出和付费意愿相关的内容。" },
  ],
  [
    { key: "R9", member: "lin", kind: "request", text: "写一封给合作方的邮件草稿，说明我们的 API 限流策略下个月会调整。" },
    { key: "F3", member: "zhou", kind: "followup", target: "R3", text: "云账单那个，顺便和前一个月对比一下涨幅。" },
    { key: "F4", member: "chen", kind: "followup", target: "R4", text: "入职清单里再加上安全培训和 VPN 配置这两项。" },
  ],
  [
    { key: "H8", member: "lin", kind: "chatter", text: "我下午请假，有事微信找我。" },
    { key: "H6", member: "zhou", kind: "chatter", text: "今天中午吃什么？" },
    { key: "H7", member: "chen", kind: "chatter", text: "哈哈哈 这个表情包太好笑了" },
  ],
  [
    { key: "F6", member: "lin", kind: "followup", target: "R6", text: "Quarterly planning agenda: please add a 15-minute slot for hiring updates." },
    { key: "R10", member: "zhou", kind: "request", text: "Summarize the open bugs tagged 'payment' and rank them by severity." },
    { key: "X1", member: "chen", kind: "cancel", target: "R8", text: "用户访谈要点那个先不用做了，产品经理已经整理好了。" },
  ],
  [
    { key: "H11", member: "lin", kind: "chatter", text: "周五团建大家记得报名哦" },
    { key: "X2", member: "zhou", kind: "cancel", target: "R7", text: "退款政策文章的清单不需要了，法务那边会统一处理，取消吧。" },
    { key: "F5", member: "chen", kind: "followup", target: "R5", text: "竞品对比表再加一列定价变化。" },
  ],
  [
    { key: "F8", member: "lin", kind: "followup", target: "R9", text: "API 限流那封邮件草稿，语气再正式一些，并写上新的限额：每分钟 600 次。" },
    { key: "H9", member: "zhou", kind: "chatter", text: "ok" },
    { key: "R11", member: "chen", kind: "request", text: "帮我做一个下季度招聘计划的预算表，前端 2 人、后端 3 人。" },
  ],
  [
    { key: "R12", member: "lin", kind: "request", text: "调研一下主流工单系统（比如 Zendesk、Freshdesk）的定价，出一份对比。" },
    { key: "F7", member: "zhou", kind: "followup", target: "R10", text: "payment bugs 那个列表，只看最近 30 天新开的就行。" },
    { key: "H10", member: "chen", kind: "chatter", text: "Good job everyone on yesterday's launch!" },
  ],
  [
    { key: "H14", member: "lin", kind: "chatter", text: "Is anyone else seeing the coffee machine on floor 3 broken again?" },
    { key: "H12", member: "zhou", kind: "chatter", text: "+1" },
    { key: "H13", member: "chen", kind: "chatter", text: "刚才网络断了一下，现在好了" },
  ],
  [
    { key: "X3", member: "lin", kind: "cancel", target: "R12", text: "Cancel the ticketing-system pricing research, we've decided to stay with our current tool." },
    { key: "H15", member: "zhou", kind: "chatter", text: "好的明白" },
    { key: "X4", member: "chen", kind: "cancel", target: "R11", text: "招聘预算表先停掉吧，预算冻结了。" },
    { key: "H16", member: "chen", kind: "chatter", text: "谢谢助理！" },
  ],
];

export const P1_STREAM: P1Message[] = P1_PHASES.flat();
