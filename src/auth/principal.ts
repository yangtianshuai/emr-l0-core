// 身份与权限：把"能不能做这件事"从散落在各路由里的判断收成一个决策点。

import type { ActorKind } from '../server/actor-directory.ts';

export type { ActorKind };

export type Role = 'admin' | 'qc' | 'clinician' | 'viewer';

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  qc: '质控员',
  clinician: '医生',
  viewer: '只读',
};

/**
 * 动作清单 = 服务端真实的写入口/外呼入口，不是抽象分类。
 * 每个动作都必须能在服务端指出它保护的是哪一段代码（见 demo-server 的调用点）。
  */
export type Action =
  /** 改部署参数：模型接入 / 语音落位 / 签名后端 / 阅读授权源 / 接收方公钥目录 */
  | 'config.write'
  /** 读部署参数视图（不含密钥值） */
  | 'config.read'
  /** 外呼：测试模型连接（会消耗额度、会把配置发到外部地址） */
  | 'model.test'
  | 'sign.test'
  | 'pack.toggle'
  /** 读管理审计 */
  | 'audit.read'
  /** 写病历（录入、编辑、删段、导入） */
  | 'doc.write'
  /** 签章 / 解锁（解锁会让已签内容重新可改） */
  | 'doc.sign'
  /** 导出（OFD 归档 / 机读 / WS/T 500 共享文档） */
  | 'doc.export'
  /** 采纳或拒绝 AI 建议（AI 不得自己走这条路，由内核按 kind 再拦一次）  */
  | 'suggestion.review'
  /** 处置质控提示（接受 / 忽略 / 已处理） */
  | 'annotation.resolve'
  /** 跑质控扫描（会产生旁挂注解） */
  | 'qc.run'
  | 'consistency.run'
  /** 签发 / 撤销受控阅读授权（放行的是"谁能读患者数据"，最敏感的一类）  */
  | 'reading.grant'
  /**
   * 重置工作区：清空工作区、已落盘的旁挂数据与阅读授权登记。
   *
   * 它是唯一一个破坏性动作 —— 别的动作改的是"某一份病历"或"某个部署参数"，
   * 它改的是"这台机器上还有没有那些病历"。所以它单独成一个动作，而不是并进
   * `config.write`：并进去的话，"能改模型地址"就等于"能清空全部病历"，
   * 而这两件事的风险差着量级。
    */
  | 'workspace.reset'
  // 管理后台账号（新增 / 改角色 / 重设口令 / 停用 / 删除，以及查看账号清单）。
// 能改口令的人可以直接把自己变成别人，或给自己再发一把。两者都只给管理员，

  | 'user.write';

export const ACTION_LABELS: Record<Action, string> = {
  'config.write': '修改能力配置',
  'config.read': '查看能力配置',
  'model.test': '测试模型连接',
  'sign.test': '测试签名后端',
  'pack.toggle': '开关质控规则包',
  'audit.read': '查看管理审计',
  'doc.write': '修改病历内容',
  'doc.sign': '签章或解锁',
  'doc.export': '导出文书',
  'suggestion.review': '采纳或拒绝 AI 建议',
  'annotation.resolve': '处置质控提示',
  'qc.run': '运行质控',
  'consistency.run': '运行一致性检查',
  'reading.grant': '签发受控阅读授权',
  'workspace.reset': '重置工作区（清空已有病历）',
  'user.write': '管理后台账号',
};

/** 全部动作（供界面按同一张表渲染按钮状态；不用于放行判断，放行一律走 `authorize`）  */
export const ALL_ACTIONS = Object.keys(ACTION_LABELS) as Action[];

/**
 * 权限表：动作 → 允许的角色。
 *
 * 做成 `Record<Action, Role[]>`（而不是 `Partial`）是关键：新增动作时编译期就会要求
 * 你回答"谁能做"，只要那张表里没有它，`authorize` 就一律拒绝。
 * 写成可选表的话，漏掉的动作会默认对所有角色开放 —— 恰好是最危险的方向。
  */
const PERMISSIONS: Record<Action, Role[]> = {
  'config.write': ['admin'],
  'config.read': ['admin', 'qc', 'viewer'],
  'model.test': ['admin'],
  'sign.test': ['admin'],
  'pack.toggle': ['admin', 'qc'],
  'audit.read': ['admin', 'qc', 'viewer'],
  'doc.write': ['admin', 'clinician'],
  'doc.sign': ['admin', 'clinician'],
  'doc.export': ['admin', 'clinician'],
  'suggestion.review': ['admin', 'clinician'],
  'annotation.resolve': ['admin', 'clinician'],
  'qc.run': ['admin', 'clinician', 'qc'],
  'consistency.run': ['admin', 'clinician', 'qc'],
  'reading.grant': ['admin', 'clinician'],
  /* 只有管理员。医生不该能一键清空工作区：那会连带清掉别人尚未定稿的病历。
     这一条与 `doc.write` 的关键差别：写病历是"在已有内容上加一笔"，重置是"把所有人的笔迹都擦掉"。  */
  'workspace.reset': ['admin'],
  /* 只有管理员。查看清单与写账号用同一个动作：能给谁发钥匙与知道有哪些钥匙
     是同一件事的两面，而"只读清单"除了让人对着一个改不动的列表发呆之外没有用途。
     同理不给 `qc` / `viewer`：账号清单回答的是"谁能进来"，属于管理面而不是接入面。  */
  'user.write': ['admin'],
};

export interface Principal {
  actorId: string;
  kind: ActorKind;
  role: Role;
  tenant: string;
}

export const AUTH_ERRORS = {
  /** 没有会话，或会话 id 从未存在过 */
  E_AUTH_REQUIRED: 'E_AUTH_REQUIRED',
  /** 会话存在但已过期（与"没登录"分开：否则医生刚登录就被说成没登录） */
  E_SESSION_EXPIRED: 'E_SESSION_EXPIRED',
  /** 登录了，但这个角色不能做这个动作 */
  E_PERMISSION_DENIED: 'E_PERMISSION_DENIED',
  /** 触发限流 */
  E_RATE_LIMITED: 'E_RATE_LIMITED',
} as const;

export type AuthErrorCode = (typeof AUTH_ERRORS)[keyof typeof AUTH_ERRORS];

export type AuthorizeResult =
  | { ok: true; role: Role }
  | { ok: false; code: typeof AUTH_ERRORS.E_PERMISSION_DENIED; message: string };

/**
 * 唯一决策点。纯函数：给定身份与动作，判定允许/拒绝。
 *
 * 拒绝信息里带上"这个动作叫什么 + 当前角色是什么 + 哪些角色可以" —— 三者缺一不可：
 * 只说"无权限"，运维只能当成系统坏了；只说"需要管理员"，质控员会以为管理员能做所有事。
  */
export function authorize(principal: Principal, action: Action): AuthorizeResult {
  const allowed = PERMISSIONS[action] as Role[] | undefined;
  if (!allowed || allowed.length === 0) {
    /* 表里没有 = 拒绝（fail-closed）。这句话是给"新增动作忘了授权"的人看的 */
    return {
      ok: false,
      code: AUTH_ERRORS.E_PERMISSION_DENIED,
      message: `动作 ${action} 未在权限表中授权给任何角色，一律拒绝（fail-closed）`,
    };
  }
  if (!allowed.includes(principal.role)) {
    return {
      ok: false,
      code: AUTH_ERRORS.E_PERMISSION_DENIED,
      message:
        `当前角色「${ROLE_LABELS[principal.role]}」不能${ACTION_LABELS[action]}；` +
        `该动作允许的角色：${allowed.map((role) => ROLE_LABELS[role]).join(' / ')}`,
    };
  }
  return { ok: true, role: principal.role };
}

/** 某个动作允许哪些角色（供界面按钮的禁用/提示使用，不用于放行判断）  */
export function rolesFor(action: Action): Role[] {
  return [...(PERMISSIONS[action] ?? [])];
}

/** 这个角色做得了这个动作吗（纯展示用；放行一律走 `authorize`） */
export function can(role: Role, action: Action): boolean {
  return (PERMISSIONS[action] ?? []).includes(role);
}
