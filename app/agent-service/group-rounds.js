"use strict";

// 群聊轮次规则（纯函数，不读写存储）：群主先答，一个接一个说，回复里 @ 了谁，谁就插到下一位。
// 参考 DeepSeek-Bot 的群聊设计（docs/architecture/group-room-single-mechanism-2026-10-17.md）。

const ROUND_LIMITS = Object.freeze({
  // 无论被普通成员还是群主叫，被叫者本轮最多说 10 次（包含开场与已发言次数）。
  memberCallCap: 10,
  ownerCallCap: 10,
  // 每位开场成员提供 10 个总回合额度；用户中途新增的开场位也按此补额度。
  turnsPerOpeningSpeaker: 10,
  // 让位后才交回的结果会请派活者回应；用户下次发言前最多这样接话 10 次。
  lateRounds: 10,
});

const byPosition = (a, b) => a.position - b.position;
const available = (member, cards) => member.state === "active" && cards?.get?.(member.id)?.availability !== "offline";

/**
 * 群主：群里指定的群主可用就是它；离线时顺延给名单里下一位可用成员（不改群设置）。
 * @param {{ownerMemberId?: string|null}} group
 * @param {object[]} members 全部成员（含已移出）
 * @param {Map<string, object>} cards 成员卡（availability）
 */
function currentOwner(group, members, cards) {
  const active = members.filter(member => member.state === "active").sort(byPosition);
  const configured = active.find(member => member.id === group.ownerMemberId);
  const ordered = configured
    ? [configured, ...active.filter(member => member.position > configured.position),
      ...active.filter(member => member.position < configured.position)]
    : active;
  return ordered.find(member => available(member, cards)) ?? configured ?? ordered[0] ?? null;
}

/** 建群时的默认群主：内置 Shoggoth 在群里就是它，否则名单第一位。 */
function defaultOwner(members, primaryProfileId) {
  const active = members.filter(member => member.state === "active").sort(byPosition);
  return active.find(member => member.backendId === "shoggoth" && !member.peerId && member.profileId === primaryProfileId)
    ?? active[0] ?? null;
}

/**
 * 一条消息由谁开口（按顺序）。
 * - 用户：@ 了谁就是谁；@all 是全员（群主第一）；普通消息只给群主。
 * - 成员让位后交回的结果（late）：回复里 @ 了谁就是谁，否则由派活者回应；用户自己派的活没人接话。
 * @param {{ active: object[], ownerId: string|null, author: {kind: string, memberId?: string},
 *   mentionIds?: string[], broadcast?: boolean, late?: boolean, calledBy?: string|null }} input
 * @returns {string[]} memberId 列表
 */
function openingSpeakers({ active, ownerId, author, mentionIds = [], broadcast = false, late = false, calledBy = null }) {
  const roster = [...active].sort(byPosition);
  const others = roster.filter(member => member.id !== author.memberId);
  const ids = new Set(others.map(member => member.id));
  const named = [...new Set(mentionIds)].filter(id => ids.has(id));
  const everyone = () => {
    const owner = others.find(member => member.id === ownerId);
    return [...(owner ? [owner.id] : []), ...others.filter(member => member !== owner).map(member => member.id)];
  };
  if (late) return named.length ? named : calledBy && ids.has(calledBy) ? [calledBy] : [];
  // 只有用户和群主的 @all 叫全员，防止成员一下叫起所有人。
  const canBroadcast = author.kind === "user" || author.memberId === ownerId;
  if (broadcast && canBroadcast) return everyone();
  if (named.length) return named;
  if (author.kind !== "user") return [];
  return ownerId && ids.has(ownerId) ? [ownerId] : everyone();
}

/**
 * 回复里叫了别人：把被叫者插到当前位置之后；已经在后面排队的提前。
 * @param {{key: string|null, memberId: string, waiting: boolean}[]} order 本轮发言顺序
 * @param {number} index 当前发言者的位置
 * @param {string[]} calleeIds 被叫者（按出现顺序，不含发言者本人）
 * @param {(memberId: string) => number} turnsOf 被叫者本轮已经轮到的次数
 * @param {number} cap 本次叫人的上限（memberCallCap / ownerCallCap）
 * @returns {{order: object[], added: string[], moved: string[]}} 新顺序（新插入的位置 key 为 null）、
 *   新插入的成员、被提前的已有位置 key
 */
function insertCalls(order, index, calleeIds, turnsOf, cap) {
  const next = [...order];
  const added = [];
  const moved = [];
  let at = index + 1;
  for (const memberId of calleeIds) {
    if (turnsOf(memberId) >= cap) continue;
    const waiting = next.findIndex((slot, position) => position > index && slot.memberId === memberId && slot.waiting);
    const slot = waiting === -1 ? { key: null, memberId, waiting: true } : next.splice(waiting, 1)[0];
    if (waiting === -1) added.push(memberId);
    else moved.push(slot.key);
    next.splice(at, 0, slot);
    at += 1;
  }
  return { order: next, added, moved };
}

module.exports = { ROUND_LIMITS, currentOwner, defaultOwner, insertCalls, openingSpeakers };
