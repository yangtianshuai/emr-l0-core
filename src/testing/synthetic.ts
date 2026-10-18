// 合成文档生成器（测试夹具）。

import { SCHEMA_VERSION, type DocNode, type DocumentModel, type JsonValue, type NodeId, type ProvenanceOrigin } from '../model/types.ts';

export interface SyntheticOptions {
  sections?: number;
  paragraphsPerSection?: number;
  /** 每个段落是否附带字段节点 */
  fieldsPerParagraph?: number;
  /** 是否加入表格（会显著增加节点数） */
  withTables?: boolean;
}

export interface SyntheticIds {
  rootId: NodeId;
  sectionIds: NodeId[];
  paragraphIds: NodeId[];
  textIds: NodeId[];
  fieldIds: NodeId[];
  tableIds: NodeId[];
  allIds: NodeId[];
}

export interface SyntheticDoc {
  doc: DocumentModel;
  ids: SyntheticIds;
}

const AT = '2026-10-08T01:00:00Z';
const LOREM =
  '患者3天前无诱因出现咳嗽、咳痰，痰为白色黏痰，伴发热，最高体温38.5℃，无明显胸闷气促，否认药物及食物过敏史。既往体健。';

function provenance(origin: ProvenanceOrigin, actorId: string): DocNode['provenance'] {
  return { origin, actorId, at: AT };
}

export function buildSyntheticDoc(options: SyntheticOptions = {}): SyntheticDoc {
  const sections = options.sections ?? 12;
  const paragraphsPerSection = options.paragraphsPerSection ?? 9;
  const fieldsPerParagraph = options.fieldsPerParagraph ?? 0;
  const withTables = options.withTables ?? false;

  const nodes: Record<NodeId, DocNode> = {};
  const ids: SyntheticIds = { rootId: 'n_root', sectionIds: [], paragraphIds: [], textIds: [], fieldIds: [], tableIds: [], allIds: [] };
  let seq = 0;
  const nextId = (prefix: string): NodeId => `${prefix}_${(seq += 1)}`;

  nodes.n_root = {
    id: 'n_root',
    type: 'document',
    parentId: null,
    order: 0,
    rev: 1,
    provenance: provenance('system', 'synthetic'),
  };
  ids.allIds.push('n_root');

  for (let s = 0; s < sections; s += 1) {
    const sectionId = nextId('sec');
    nodes[sectionId] = {
      id: sectionId,
      type: 'section',
      parentId: 'n_root',
      order: (s + 1) * 10,
      rev: 1,
      title: `第 ${s + 1} 节`,
      sectionCode: `sec${s + 1}`,
      provenance: provenance('human', 'DR_SYN'),
    };
    ids.sectionIds.push(sectionId);
    ids.allIds.push(sectionId);

    let order = 10;
    for (let p = 0; p < paragraphsPerSection; p += 1) {
      const paragraphId = nextId('p');
      nodes[paragraphId] = {
        id: paragraphId,
        type: 'paragraph',
        parentId: sectionId,
        order: (order += 10),
        rev: 1,
        semantic: p % 2 === 0 ? 'presentIllness' : 'physicalExam',
        provenance: provenance('human', 'DR_SYN'),
      };
      ids.paragraphIds.push(paragraphId);
      ids.allIds.push(paragraphId);

      const textId = nextId('t');
      nodes[textId] = {
        id: textId,
        type: 'text',
        parentId: paragraphId,
        order: 10,
        rev: 1,
        runs: [{ text: LOREM }],
        provenance: provenance('human', 'DR_SYN'),
      };
      ids.textIds.push(textId);
      ids.allIds.push(textId);

      for (let f = 0; f < fieldsPerParagraph; f += 1) {
        const fieldId = nextId('f');
        nodes[fieldId] = {
          id: fieldId,
          type: 'field',
          parentId: paragraphId,
          order: 20 + f * 10,
          rev: 1,
          dataType: 'number',
          value: 36.5 + ((p + f) % 5) * 0.3,
          valueText: String(36.5 + ((p + f) % 5) * 0.3),
          unit: '℃',
          sourceKey: `VITAL.T${p}_${f}`,
          tags: [
            { system: 'WS445', code: `DE05.01.${String(f).padStart(3, '0')}`, display: '体温' },
            { system: 'local', code: `LT${f}`, display: '院内项' },
          ],
          provenance: provenance('system', 'system/lis'),
        };
        ids.fieldIds.push(fieldId);
        ids.allIds.push(fieldId);
      }

      if (withTables && p === paragraphsPerSection - 1) {
        const tableId = nextId('tb');
        nodes[tableId] = { id: tableId, type: 'table', parentId: paragraphId, order: 90, rev: 1, colCount: 3, headerRows: 1, provenance: provenance('human', 'DR_SYN') };
        ids.tableIds.push(tableId);
        ids.allIds.push(tableId);
        const rowId = nextId('tr');
        nodes[rowId] = { id: rowId, type: 'tableRow', parentId: tableId, order: 10, rev: 1, provenance: provenance('human', 'DR_SYN') };
        ids.allIds.push(rowId);
        for (let c = 0; c < 3; c += 1) {
          const cellId = nextId('tc');
          nodes[cellId] = { id: cellId, type: 'tableCell', parentId: rowId, order: (c + 1) * 10, rev: 1, provenance: provenance('human', 'DR_SYN') };
          ids.allIds.push(cellId);
          const cellTextId = nextId('tct');
          nodes[cellTextId] = {
            id: cellTextId,
            type: 'text',
            parentId: cellId,
            order: 10,
            rev: 1,
            runs: [{ text: `项目 ${s + 1}-${c + 1}` }],
            provenance: provenance('human', 'DR_SYN'),
          };
          ids.allIds.push(cellTextId);
        }
      }
    }
  }

  const doc: DocumentModel = {
    schemaVersion: SCHEMA_VERSION,
    docId: `doc_synthetic_${sections}x${paragraphsPerSection}`,
    docType: { system: 'WST500', code: 'WST500.2', display: '门（急）诊病历' },
    patient: { patientId: 'P_SYN', nameMasked: '合**', gender: 'U' },
    encounter: { visitId: 'V_SYN', visitType: 'outpatient' },
    status: 'draft',
    createdAt: AT,
    updatedAt: AT,
    createdBy: 'DR_SYN',
    rootId: 'n_root',
    nodes,
    /* 初始留痕必须带 patch：变更类 op 一律要求非空 patch（否则"留痕可回放"这条不成立）。
       这里记录根节点的创建。 */
    revisions: [{ rev: 1, at: AT, actorId: 'DR_SYN', op: 'create', targetId: 'n_root', patch: [{ op: 'add', path: '/nodes/n_root', value: nodes.n_root as unknown as JsonValue }] }],
  };

  return { doc, ids };
}

/** 生成约 3200 节点的"100 页"级文档（与工具链 S6 的规模对齐） */
export function buildLargeSyntheticDoc(): SyntheticDoc {
  return buildSyntheticDoc({ sections: 100, paragraphsPerSection: 9, fieldsPerParagraph: 1, withTables: true });
}
