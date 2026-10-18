// 文档校验：结构校验 + 语义校验（11 条硬规则）。

import { hashNodes } from './hash.ts';
import { isPlainObject } from './guards.ts';
import { controlCellsOf, matchesControlCellType, type ControlGridNode } from './control.ts';
import {
  SCHEMA_VERSION,
  SEMANTIC_CODES,
  TAG_SYSTEMS,
  CONTROL_SHAPES,
  type DocumentModel,
  type JsonValue,
  type ValidationCode,
  type ValidationIssue,
  type ValidateOptions,
} from './types.ts';

const DEFAULT_THRESHOLDS = { aiThreshold: 0.75, aiKeyContentThreshold: 0.9 };

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'docId',
  'docType',
  'patient',
  'encounter',
  'status',
  'createdAt',
  'updatedAt',
  'createdBy',
  'rootId',
  'nodes',
  'machineReadable',
  'revisions',
  'signatureRefs',
  'extensions',
  'resources',
];

const BASE_NODE_KEYS = ['id', 'type', 'parentId', 'order', 'rev', 'provenance', 'keyContent', 'humanConfirmed', 'tags', 'unconfirmedTags', 'styleRef', 'presentation'];

const NODE_EXTRA_KEYS: Record<string, string[]> = {
  document: [],
  /* `required` 是必备章节：漏登记会让整份文档以 E_UNKNOWN_FIELD 报错（见 checkUnknownKeys） */
  section: ['title', 'sectionCode', 'required'],
  paragraph: ['semantic', 'align'],
  text: ['runs'],
  field: ['dataType', 'value', 'valueText', 'unit', 'required', 'valueSet', 'sourceKey', 'sampledAt', 'referenceRange'],
  /* 控件的呈现快照随实例抄进节点（形状 / 字段 / 行列 / 排布 / 行数），
     漏一项的后果是 `E_UNKNOWN_FIELD` —— 而那份文档本来就是本引擎写出来的  */
  control: [
    'controlKind',
    'shape',
    'definitionId',
    'payloadVersion',
    'fields',
    'rows',
    'columns',
    'layout',
    'rowCount',
    'payload',
  ],
  table: ['colCount', 'headerRows'],
  tableRow: [],
  tableCell: ['colSpan', 'rowSpan'],
  image: ['resRef', 'altText', 'caption'],
  listGroup: ['ordered'],
  listItem: [],
  signatureBlock: ['signerRole', 'signerId', 'signatureRef'],
  extension: ['namespace', 'payload'],
};

const PROVENANCE_KEYS = ['origin', 'actorId', 'modelId', 'promptId', 'confidence', 'evidence', 'acceptedBy', 'acceptedAt', 'suggestionId', 'derivedFrom', 'at'];
const EVIDENCE_KEYS = ['kind', 'ref', 'field', 'valueText', 'quote', 'nodeId', 'capturedAt'];
const DERIVATION_KEYS = ['modelId', 'confidence', 'suggestionId', 'editedBy', 'editedAt'];
const REVISION_KEYS = [
  'rev',
  'at',
  'actorId',
  'op',
  'targetId',
  'patch',
  'aiSuggestionId',
  'aiSuggestionIds',
  'modelId',
  'confidence',
  'beforeHash',
  'afterHash',
  /* 解锁与撤销的载荷：漏登记不会当场报错，只会在下一次全量校验时以 E_UNKNOWN_FIELD 暴露 */
  'unlock',
  'revert',
  'confirmedNodeIds',
  'acknowledgedUnconfirmed',
];
const MACHINE_KEYS = ['generatedAt', 'generator', 'sourceHash', 'modelSchemaVersion', 'dataElements', 'keyContentRefs'];
const DATA_ELEMENT_KEYS = ['tag', 'value', 'valueText', 'unit', 'nodeId', 'origin', 'confidence'];
const TAG_KEYS = ['system', 'code', 'display'];
const SIGNATURE_KEYS = [
  'signatureRef',
  'signerRole',
  'signerId',
  'signedAt',
  'covers',
  /* T18：真实签名材料的字段（成组出现，见下面的语义校验） */
  'algorithm',
  'provider',
  'publicKeyFingerprint',
  'publicKeyBase64',
  'signedInfoDigest',
  'signatureValue',
  'references',
];
const SIGNATURE_REFERENCE_KEYS = ['path', 'digest'];
/* run 级来源（`RunProvenance`）：只放最小几个字段，见 types.ts 里那段说明 */
const RUN_KEYS = ['text', 'marks', 'tags', 'provenance'];
const RUN_PROVENANCE_KEYS = ['origin', 'modelId', 'confidence', 'suggestionId'];

const STATUS_VALUES = ['draft', 'reviewing', 'signed', 'archived', 'void'];
const ORIGIN_VALUES = ['human', 'ai', 'system', 'imported'];
const EVIDENCE_KIND_VALUES = ['his', 'lis', 'pacs', 'emr-prior', 'guideline', 'terminology', 'template', 'user-input', 'external-doc', 'dictation', 'patient'];
const FIELD_TYPE_VALUES = ['text', 'number', 'date', 'code', 'boolean', 'expression'];
const CONTROL_KIND_VALUES = ['menstrualHistory', 'odontogram', 'vitalSignsChart', 'scaleScore', 'labTrend', 'custom'];
/* 形状清单只有一处（`types.ts` 的 `CONTROL_SHAPES`）：模板装载校验读同一份，
   两处各写一份的结果是"包装得进、产出的病历校验不过" */
const CONTROL_SHAPE_VALUES = CONTROL_SHAPES as unknown as string[];

/* 控件某格的值与 `dataType` 是否相符那份判据只有一处（`model/control.ts` 的
   `matchesControlCellType`）：写路径与产物校验各写一份的结果是"写得进去、校验不过" */
const REVISION_OP_VALUES = ['create', 'insert', 'update', 'delete', 'move', 'accept-ai', 'reject-ai', 'sign', 'import', 'migrate', 'external', 'unlock', 'revert'];
const SIGNER_ROLE_VALUES = ['author', 'reviewer', 'approver', 'patient'];
const ALIGN_VALUES = ['left', 'center', 'right', 'justify'];
const DOC_TYPE_SYSTEM_VALUES = ['WST500', 'WS445', 'local', 'custom'];
/* 标签体系清单只有一处（`types.ts` 的 `TAG_SYSTEMS`）：模板校验也读同一份，
   两处各写一份的结果是"模板存得进、产物校验不过" */
const TAG_SYSTEM_VALUES = TAG_SYSTEMS;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function push(issues: ValidationIssue[], code: ValidationCode, path: string, message: string, nodeId?: string): void {
  issues.push({ code, message, path, ...(nodeId ? { nodeId } : {}), severity: 'error' });
}

function checkUnknownKeys(issues: ValidationIssue[], value: Record<string, unknown>, allowed: string[], path: string, nodeId?: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) push(issues, 'E_UNKNOWN_FIELD', `${path}.${key}`, `不允许的字段 ${key}`, nodeId);
  }
}

function checkString(issues: ValidationIssue[], value: unknown, path: string, field: string, required: boolean, nodeId?: string): void {
  if (value === undefined) {
    if (required) push(issues, 'E_REQUIRED_FIELD', `${path}.${field}`, `缺少必填字段 ${field}`, nodeId);
    return;
  }
  if (typeof value !== 'string' || value.length === 0) push(issues, 'E_TYPE_INVALID', `${path}.${field}`, `${field} 必须是非空字符串`, nodeId);
}

function checkEnum(issues: ValidationIssue[], value: unknown, allowed: string[], path: string, field: string, nodeId?: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    push(issues, 'E_ENUM_INVALID', `${path}.${field}`, `${field} 取值非法：${JSON.stringify(value)}（允许 ${allowed.join('/')}）`, nodeId);
  }
}

function checkDateTime(issues: ValidationIssue[], value: unknown, path: string, field: string, nodeId?: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !ISO_DATETIME.test(value) || Number.isNaN(Date.parse(value))) {
    push(issues, 'E_DATETIME_INVALID', `${path}.${field}`, `${field} 不是合法 ISO8601 时间：${JSON.stringify(value)}`, nodeId);
  }
}

export function validateStructure(doc: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(doc)) {
    push(issues, 'E_TYPE_INVALID', '$', '文档必须是对象');
    return issues;
  }
  checkUnknownKeys(issues, doc, TOP_LEVEL_KEYS, '$');
  checkString(issues, doc.schemaVersion, '$', 'schemaVersion', true);
  checkString(issues, doc.docId, '$', 'docId', true);
  checkString(issues, doc.createdBy, '$', 'createdBy', true);
  checkString(issues, doc.rootId, '$', 'rootId', true);
  checkEnum(issues, doc.status, STATUS_VALUES, '$', 'status');
  checkDateTime(issues, doc.createdAt, '$', 'createdAt');
  checkDateTime(issues, doc.updatedAt, '$', 'updatedAt');

  if (!isPlainObject(doc.docType)) push(issues, 'E_REQUIRED_FIELD', '$.docType', '缺少 docType');
  else {
    checkUnknownKeys(issues, doc.docType, ['system', 'code', 'display'], '$.docType');
    checkEnum(issues, doc.docType.system, DOC_TYPE_SYSTEM_VALUES, '$.docType', 'system');
    checkString(issues, doc.docType.code, '$.docType', 'code', true);
    checkString(issues, doc.docType.display, '$.docType', 'display', true);
  }

  if (!isPlainObject(doc.patient)) push(issues, 'E_REQUIRED_FIELD', '$.patient', '缺少 patient');
  else {
    checkUnknownKeys(issues, doc.patient, ['patientId', 'nameMasked', 'gender', 'birthDate'], '$.patient');
    checkString(issues, doc.patient.patientId, '$.patient', 'patientId', true);
    checkEnum(issues, doc.patient.gender, ['M', 'F', 'U'], '$.patient', 'gender');
  }

  if (doc.encounter !== undefined) {
    if (!isPlainObject(doc.encounter)) push(issues, 'E_TYPE_INVALID', '$.encounter', 'encounter 必须是对象');
    else {
      checkUnknownKeys(issues, doc.encounter, ['visitId', 'visitType', 'deptCode', 'admittedAt', 'dischargedAt'], '$.encounter');
      checkEnum(issues, doc.encounter.visitType, ['outpatient', 'inpatient', 'emergency', 'physical-exam'], '$.encounter', 'visitType');
      checkDateTime(issues, doc.encounter.admittedAt, '$.encounter', 'admittedAt');
      checkDateTime(issues, doc.encounter.dischargedAt, '$.encounter', 'dischargedAt');
    }
  }

  if (!isPlainObject(doc.nodes) || Object.keys(doc.nodes).length === 0) {
    push(issues, 'E_REQUIRED_FIELD', '$.nodes', '缺少 nodes 或为空');
  } else {
    for (const [key, node] of Object.entries(doc.nodes)) {
      const path = `$.nodes.${key}`;
      if (!isPlainObject(node)) {
        push(issues, 'E_TYPE_INVALID', path, '节点必须是对象', key);
        continue;
      }
      if (typeof node.type !== 'string' || !(node.type in NODE_EXTRA_KEYS)) {
        push(issues, 'E_UNKNOWN_NODE_TYPE', `${path}.type`, `未知节点类型：${JSON.stringify(node.type)}`, key);
        continue;
      }
      const allowed = [...BASE_NODE_KEYS, ...NODE_EXTRA_KEYS[node.type]];
      checkUnknownKeys(issues, node, allowed, path, key);
      checkString(issues, node.id, path, 'id', true, key);
      checkString(issues, node.type, path, 'type', true, key);
      if (node.parentId !== null && typeof node.parentId !== 'string') push(issues, 'E_TYPE_INVALID', `${path}.parentId`, 'parentId 必须是字符串或 null', key);
      if (typeof node.order !== 'number' || !Number.isInteger(node.order)) push(issues, 'E_TYPE_INVALID', `${path}.order`, 'order 必须是整数', key);
      if (typeof node.rev !== 'number' || !Number.isInteger(node.rev) || node.rev < 1) push(issues, 'E_TYPE_INVALID', `${path}.rev`, 'rev 必须是 ≥1 的整数', key);

      if (!isPlainObject(node.provenance)) push(issues, 'E_REQUIRED_FIELD', `${path}.provenance`, '缺少 provenance', key);
      else {
        const p = node.provenance;
        checkUnknownKeys(issues, p, PROVENANCE_KEYS, `${path}.provenance`, key);
        checkEnum(issues, p.origin, ORIGIN_VALUES, `${path}.provenance`, 'origin', key);
        checkDateTime(issues, p.at, `${path}.provenance`, 'at', key);
        checkDateTime(issues, p.acceptedAt, `${path}.provenance`, 'acceptedAt', key);
        if (typeof p.confidence === 'number' && (p.confidence < 0 || p.confidence > 1)) push(issues, 'E_TYPE_INVALID', `${path}.provenance.confidence`, 'confidence 必须在 0~1', key);
        if (Array.isArray(p.evidence)) {
          p.evidence.forEach((ev, i) => {
            if (!isPlainObject(ev)) push(issues, 'E_TYPE_INVALID', `${path}.provenance.evidence[${i}]`, 'evidence 项必须是对象', key);
            else {
              checkUnknownKeys(issues, ev, EVIDENCE_KEYS, `${path}.provenance.evidence[${i}]`, key);
              checkEnum(issues, ev.kind, EVIDENCE_KIND_VALUES, `${path}.provenance.evidence[${i}]`, 'kind', key);
              checkString(issues, ev.ref, `${path}.provenance.evidence[${i}]`, 'ref', true, key);
            }
          });
        }
        if (p.derivedFrom !== undefined) {
          if (!isPlainObject(p.derivedFrom)) push(issues, 'E_TYPE_INVALID', `${path}.provenance.derivedFrom`, 'derivedFrom 必须是对象', key);
          else {
            checkUnknownKeys(issues, p.derivedFrom, DERIVATION_KEYS, `${path}.provenance.derivedFrom`, key);
            checkString(issues, p.derivedFrom.editedBy, `${path}.provenance.derivedFrom`, 'editedBy', true, key);
            checkDateTime(issues, p.derivedFrom.editedAt, `${path}.provenance.derivedFrom`, 'editedAt', key);
          }
        }
      }

      if (Array.isArray(node.tags)) {
        node.tags.forEach((tag, i) => {
          if (!isPlainObject(tag)) push(issues, 'E_TYPE_INVALID', `${path}.tags[${i}]`, 'tag 必须是对象', key);
          else {
            checkUnknownKeys(issues, tag, TAG_KEYS, `${path}.tags[${i}]`, key);
            checkEnum(issues, tag.system, TAG_SYSTEM_VALUES, `${path}.tags[${i}]`, 'system', key);
            checkString(issues, tag.code, `${path}.tags[${i}]`, 'code', true, key);
          }
        });
      }

      if (node.type === 'text') {
        if (!Array.isArray(node.runs)) push(issues, 'E_REQUIRED_FIELD', `${path}.runs`, 'text 节点必须有 runs 数组', key);
        else {
          node.runs.forEach((run, i) => {
            if (!isPlainObject(run)) push(issues, 'E_TYPE_INVALID', `${path}.runs[${i}]`, 'run 必须是对象', key);
            else {
              checkUnknownKeys(issues, run, RUN_KEYS, `${path}.runs[${i}]`, key);
              if (typeof run.text !== 'string') push(issues, 'E_TYPE_INVALID', `${path}.runs[${i}].text`, 'run.text 必须是字符串', key);
              if (run.provenance !== undefined) {
                const at = `${path}.runs[${i}].provenance`;
                if (!isPlainObject(run.provenance)) push(issues, 'E_TYPE_INVALID', at, 'run.provenance 必须是对象', key);
                else {
                  checkUnknownKeys(issues, run.provenance, RUN_PROVENANCE_KEYS, at, key);
                  checkEnum(issues, run.provenance.origin, ORIGIN_VALUES, at, 'origin', key);
                  /* confidence 与节点级同一口径：必须有限且在 0~1。
                     不校验的话 NaN 会静静躺在数据里，而任何 `confidence < 阈值` 的比较对 NaN 恒为 false ——
                     与 `suggest` 里那条踩过的坑是同一个（见 session.ts 的 E_AI_NO_PROVENANCE 注释）。 */
                  if (run.provenance.confidence !== undefined) {
                    const value = run.provenance.confidence;
                    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
                      push(issues, 'E_TYPE_INVALID', `${at}.confidence`, 'run.provenance.confidence 必须是 0~1 的有限数', key);
                    }
                  }
                }
              }
            }
          });
        }
      }
      if (node.type === 'field') {
        checkEnum(issues, node.dataType, FIELD_TYPE_VALUES, path, 'dataType', key);
        if (!('value' in node)) push(issues, 'E_REQUIRED_FIELD', `${path}.value`, 'field 节点必须有 value', key);
      }
      if (node.type === 'control') {
        checkEnum(issues, node.controlKind, CONTROL_KIND_VALUES, path, 'controlKind', key);
        /* 形状：渲染器按它分派。认不出来的形状在界面上是一片空白 ——
           而"空白"与"这一格还没填"长得一模一样（同 `template/engine.ts` 装载期那条）。  */
        checkEnum(issues, node.shape, CONTROL_SHAPE_VALUES, path, 'shape', key);
        if (!isPlainObject(node.payload)) {
          push(issues, 'E_REQUIRED_FIELD', `${path}.payload`, 'control 节点必须有 payload 对象', key);
        }
        /* 字段快照是 payload 的说明书（界面上的名字、单位、取值域都从它来）：
           `label` 缺了不会报错，只会让医生看到一串键名。  */
        if (node.fields !== undefined && !Array.isArray(node.fields)) {
          push(issues, 'E_TYPE_INVALID', `${path}.fields`, 'fields 若是给就得是数组（字段快照）', key);
        } else if (Array.isArray(node.fields)) {
          (node.fields as unknown[]).forEach((field, i) => {
            const fieldPath = `${path}.fields[${i}]`;
            if (!isPlainObject(field)) {
              push(issues, 'E_TYPE_INVALID', fieldPath, '字段快照必须是对象', key);
              return;
            }
            checkString(issues, field.key, fieldPath, 'key', true, key);
            checkString(issues, field.label, fieldPath, 'label', true, key);
            checkEnum(issues, field.dataType, FIELD_TYPE_VALUES, fieldPath, 'dataType', key);
          });
        }
        /* 键必须落在格里：控件的 payload 是一张扁平表，而"哪一格"由形状算出来
           （`model/control.ts` 的 `controlCellsOf`）。写到一个算不出来的键上，
           症状是"医生填的值在导出里凭空不见" —— 写路径与渲染器都不会报错。
           值也要与那一格的 `dataType` 对得上：payload 是机器真值（带 tag 的格会摊成数据元），
           `"37.2"` 与 `37.2` 在展示上一样、在机器读的时候不是一回事。  */
        if (isPlainObject(node.payload)) {
          const cells = controlCellsOf(node as unknown as ControlGridNode);
          const byKey = new Map(cells.map((cell) => [cell.key, cell]));
          for (const [cellKey, cellValue] of Object.entries(node.payload as Record<string, JsonValue>)) {
            const cell = byKey.get(cellKey);
            if (!cell) {
              push(
                issues,
                'E_UNKNOWN_FIELD',
                `${path}.payload.${cellKey}`,
                `这一格在控件上算不出来（形状 ${String(node.shape)} 的格：${[...byKey.keys()].join(' / ') || '（无）'}）`,
                key,
              );
              continue;
            }
            if (!matchesControlCellType(cell.dataType, cellValue)) {
              push(
                issues,
                'E_TYPE_INVALID',
                `${path}.payload.${cellKey}`,
                `值与该格的数据类型 ${cell.dataType} 对不上（payload 是机器真值：数字给数字、是/否给布尔；空着就该没有这个键）`,
                key,
              );
            }
          }
        }
      }
      if (node.type === 'image') {
        if (node.resRef === undefined) {
          push(issues, 'E_REQUIRED_FIELD', `${path}.resRef`, '缺少必填字段 resRef', key);
        } else if (typeof node.resRef !== 'string') {
          push(issues, 'E_TYPE_INVALID', `${path}.resRef`, 'resRef 必须是字符串（空串 = 待贴图）', key);
        }
      }
      if (node.type === 'extension') {
        checkString(issues, node.namespace, path, 'namespace', true, key);
        if (!('payload' in node)) push(issues, 'E_REQUIRED_FIELD', `${path}.payload`, 'extension 节点必须有 payload', key);
      }
      if (node.type === 'paragraph') checkEnum(issues, node.align, ALIGN_VALUES, path, 'align', key);
      if (node.type === 'signatureBlock') checkEnum(issues, node.signerRole, SIGNER_ROLE_VALUES, path, 'signerRole', key);
    }
  }

  if (doc.machineReadable !== undefined) {
    if (!isPlainObject(doc.machineReadable)) push(issues, 'E_TYPE_INVALID', '$.machineReadable', 'machineReadable 必须是对象');
    else {
      const mr = doc.machineReadable;
      checkUnknownKeys(issues, mr, MACHINE_KEYS, '$.machineReadable');
      checkDateTime(issues, mr.generatedAt, '$.machineReadable', 'generatedAt');
      checkString(issues, mr.generator, '$.machineReadable', 'generator', true);
      checkString(issues, mr.modelSchemaVersion, '$.machineReadable', 'modelSchemaVersion', true);
      if (mr.sourceHash !== undefined) checkString(issues, mr.sourceHash, '$.machineReadable', 'sourceHash', false);
      if (!Array.isArray(mr.dataElements)) push(issues, 'E_REQUIRED_FIELD', '$.machineReadable.dataElements', 'dataElements 必须是数组');
      else {
        mr.dataElements.forEach((de, i) => {
          const p = `$.machineReadable.dataElements[${i}]`;
          if (!isPlainObject(de)) {
            push(issues, 'E_TYPE_INVALID', p, 'dataElement 必须是对象');
            return;
          }
          checkUnknownKeys(issues, de, DATA_ELEMENT_KEYS, p);
          checkString(issues, de.nodeId, p, 'nodeId', true);
          checkEnum(issues, de.origin, ORIGIN_VALUES, p, 'origin');
          if (!('value' in de)) push(issues, 'E_REQUIRED_FIELD', `${p}.value`, 'dataElement 必须有 value');
          if (!isPlainObject(de.tag)) push(issues, 'E_REQUIRED_FIELD', `${p}.tag`, 'dataElement 必须有 tag');
          else {
            checkUnknownKeys(issues, de.tag, TAG_KEYS, `${p}.tag`);
            checkEnum(issues, de.tag.system, TAG_SYSTEM_VALUES, `${p}.tag`, 'system');
            checkString(issues, de.tag.code, `${p}.tag`, 'code', true);
          }
        });
      }
    }
  }

  if (!Array.isArray(doc.revisions)) push(issues, 'E_REQUIRED_FIELD', '$.revisions', 'revisions 必须是数组');
  else {
    doc.revisions.forEach((rev, i) => {
      const p = `$.revisions[${i}]`;
      if (!isPlainObject(rev)) {
        push(issues, 'E_TYPE_INVALID', p, 'revision 必须是对象');
        return;
      }
      checkUnknownKeys(issues, rev, REVISION_KEYS, p);
      if (typeof rev.rev !== 'number' || !Number.isInteger(rev.rev) || rev.rev < 1) push(issues, 'E_TYPE_INVALID', `${p}.rev`, 'rev 必须是 ≥1 的整数');
      checkString(issues, rev.actorId, p, 'actorId', true);
      checkEnum(issues, rev.op, REVISION_OP_VALUES, p, 'op');
      checkDateTime(issues, rev.at, p, 'at');
      if (rev.patch !== undefined) {
        if (!Array.isArray(rev.patch)) push(issues, 'E_TYPE_INVALID', `${p}.patch`, 'patch 必须是数组');
        else {
          rev.patch.forEach((op, j) => {
            if (!isPlainObject(op)) push(issues, 'E_TYPE_INVALID', `${p}.patch[${j}]`, 'patch 项必须是对象');
            else {
              checkEnum(issues, op.op, ['add', 'remove', 'replace'], `${p}.patch[${j}]`, 'op');
              checkString(issues, op.path, `${p}.patch[${j}]`, 'path', true);
            }
          });
        }
      }
    });
  }

  if (Array.isArray(doc.signatureRefs)) {
    doc.signatureRefs.forEach((sig, i) => {
      const p = `$.signatureRefs[${i}]`;
      if (!isPlainObject(sig)) {
        push(issues, 'E_TYPE_INVALID', p, 'signatureRef 必须是对象');
        return;
      }
      checkUnknownKeys(issues, sig, SIGNATURE_KEYS, p);
      checkString(issues, sig.signatureRef, p, 'signatureRef', true);
      checkEnum(issues, sig.signerRole, SIGNER_ROLE_VALUES, p, 'signerRole');
      checkDateTime(issues, sig.signedAt, p, 'signedAt');

      /* T18：签名材料必须成组齐全。
         只留元数据、丢掉签名值（或被改写掉）的签名是最危险的产物：
         界面会显示"已签章"，而它根本不可验证。  */
      const material = ['algorithm', 'publicKeyBase64', 'publicKeyFingerprint', 'signedInfoDigest', 'signatureValue', 'references'] as const;
      const present = material.filter((key) => (sig as Record<string, unknown>)[key] !== undefined);
      if (present.length > 0 && present.length < material.length) {
        push(issues, 'E_SIGNATURE_INCOMPLETE', p, `签名材料不完整：缺少 ${material.filter((key) => !present.includes(key)).join(', ')}`);
      }
      if (Array.isArray(sig.references)) {
        sig.references.forEach((reference, index) => {
          const rp = `${p}.references[${index}]`;
          if (!isPlainObject(reference)) {
            push(issues, 'E_TYPE_INVALID', rp, 'reference 必须是对象');
            return;
          }
          checkUnknownKeys(issues, reference, SIGNATURE_REFERENCE_KEYS, rp);
          checkString(issues, reference.path, rp, 'path', true);
          checkString(issues, reference.digest, rp, 'digest', true);
        });
      }
    });
  }

  return issues;
}

export function validateSemantics(doc: DocumentModel, options: ValidateOptions = {}): ValidationIssue[] {
  const thr = { ...DEFAULT_THRESHOLDS, ...options };
  const issues: ValidationIssue[] = [];
  const nodes = doc.nodes ?? {};
  const knownIds = new Set(Object.keys(nodes));

  /* E_NODE_ID_DUP */
  const seen = new Set<string>();
  for (const [key, node] of Object.entries(nodes)) {
    if (node.id !== key) push(issues, SEMANTIC_CODES.E_NODE_ID_DUP, `$.nodes.${key}`, `索引键 "${key}" 与 node.id "${node.id}" 不一致`, node.id);
    if (seen.has(node.id)) push(issues, SEMANTIC_CODES.E_NODE_ID_DUP, `$.nodes.${key}`, `节点 id 重复：${node.id}`, node.id);
    seen.add(node.id);
  }

  /* E_PARENT_MISSING */
  for (const node of Object.values(nodes)) {
    if (node.parentId !== null && !knownIds.has(node.parentId)) {
      push(issues, SEMANTIC_CODES.E_PARENT_MISSING, `$.nodes.${node.id}.parentId`, `父节点不存在：${node.parentId}`, node.id);
    }
  }

  /* E_ORPHAN_NODE（含循环） */
  const children = new Map<string, string[]>();
  for (const node of Object.values(nodes)) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }
  const reachable = new Set<string>();
  const stack: string[] = knownIds.has(doc.rootId) ? [doc.rootId] : [];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const child of children.get(cur) ?? []) stack.push(child);
  }
  for (const id of knownIds) {
    if (!reachable.has(id)) push(issues, SEMANTIC_CODES.E_ORPHAN_NODE, `$.nodes.${id}`, `节点不可从 rootId 到达（孤儿或循环引用）：${id}`, id);
  }

  /* AI 来源与门控 */
  const finalState = doc.status === 'signed' || doc.status === 'archived';
  for (const node of Object.values(nodes)) {
    const p = node.provenance;
    if (!p) continue;
    if (p.origin === 'ai') {
      if (!p.modelId || typeof p.confidence !== 'number') {
        push(issues, SEMANTIC_CODES.E_AI_NO_PROVENANCE, `$.nodes.${node.id}.provenance`, 'AI 节点缺少 modelId 或 confidence（无法审计与回放）', node.id);
      }
      const threshold = node.keyContent === true ? thr.aiKeyContentThreshold : thr.aiThreshold;
      if (typeof p.confidence === 'number' && p.confidence < threshold && node.humanConfirmed !== true) {
        push(issues, SEMANTIC_CODES.E_AI_LOW_CONFIDENCE_UNCONFIRMED, `$.nodes.${node.id}.provenance.confidence`, `AI 置信度 ${p.confidence} 低于阈值 ${threshold} 且未经人工确认（不得落笔）`, node.id);
      }
    }
    if (finalState && node.keyContent === true && node.humanConfirmed !== true) {
      push(issues, SEMANTIC_CODES.E_KEY_CONTENT_UNCONFIRMED, `$.nodes.${node.id}.humanConfirmed`, `关键内容节点在 ${doc.status} 状态仍未人工确认`, node.id);
    }
    /* 机器绑的标签：与关键内容同档（不受任何 acknowledge 声明影响）。
       它不是"内容"而是元数据，会进机读信息被下游直接消费 —— 而医生看正文时看不见它。  */
    if (finalState && (node.unconfirmedTags?.length ?? 0) > 0) {
      push(
        issues,
        SEMANTIC_CODES.E_TAG_UNCONFIRMED,
        `$.nodes.${node.id}.unconfirmedTags`,
        `机器绑定的数据元标签未经人工确认即进入 ${doc.status} 状态（${(node.unconfirmedTags ?? []).length} 条）`,
        node.id,
      );
    }
    if (finalState && p.origin === 'ai' && node.humanConfirmed !== true) {
      push(issues, SEMANTIC_CODES.E_SIGNED_WITH_UNCONFIRMED_AI, `$.nodes.${node.id}`, `存在未经人工确认的 AI 内容即进入 ${doc.status} 状态`, node.id);
    }
  }

  /* 机读信息陈旧 */
  const mr = doc.machineReadable;
  if (mr) {
    if (mr.modelSchemaVersion !== doc.schemaVersion) {
      push(issues, SEMANTIC_CODES.E_MACHINE_READABLE_STALE, '$.machineReadable.modelSchemaVersion', `机读信息 modelSchemaVersion=${mr.modelSchemaVersion} 与文档 schemaVersion=${doc.schemaVersion} 不一致`);
    }
    if (mr.sourceHash) {
      const actual = hashNodes(nodes);
      if (mr.sourceHash !== actual) {
        push(issues, SEMANTIC_CODES.E_MACHINE_READABLE_STALE, '$.machineReadable.sourceHash', `机读信息 sourceHash=${mr.sourceHash} 与当前节点内容指纹=${actual} 不一致，需重算`);
      }
    } else if (mr.generatedAt && doc.updatedAt && Date.parse(mr.generatedAt) < Date.parse(doc.updatedAt)) {
      push(issues, SEMANTIC_CODES.E_MACHINE_READABLE_STALE, '$.machineReadable.generatedAt', `机读信息生成时间(${mr.generatedAt})早于文档更新时间(${doc.updatedAt})，需重算（建议补充 sourceHash 以按内容判定）`);
    }
    for (const de of mr.dataElements ?? []) {
      if (de.nodeId && !knownIds.has(de.nodeId)) {
        push(issues, SEMANTIC_CODES.E_MACHINE_READABLE_STALE, '$.machineReadable.dataElements', `机读数据元引用了不存在的节点：${de.nodeId}`, de.nodeId);
      }
    }
    for (const kc of mr.keyContentRefs ?? []) {
      if (kc.nodeId && !knownIds.has(kc.nodeId)) {
        push(issues, SEMANTIC_CODES.E_MACHINE_READABLE_STALE, '$.machineReadable.keyContentRefs', `keyContentRefs 引用了不存在的节点：${kc.nodeId}`, kc.nodeId);
      }
    }
  }

  doc.revisions.forEach((rev, i) => {
    if (rev.rev !== i + 1) push(issues, SEMANTIC_CODES.E_REVISION_GAP, `$.revisions[${i}]`, `留痕 rev 不连续：第 ${i + 1} 条 rev=${rev.rev}（应为 ${i + 1}）`);
  });

  /* schemaVersion 登记：校验器只接受当前版本；旧版本应先经过 migrations.migrate() */
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    push(issues, SEMANTIC_CODES.E_SCHEMA_VERSION_UNKNOWN, '$.schemaVersion', `未登记的 schemaVersion：${doc.schemaVersion}（当前为 ${SCHEMA_VERSION}，旧版本请先调用 migrate()）`);
  }

  return issues;
}

/** 结构 + 语义合并校验 */
export function validateDocument(doc: unknown, options: ValidateOptions = {}): ValidationIssue[] {
  const structural = validateStructure(doc);
  if (structural.length > 0) return structural;
  return validateSemantics(doc as DocumentModel, options);
}

export function errorsOf(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error');
}

export function codesOf(issues: ValidationIssue[]): string[] {
  return [...new Set(issues.map((i) => i.code))].sort();
}
