// 身份 / 权限 / 会话 / 限流 自测（A~C 共 24 条）。

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import {
  ACTION_LABELS,
  AUTH_ERRORS,
  ROLE_LABELS,
  authorize,
  can,
  rolesFor,
  type Action,
  type Principal,
  type Role,
} from './principal.ts';
import { SessionStore, fingerprintOf } from './session-store.ts';
import { SlidingWindowLimiter, type RateRule } from './rate-limit.ts';

const suite = new TestSuite('身份/权限/会话/限流自测', [
  '说明：全部为纯逻辑 + 注入时钟，不起服务；端到端拦截见 test:ui 的 B37。',
  'A 权限表（含 fail-closed 与"界面说能做就必须真能做"）· B 会话（寿命/续期/吊销/只存指纹）· C 限流（窗口滑动/被拒不延长窗口）',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

const ALL_ROLES: Role[] = ['admin', 'qc', 'clinician', 'viewer'];
const ALL_ACTIONS = Object.keys(ACTION_LABELS) as Action[];

function principal(role: Role, actorId = 'A-1', tenant = 'default'): Principal {
  return { actorId, kind: 'human', role, tenant };
}

async function main(): Promise<void> {

  await test('A1 允许方向：管理员改配置、医生写病历、质控员开关规则包', () => {
    assertEqual(authorize(principal('admin'), 'config.write').ok, true, '管理员应能改能力配置');
    assertEqual(authorize(principal('clinician'), 'doc.write').ok, true, '医生应能写病历');
    assertEqual(authorize(principal('qc'), 'pack.toggle').ok, true, '质控员应能开关规则包');
    assertEqual(authorize(principal('qc'), 'qc.run').ok, true, '质控员应能跑质控');
    assertEqual(authorize(principal('viewer'), 'audit.read').ok, true, '只读角色应能看审计');
  });

  await test('A2 拒绝方向：拒绝信息必须能回答"这个动作叫什么、我是什么角色、谁能做"', () => {
    const denied = authorize(principal('qc'), 'config.write');
    assertEqual(denied.ok, false, '质控员不得改能力配置');
    if (denied.ok) return;
    assertEqual(denied.code, AUTH_ERRORS.E_PERMISSION_DENIED, '应给出权限错误码');
    assert(denied.message.includes(ACTION_LABELS['config.write']), `信息里要有动作名，实际：${denied.message}`);
    assert(denied.message.includes(ROLE_LABELS.qc), `信息里要有当前角色，实际：${denied.message}`);
    assert(denied.message.includes(ROLE_LABELS.admin), `信息里要说明谁能做，实际：${denied.message}`);
  });

  await test('A3 fail-closed：权限表里没有的动作**一律拒绝**（新增动作忘了授权时的正确失败方向）', () => {
    const unknown = 'not.an.action' as Action;
    const denied = authorize(principal('admin'), unknown);
    assertEqual(denied.ok, false, '连管理员也不能做未授权的动作');
    if (!denied.ok) assert(denied.message.includes('fail-closed'), `应说明是 fail-closed，实际：${denied.message}`);
    /* 这一条同时验证了"表是 Record<Action, Role[]> 而不是 Partial"的意图：
       漏项不会变成"人人可做"。 */
    assertEqual(rolesFor(unknown).length, 0, '未授权动作的角色集合应为空');
  });

  await test('A4 界面口径与放行口径一致：`can()` 说能做的，`authorize()` 必须真放行（反向亦然）', () => {
    /* 界面按钮的禁用依据如果与放行判断是两套逻辑，必然出现
       "界面允许点、点了被拒"（或更糟：界面禁用但接口放行）。这里把它变成一条断言。 */
    for (const action of ALL_ACTIONS) {
      for (const role of ALL_ROLES) {
        assertEqual(
          can(role, action),
          authorize(principal(role), action).ok,
          `can 与 authorize 在 ${role} × ${action} 上不一致`,
        );
      }
    }
  });

  await test('A5 只读角色不得有任何写/外呼动作；医生不得改配置；质控员不得签章', () => {
    for (const action of ALL_ACTIONS) {
      if (action === 'audit.read' || action === 'config.read') continue;
      assertEqual(can('viewer', action), false, `只读角色不该能做 ${action}`);
    }
    assertEqual(can('clinician', 'config.write'), false, '医生不得改能力配置');
    assertEqual(can('clinician', 'model.test'), false, '医生不得外呼测试模型');
    assertEqual(can('qc', 'doc.sign'), false, '质控员不得签章');
    assertEqual(can('qc', 'reading.grant'), false, '质控员不得签发阅读授权（放行的是患者数据）');
    /* 每个动作至少有一个角色能做：否则它是一条永远拒绝的死规则，多半是漏了授权  */
    for (const action of ALL_ACTIONS) {
      assert(rolesFor(action).length >= 1, `动作 ${action} 没有任何角色可做（疑似漏授权）`);
    }
  });

  await test('B1 签发与认领：身份字段完整带回', () => {
    const store = new SessionStore({ ttlMs: 60_000 });
    const { id, record } = store.issue({ actorId: 'ADMIN', kind: 'human', role: 'admin', tenant: 'default', label: '管理员' });
    assertEqual(id.length, 64, '会话 id 应为 32 字节十六进制（256 位，不可猜）');
    assertEqual(record.expiresAt - record.createdAt, 60_000, '寿命应与构造参数一致');
    const resolved = store.resolve(id);
    assertEqual(resolved.ok, true, '刚签发的会话应可用');
    if (resolved.ok) {
      assertEqual(resolved.record.actorId, 'ADMIN', '身份应带回');
      assertEqual(resolved.record.role, 'admin', '角色应带回');
      assertEqual(resolved.record.tenant, 'default', '租户应带回');
    }
  });

  await test('B2 **只存指纹**：会话存储里没有 id 原文（内存泄露也无法复原凭证）', () => {
    const store = new SessionStore({ ttlMs: 60_000 });
    const { id } = store.issue({ actorId: 'A', kind: 'human', role: 'viewer', tenant: 'default' });
    const listed = store.list();
    assertEqual(listed.length, 1, '应有一条活跃会话');
    assertEqual(listed[0]?.fingerprint, fingerprintOf(id), '清单里给的是指纹');
    /* 最关键的一条：把整个清单序列化后，不得出现 id 原文 */
    assert(!JSON.stringify(listed).includes(id), '会话清单里不得出现会话 id 原文');
    assert(!JSON.stringify(store.list(true)).includes(id), '含过期记录的清单里同样不得出现 id 原文');
  });

  await test('B3 未知与空会话 id：一律 `E_AUTH_REQUIRED`（不猜、不降级）', () => {
    const store = new SessionStore({ ttlMs: 60_000 });
    assertEqual(store.resolve(null).ok, false, '空 id 不应通过');
    assertEqual(store.resolve('').ok, false, '空串不应通过');
    const unknown = store.resolve('f'.repeat(64));
    assertEqual(unknown.ok, false, '没签发过的 id 不应通过');
    if (!unknown.ok) assertEqual(unknown.code, AUTH_ERRORS.E_AUTH_REQUIRED, '应报"需要登录"');
  });

  await test('B4 到点即失效，且**与"没登录"分开报**（否则医生刚登录就被说成没登录）', () => {
    let clock = 1_000_000;
    /* 用 `sliding: false`：本用例要验的是"寿命到点就失效"这条硬规则，
       而滑动续期会把到期时刻往后推（那是 B5 的主题）—— 混在一起测不出任何一条。 */
    const store = new SessionStore({ ttlMs: 60_000, sliding: false, now: () => clock });
    const { id } = store.issue({ actorId: 'A', kind: 'human', role: 'clinician', tenant: 'default' });
    clock += 59_999;
    assertEqual(store.resolve(id).ok, true, '还差 1ms 时应仍有效');
    clock += 1;
    const expired = store.resolve(id);
    assertEqual(expired.ok, false, '到点即失效（不给宽限）');
    if (!expired.ok && expired.code === AUTH_ERRORS.E_SESSION_EXPIRED) {
      assertEqual(expired.expiredAt, 1_060_000, '应回报失效时刻（界面据此说清"多久没操作了"）');
    } else {
      assert(false, '应报"已过期"而不是"需要登录"');
    }
    /* 第二次请求仍要报"已过期"：过期记录不在这里删（删了就被说成"没登录"） */
    const again = store.resolve(id);
    assertEqual(again.ok, false, '仍然不可用');
    if (!again.ok) assertEqual(again.code, AUTH_ERRORS.E_SESSION_EXPIRED, '第二次仍应报"已过期"');
  });

  await test('B5 滑动续期：活跃会话续命；关闭滑动则按时失效（两种对照都验）', () => {
    let clock = 0;
    const sliding = new SessionStore({ ttlMs: 60_000, now: () => clock });
    const { id } = sliding.issue({ actorId: 'A', kind: 'human', role: 'clinician', tenant: 'default' });
    for (let i = 0; i < 3; i += 1) {
      clock += 30_000;
      assertEqual(sliding.resolve(id).ok, true, `第 ${i + 1} 次续期前应有效`);
    }
    /* 一共走了 90 秒 > 60 秒寿命：若没有滑动续期，这里早就失效了 */
    clock += 30_000;
    assertEqual(sliding.resolve(id).ok, true, '滑动模式下持续活跃的会话应一直可用');

    let fixedClock = 0;
    const fixed = new SessionStore({ ttlMs: 60_000, sliding: false, now: () => fixedClock });
    const second = fixed.issue({ actorId: 'A', kind: 'human', role: 'clinician', tenant: 'default' });
    fixedClock += 30_000;
    assertEqual(fixed.resolve(second.id).ok, true, '未到点应有效');
    fixedClock += 30_001;
    assertEqual(fixed.resolve(second.id).ok, false, '关闭滑动后，到点必须失效（不因活跃而无限续命）');
  });

  await test('B6 吊销：登出即失效且幂等；未知 id 不报错', () => {
    const store = new SessionStore({ ttlMs: 60_000 });
    const { id } = store.issue({ actorId: 'A', kind: 'human', role: 'viewer', tenant: 'default' });
    assertEqual(store.revoke(id), true, '应确实删掉了会话');
    assertEqual(store.resolve(id).ok, false, '吊销后立即不可用');
    assertEqual(store.revoke(id), false, '重复登出（或未知 id）应返回 false 而不抛错 —— 登出必须幂等');
  });

  await test('B7 踢掉某身份全部会话：只影响该身份（改口令/降权的处置）', () => {
    const store = new SessionStore({ ttlMs: 60_000 });
    const a1 = store.issue({ actorId: 'A', kind: 'human', role: 'clinician', tenant: 'default' });
    const a2 = store.issue({ actorId: 'A', kind: 'human', role: 'clinician', tenant: 'default' });
    const b1 = store.issue({ actorId: 'B', kind: 'human', role: 'clinician', tenant: 'default' });
    assertEqual(store.revokeAllFor('A'), 2, 'A 的两个会话都该被踢掉');
    assertEqual(store.resolve(a1.id).ok, false, 'A 的第 1 个会话应失效');
    assertEqual(store.resolve(a2.id).ok, false, 'A 的第 2 个会话应失效');
    assertEqual(store.resolve(b1.id).ok, true, '**不得误伤别的身份**');
    assertEqual(store.revokeAllFor('NOPE'), 0, '未知身份返回 0');
  });

  await test('B8 sweep：宽限期后才清理过期记录；size/清单默认不计过期', () => {
    let clock = 0;
    const store = new SessionStore({ ttlMs: 1_000, graceMs: 10_000, now: () => clock });
    store.issue({ actorId: 'A', kind: 'human', role: 'viewer', tenant: 'default' });
    clock += 2_000;
    assertEqual(store.size, 0, '过期后不再计入活跃会话');
    assertEqual(store.list().length, 0, '默认清单不列过期会话');
    assertEqual(store.list(true).length, 1, '含过期的清单仍能看到它（用于诊断）');
    assertEqual(store.sweep(), 0, '宽限期内不清理（还要能报"已过期"）');
    clock += 10_000;
    assertEqual(store.sweep(), 1, '过了宽限期应清掉');
    assertEqual(store.list(true).length, 0, '清掉之后彻底不见了');
  });

  await test('B9 记录上限：超出后不无限增长，且优先清过期、再清最旧', () => {
    let clock = 0;
    const store = new SessionStore({ ttlMs: 1_000, graceMs: 0, maxRecords: 3, now: () => clock });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      clock += 1;
      ids.push(store.issue({ actorId: `A${i}`, kind: 'human', role: 'viewer', tenant: 'default' }).id);
    }
    assertEqual(store.list(true).length, 3, '条数应被上限压住');
    assertEqual(store.resolve(ids[4] as string).ok, true, '最新的应当还在');
    assertEqual(store.resolve(ids[0] as string).ok, false, '最旧的应已按创建时刻清掉');
  });

  await test('B10 配置错误当场抛（寿命为 0 / 负数 / 非数）', () => {
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let threw = false;
      try {
        void new SessionStore({ ttlMs: ttl });
      } catch {
        threw = true;
      }
      assert(threw, `ttlMs=${String(ttl)} 应被拒绝：一个寿命无效的会话存储等于"永不过期"或"立刻失效"`);
    }
  });

  const LOGIN_RULE: RateRule = { limit: 3, windowMs: 60_000, label: '登录尝试' };

  await test('C1 前 limit 次通过，第 limit+1 次被拒，并给出可执行的重试间隔', () => {
    let clock = 0;
    const limiter = new SlidingWindowLimiter({ now: () => clock });
    for (let i = 1; i <= 3; i += 1) {
      const decision = limiter.hit('login:actor:A', LOGIN_RULE);
      assertEqual(decision.ok, true, `第 ${i} 次应通过`);
      if (decision.ok) assertEqual(decision.remaining, 3 - i, '剩余次数应递减');
    }
    const denied = limiter.hit('login:actor:A', LOGIN_RULE);
    assertEqual(denied.ok, false, '第 4 次应被拒');
    if (!denied.ok) {
      assertEqual(denied.code, AUTH_ERRORS.E_RATE_LIMITED, '应给出限流错误码');
      assert(denied.retryAfterSec >= 1, '重试间隔至少 1 秒（0 会让调用方立刻重试）');
      assert(denied.message.includes('登录尝试'), `信息里要有桶名，实际：${denied.message}`);
    }
  });

  await test('C2 键之间互不影响：A 被打满，不代表 B 也被限', () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < 3; i += 1) limiter.hit('login:actor:A', LOGIN_RULE);
    assertEqual(limiter.hit('login:actor:A', LOGIN_RULE).ok, false, 'A 应已被限');
    assertEqual(limiter.hit('login:actor:B', LOGIN_RULE).ok, true, 'B 不受影响');
    assertEqual(limiter.hit('login:src:host-1', LOGIN_RULE).ok, true, '按来源的那个桶也不受影响');
  });

  await test('C3 窗口滑动：出窗口即恢复（不是"整分钟清零"）', () => {
    let clock = 0;
    const limiter = new SlidingWindowLimiter({ now: () => clock });
    for (let i = 0; i < 3; i += 1) limiter.hit('k', LOGIN_RULE);
    assertEqual(limiter.hit('k', LOGIN_RULE).ok, false, '窗口内应被限');
    clock += 59_999;
    assertEqual(limiter.hit('k', LOGIN_RULE).ok, false, '窗口内（哪怕剩 1ms）仍被限');
    clock += 1;
    assertEqual(limiter.hit('k', LOGIN_RULE).ok, true, '越过窗口后应恢复');
  });

  await test('C4 **被拒的那次不进入窗口**：一直打不会把恢复时刻越推越远（自我延长封禁）', () => {
    let clock = 0;
    const limiter = new SlidingWindowLimiter({ now: () => clock });
    limiter.hit('k', LOGIN_RULE);
    /* 打满并持续尝试 50 秒（每 5 秒一次）——若被拒也记录，恢复时刻会被推到 50+60 秒 */
    for (let i = 0; i < 10; i += 1) {
      clock += 5_000;
      limiter.hit('k', LOGIN_RULE);
    }
    /* 第一次命中在 t=0，窗口 60s：到 t=60_000 必恢复 */
    clock = 60_000;
    assertEqual(limiter.hit('k', LOGIN_RULE).ok, true, '恢复时刻应只由第一次命中决定（被拒不延长封禁）');
  });

  await test('C5 peek 只判不记：提示"快到了"不该消耗额度', () => {
    const limiter = new SlidingWindowLimiter();
    const rule: RateRule = { limit: 2, windowMs: 60_000, label: '测试' };
    for (let i = 0; i < 10; i += 1) assertEqual(limiter.peek('k', rule).ok, true, `peek 第 ${i + 1} 次仍应通过`);
    assertEqual(limiter.hit('k', rule).ok, true, 'hit 才真正消耗：第 1 次');
    assertEqual(limiter.hit('k', rule).ok, true, '第 2 次');
    assertEqual(limiter.hit('k', rule).ok, false, '第 3 次被拒（说明前面 peek 确实没记账）');
  });

  await test('C6 reset：登录成功后应把该身份的失败计数清零', () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < 3; i += 1) limiter.hit('login:actor:A', LOGIN_RULE);
    assertEqual(limiter.hit('login:actor:A', LOGIN_RULE).ok, false, '前置：已被限');
    assertEqual(limiter.reset('login:actor:A'), true, '应确实清掉了键');
    assertEqual(limiter.hit('login:actor:A', LOGIN_RULE).ok, true, '清零后应恢复');
    assertEqual(limiter.reset('login:actor:A'), true, '再次清零');
    assertEqual(limiter.reset('login:actor:A'), false, '已不存在时返回 false（幂等）');
  });

  await test('C7 规则非法当场抛，且键数有上限（"每个来源一个键"不能变成内存耗尽）', () => {
    const limiter = new SlidingWindowLimiter({ maxKeys: 2 });
    for (const bad of [
      { limit: 0, windowMs: 1_000, label: '测试' },
      { limit: Number.NaN, windowMs: 1_000, label: '测试' },
      { limit: 1, windowMs: 0, label: '测试' },
      { limit: 1, windowMs: Number.NaN, label: '测试' },
    ] as RateRule[]) {
      let threw = false;
      try {
        limiter.hit('k', bad);
      } catch {
        threw = true;
      }
      assert(threw, `非法规则应被拒绝：${JSON.stringify(bad)}（静默放行等于没有限流）`);
    }
    for (let i = 0; i < 10; i += 1) limiter.hit(`k${i}`, LOGIN_RULE);
    assert(limiter.keyCount <= 2, `键数应被上限压住，实际 ${limiter.keyCount}`);
  });

  await test('C8 retryAfterSec 随等待递减，且恒 ≥ 1', () => {
    let clock = 10_000;
    const limiter = new SlidingWindowLimiter({ now: () => clock });
    for (let i = 0; i < 3; i += 1) limiter.hit('k', LOGIN_RULE);
    const first = limiter.hit('k', LOGIN_RULE);
    assertEqual(first.ok, false, '应被限');
    clock += 3_000;
    const later = limiter.hit('k', LOGIN_RULE);
    assertEqual(later.ok, false, '仍在窗口内');
    if (!first.ok && !later.ok) {
      assertEqual(first.retryAfterSec, 60, '首次被拒应回报 60 秒');
      assertEqual(later.retryAfterSec, 57, '过了 3 秒应只剩 57 秒');
    }
    clock += 60_000;
    const after = limiter.hit('k', LOGIN_RULE);
    assertEqual(after.ok, true, '窗口过后恢复');
  });

  process.exit(suite.report());
}

void main();
