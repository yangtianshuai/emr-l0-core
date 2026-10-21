import type { ActorKind } from '../server/actor-directory.ts';

export type { ActorKind };

export type Role = 'admin' | 'qc' | 'clinician' | 'viewer';

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  qc: '质控员',
  clinician: '医生',
  viewer: '只读',
};

export type Action =
  /** 改部署参数：模型接入 / 语音落位 / 签名后端 / 阅读授权源 / 接收方公钥目录 */
  | 'config.write'
  | 'config.read'
  | 'model.test'
  | 'sign.test'
  | 'pack.toggle'
  | 'audit.read'
  | 'doc.write'
  | 'doc.sign'
  | 'doc.export'
  /** 采纳或拒绝 AI 建议（AI 不得自己走这条路，由内核按 kind 再拦一次）  */
  | 'suggestion.review'
  | 'annotation.resolve'
  | 'qc.run'
  | 'consistency.run'
  | 'reading.grant'
  | 'workspace.reset'

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
  'workspace.reset': ['admin'],
  'user.write': ['admin'],
};

export interface Principal {
  actorId: string;
  kind: ActorKind;
  role: Role;
  tenant: string;
}

export const AUTH_ERRORS = {
  E_AUTH_REQUIRED: 'E_AUTH_REQUIRED',
  /** 会话存在但已过期（与"没登录"分开：否则医生刚登录就被说成没登录） */
  E_SESSION_EXPIRED: 'E_SESSION_EXPIRED',
  E_PERMISSION_DENIED: 'E_PERMISSION_DENIED',
  E_RATE_LIMITED: 'E_RATE_LIMITED',
} as const;

export type AuthErrorCode = (typeof AUTH_ERRORS)[keyof typeof AUTH_ERRORS];

export type AuthorizeResult =
  | { ok: true; role: Role }
  | { ok: false; code: typeof AUTH_ERRORS.E_PERMISSION_DENIED; message: string };

export function authorize(principal: Principal, action: Action): AuthorizeResult {
  const allowed = PERMISSIONS[action] as Role[] | undefined;
  if (!allowed || allowed.length === 0) {
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

export function rolesFor(action: Action): Role[] {
  return [...(PERMISSIONS[action] ?? [])];
}

/** 这个角色做得了这个动作吗（纯展示用；放行一律走 `authorize`） */
export function can(role: Role, action: Action): boolean {
  return (PERMISSIONS[action] ?? []).includes(role);
}
