/**
 * 预问诊单（患者候诊时自填）—— **只采集、只搬运，不做任何判断**。
 *
 * ## 它为什么合规压力最小
 *
 * 它产出的东西里没有一句是"判断"：没有诊断、没有处理建议、没有解释。
 * 患者写"胸口闷三天"，系统就只把这句话原样搬到现病史的候选建议里。
 * 任何"可能是什么病"的语义推导都不在这里发生 —— 那属于医生的职责，
 * 也属于要单独论证、单独门控的能力（见 `ai/` 与 `qc/` 的边界说明）。
 *
 * ## 三条不许越界
 *
 * 1) **不改写**：原文一字不动。"患者自述'有点喘不上气'"不能被润色成"呼吸困难"——
 *    那是把患者的话换成术语，而换完之后就分不清哪句是他说的了。
 * 2) **不猜落点**：预问诊只填"主诉 / 现病史 / 既往史 / 过敏史 / 用药 / 家族史"这六项，
 *    对应章节在本次文书里不存在时，如实报"缺章节"，不往相近的章节里塞。
 *    诊断章**永远不在映射表里**：那是医生的判断，不是患者的自述。
 * 3) **不落笔**：这里只产出"候选建议"（带来源与采集时刻），
 *    写进正文一律走建议通道由医生逐条采纳。
 *
 * ## 为什么来源要单独占一档（`EvidenceKind = 'patient'`）
 *
 * 混进 `user-input` 就再也答不了"这句是患者说的还是医生打的" ——
 * 而这恰恰是这类内容最需要回答的问题（出了争议，先要能分清谁说的）。
 */

import type { EvidenceRef, NodeId } from '../model/types.ts';

/* ------------------------------ 数据结构 ------------------------------ */

export interface PrevisitItem {
  /** 字段键（见 `PREVISIT_KEYS`） */
  key: string;
  /** 给人看的名字（缺省取 `PREVISIT_LABELS`） */
  label: string;
  /** 患者填的原文，**不改写** */
  text: string;
  /** 这一项的采集时刻（ISO8601） */
  reportedAt: string;
}

export interface PrevisitRecord {
  patientId: string;
  /** 绑定到某次就诊；不绑也能存（候诊时就诊可能还没建） */
  visitId?: string;
  /** 整份表单的到达时间 */
  submittedAt: string;
  /** 来源：`his-previsit` / `patient-portal` / `manual` …（如实写，不猜） */
  source: string;
  items: PrevisitItem[];
}

/* ------------------------------ 字段与落点 ------------------------------ */

/**
 * 允许的字段。**这是个白名单**：接口收到白名单外的 key 一律拒，
 * 不静默丢弃 —— 丢了等于"患者说的那句话没到"，而现场看不出来。
 */
export const PREVISIT_KEYS = ['chiefComplaint', 'presentIllness', 'pastHistory', 'allergy', 'medication', 'familyHistory'] as const;

export const PREVISIT_LABELS: Record<string, string> = {
  chiefComplaint: '主诉',
  presentIllness: '现病史',
  pastHistory: '既往史',
  allergy: '过敏史',
  medication: '用药',
  familyHistory: '家族史',
};

/**
 * 字段 → 目标章节 code。
 *
 * 过敏史 / 家族史 / 用药在门诊模板里没有独立章节，分别落到既往史与诊疗计划 ——
 * 这是**明示的近似**：落到既往史的那句仍然是原文，且带采集时刻与"患者自填"来源，
 * 医生一眼能看出它是患者说的。真正不能做的是"落到看似相关的别处还不说"。
 */
export const PREVISIT_SECTION: Record<string, string> = {
  chiefComplaint: 'chiefComplaint',
  presentIllness: 'presentIllness',
  pastHistory: 'pastHistory',
  allergy: 'pastHistory',
  medication: 'plan',
  familyHistory: 'pastHistory',
};

/** 单条文本上限：预问诊不是作文，超长输入更可能是误粘贴（如实拒掉，不截断） */
export const MAX_ITEM_CHARS = 2000;
/** 一次提交的条目上限 */
export const MAX_ITEMS = 32;

/* ------------------------------- 入参校验 ------------------------------- */

export interface IntakeRejected {
  ok: false;
  code: string;
  message: string;
}

export interface IntakeAccepted {
  ok: true;
  record: PrevisitRecord;
}

const isTime = (value: string): boolean => !Number.isNaN(Date.parse(value));

/**
 * 规范化接口入参。
 *
 * 每一种拒法都有自己的码：外部系统接进来时，"哪一条不合规"必须能直接说出来，
 * 否则对方只能靠猜（而猜的结果通常是"整批重发"，把已经对的那几条也弄乱了）。
 */
export function parsePrevisitIntake(input: unknown, now: string): IntakeAccepted | IntakeRejected {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'E_PREVISIT_BAD_BODY', message: '请求体必须是对象：{ patientId, visitId?, source?, items: [...] }' };
  }
  const body = input as Record<string, unknown>;
  const patientId = typeof body.patientId === 'string' ? body.patientId.trim() : '';
  if (patientId === '') return { ok: false, code: 'E_PREVISIT_NO_PATIENT', message: 'patientId 必填' };

  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, code: 'E_PREVISIT_NO_ITEMS', message: 'items 必须是非空数组（没有任何内容就没有可写的）' };
  }
  if (rawItems.length > MAX_ITEMS) {
    return { ok: false, code: 'E_PREVISIT_TOO_MANY', message: `items 最多 ${MAX_ITEMS} 条，收到 ${rawItems.length} 条` };
  }

  const allowed = new Set<string>(PREVISIT_KEYS);
  const seen = new Set<string>();
  const items: PrevisitItem[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const raw = rawItems[index];
    const position = index + 1;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, code: 'E_PREVISIT_BAD_ITEM', message: `第 ${position} 条不是对象` };
    }
    const item = raw as Record<string, unknown>;
    const key = typeof item.key === 'string' ? item.key.trim() : '';
    if (!allowed.has(key)) {
      return {
        ok: false,
        code: 'E_PREVISIT_UNKNOWN_KEY',
        message: `第 ${position} 条的 key「${key}」不在允许范围内（${PREVISIT_KEYS.join(' / ')}）`,
      };
    }
    if (seen.has(key)) {
      return { ok: false, code: 'E_PREVISIT_DUPLICATE_KEY', message: `第 ${position} 条的 key「${key}」重复：同一个字段只能有一条` };
    }
    seen.add(key);

    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text === '') {
      return { ok: false, code: 'E_PREVISIT_EMPTY_TEXT', message: `第 ${position} 条（${key}）的 text 为空` };
    }
    if (text.length > MAX_ITEM_CHARS) {
      return {
        ok: false,
        code: 'E_PREVISIT_TEXT_TOO_LONG',
        message: `第 ${position} 条（${key}）超过 ${MAX_ITEM_CHARS} 字（收到 ${text.length} 字）：如实拒掉，不替你截断`,
      };
    }

    const reportedAt = typeof item.reportedAt === 'string' && item.reportedAt.trim() !== '' ? item.reportedAt.trim() : now;
    if (!isTime(reportedAt)) {
      return { ok: false, code: 'E_PREVISIT_BAD_TIME', message: `第 ${position} 条的 reportedAt 不是可解析的时间：${reportedAt}` };
    }

    const label = typeof item.label === 'string' && item.label.trim() !== ''
      ? item.label.trim()
      : (PREVISIT_LABELS[key] ?? key);

    items.push({ key, label, text, reportedAt });
  }

  const visitId = typeof body.visitId === 'string' && body.visitId.trim() !== '' ? body.visitId.trim() : undefined;
  const source = typeof body.source === 'string' && body.source.trim() !== '' ? body.source.trim() : 'previsit-api';

  return {
    ok: true,
    record: {
      patientId,
      ...(visitId === undefined ? {} : { visitId }),
      submittedAt: now,
      source,
      items,
    },
  };
}

/* ------------------------------ 落点与建议 ------------------------------ */

/** 本次文书里"某章节的第一个文本节点"（摊平后的形状，由调用方给） */
export interface SectionAnchor {
  code: string;
  nodeId: NodeId | null;
}

export interface PrevisitDraft {
  key: string;
  label: string;
  text: string;
  reportedAt: string;
  /** 落点；`null` = 本次文书没有对应章节（如实标出来，不猜别处） */
  nodeId: NodeId | null;
  /** 目标章节 code（缺章时也要给：界面要能说清"缺的是哪一章"） */
  sectionCode: string;
  evidence: EvidenceRef;
}

/**
 * 把选中的条目映射成"候选建议草稿"。
 *
 * 纯函数：不读文档、不写任何东西。用例因此可以穷举"有章 / 缺章 / 过敏史落到既往史"
 * 这些分支，不用造一棵节点树。
 */
export function planPrevisitDrafts(record: PrevisitRecord, keys: string[], anchors: SectionAnchor[]): PrevisitDraft[] {
  const wanted = keys.length === 0 ? record.items.map((item) => item.key) : keys;
  const anchorOf = new Map(anchors.map((anchor) => [anchor.code, anchor.nodeId]));
  const drafts: PrevisitDraft[] = [];
  for (const item of record.items) {
    if (!wanted.includes(item.key)) continue;
    const sectionCode = PREVISIT_SECTION[item.key] ?? '';
    drafts.push({
      key: item.key,
      label: item.label,
      text: item.text,
      reportedAt: item.reportedAt,
      sectionCode,
      nodeId: sectionCode === '' ? null : (anchorOf.get(sectionCode) ?? null),
      /* 来源可定位到"哪一份预问诊单的哪一项"：`ref` 带患者与提交时刻，`field` 是字段键，
         `capturedAt` 是**患者填写的时刻**（不是我们收到它的时刻） */
      evidence: {
        kind: 'patient',
        ref: `previsit:${record.patientId}@${record.submittedAt}`,
        field: item.key,
        valueText: item.text,
        capturedAt: item.reportedAt,
      },
    });
  }
  return drafts;
}
