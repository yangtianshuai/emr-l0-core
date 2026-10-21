import { SCHEMA_VERSION, type DataElementTag, type DocNode, type DocTypeRef, type DocumentModel, type EncounterRef, type JsonValue, type NodeId, type PatientRef } from '../model/types.ts';

const AT = '2026-10-08T01:00:00Z';

export type DocKind = 'outpatient' | 'admission' | 'progress' | 'discharge';

const TAG = {
  chiefComplaint: { system: 'WST500', code: 'WST500.2.001', display: '主诉' } as DataElementTag,
  presentIllness: { system: 'WST500', code: 'WST500.2.002', display: '现病史' } as DataElementTag,
  pastHistory: { system: 'WST500', code: 'WST500.2.003', display: '既往史' } as DataElementTag,
  physicalExam: { system: 'WST500', code: 'WST500.2.004', display: '体格检查' } as DataElementTag,
  auxiliaryExam: { system: 'WST500', code: 'WST500.2.005', display: '辅助检查' } as DataElementTag,
  diagnosis: { system: 'ICD10', code: 'J18.9', display: '肺炎' } as DataElementTag,
  dischargeDiagnosis: { system: 'ICD10', code: 'I10', display: '高血压' } as DataElementTag,
  temperature: { system: 'WS445', code: 'DE05.01.001', display: '体温' } as DataElementTag,
  pulse: { system: 'WS445', code: 'DE05.01.002', display: '脉搏' } as DataElementTag,
  systolic: { system: 'WS445', code: 'DE05.01.010', display: '收缩压' } as DataElementTag,
  wbc: { system: 'WS445', code: 'DE04.30.001', display: '白细胞计数' } as DataElementTag,
};

const RANGE = {
  temperature: { low: 36, high: 37.2 },
  pulse: { low: 60, high: 100 },
  systolic: { low: 90, high: 140 },
  wbc: { low: 3.5, high: 9.5 },
};

interface FieldSpec {
  tag: DataElementTag;
  value: number | string;
  unit: string;
  range?: { low?: number; high?: number };
}

interface ParagraphSpec {
  text: string;
  tags?: DataElementTag[];
  keyContent?: boolean;
  fields?: FieldSpec[];
}

interface SectionSpec {
  title: string;
  code: string;
  paragraphs: ParagraphSpec[];
}

export interface ContentPack {
  chiefComplaint: string;
  presentIllness: string;
  pastHistory: string;
  physicalExam: string;
  auxiliaryExam: string;
  diagnosis: string;
  diagnosisTag: DataElementTag;
  temperature: number;
  pulse: number;
  systolic: number;
  wbc: number;
  plan: string;
}

const TEMPLATES: Record<DocKind, { label: string; docType: DocTypeRef; sections: (pack: ContentPack) => SectionSpec[] }> = {
  outpatient: {
    label: '门（急）诊病历',
    docType: { system: 'WST500', code: 'WST500.2', display: '门（急）诊病历' },
    sections: (pack) => [
      {
        title: '一、主诉',
        code: 'chiefComplaint',
        paragraphs: [{ text: pack.chiefComplaint, tags: [TAG.chiefComplaint], keyContent: true }],
      },
      { title: '二、现病史', code: 'presentIllness', paragraphs: [{ text: pack.presentIllness }] },
      {
        title: '三、体格检查',
        code: 'physicalExam',
        paragraphs: [
          {
            text: pack.physicalExam,
            tags: [TAG.physicalExam],
            fields: [
              { tag: TAG.temperature, value: pack.temperature, unit: '℃', range: RANGE.temperature },
              { tag: TAG.pulse, value: pack.pulse, unit: '次/分', range: RANGE.pulse },
              { tag: TAG.systolic, value: pack.systolic, unit: 'mmHg', range: RANGE.systolic },
            ],
          },
        ],
      },
      {
        title: '四、辅助检查',
        code: 'auxiliaryExam',
        paragraphs: [{ text: pack.auxiliaryExam, fields: [{ tag: TAG.wbc, value: pack.wbc, unit: '10^9/L', range: RANGE.wbc }] }],
      },
      {
        title: '五、初步诊断',
        code: 'diagnosis',
        paragraphs: [{ text: pack.diagnosis, tags: [pack.diagnosisTag], keyContent: true }],
      },
    ],
  },
  admission: {
    label: '入院记录',
    docType: { system: 'WST500', code: 'WST500.1', display: '入院记录' },
    sections: (pack) => [
      { title: '一、主诉', code: 'chiefComplaint', paragraphs: [{ text: pack.chiefComplaint, tags: [TAG.chiefComplaint], keyContent: true }] },
      { title: '二、现病史', code: 'presentIllness', paragraphs: [{ text: pack.presentIllness, tags: [TAG.presentIllness] }] },
      { title: '三、既往史', code: 'pastHistory', paragraphs: [{ text: pack.pastHistory, tags: [TAG.pastHistory] }] },
      {
        title: '四、体格检查',
        code: 'physicalExam',
        paragraphs: [
          {
            text: pack.physicalExam,
            tags: [TAG.physicalExam],
            fields: [
              { tag: TAG.temperature, value: pack.temperature, unit: '℃', range: RANGE.temperature },
              { tag: TAG.systolic, value: pack.systolic, unit: 'mmHg', range: RANGE.systolic },
            ],
          },
        ],
      },
      {
        title: '五、辅助检查',
        code: 'auxiliaryExam',
        paragraphs: [{ text: pack.auxiliaryExam, fields: [{ tag: TAG.wbc, value: pack.wbc, unit: '10^9/L', range: RANGE.wbc }] }],
      },
      { title: '六、入院诊断', code: 'diagnosis', paragraphs: [{ text: pack.diagnosis, tags: [pack.diagnosisTag], keyContent: true }] },
      { title: '七、诊疗计划', code: 'plan', paragraphs: [{ text: pack.plan, keyContent: true }] },
    ],
  },
  progress: {
    label: '病程记录',
    docType: { system: 'WST500', code: 'WST500.3', display: '病程记录' },
    sections: (pack) => [
      { title: '一、病情变化', code: 'conditionChange', paragraphs: [{ text: `入院后予对症治疗，${pack.presentIllness.replace(/^患者/, '患者')}` }] },
      {
        title: '二、查体',
        code: 'physicalExam',
        paragraphs: [
          {
            text: '神志清楚，精神可，双肺呼吸音较前改善。',
            tags: [TAG.physicalExam],
            fields: [
              { tag: TAG.temperature, value: pack.temperature, unit: '℃', range: RANGE.temperature },
              { tag: TAG.systolic, value: pack.systolic, unit: 'mmHg', range: RANGE.systolic },
            ],
          },
        ],
      },
      { title: '三、检验结果', code: 'labResult', paragraphs: [{ text: pack.auxiliaryExam, fields: [{ tag: TAG.wbc, value: pack.wbc, unit: '10^9/L', range: RANGE.wbc }] }] },
      { title: '四、诊治调整', code: 'plan', paragraphs: [{ text: pack.plan, keyContent: true }] },
    ],
  },
  discharge: {
    label: '出院记录',
    docType: { system: 'WST500', code: 'WST500.4', display: '出院记录' },
    sections: (pack) => [
      { title: '一、入院情况', code: 'admissionStatus', paragraphs: [{ text: `${pack.chiefComplaint}${pack.presentIllness}`, tags: [TAG.chiefComplaint] }] },
      { title: '二、既往史', code: 'pastHistory', paragraphs: [{ text: pack.pastHistory, tags: [TAG.pastHistory] }] },
      { title: '三、住院经过', code: 'hospitalCourse', paragraphs: [{ text: pack.plan }] },
      { title: '四、出院诊断', code: 'dischargeDiagnosis', paragraphs: [{ text: pack.diagnosis, tags: [pack.diagnosisTag], keyContent: true }] },
      {
        title: '四、出院医嘱',
        code: 'dischargeAdvice',
        paragraphs: [{ text: '按时服药，1 周后门诊复查，如有不适随时就诊。', keyContent: true }],
      },
    ],
  },
};

export interface DocSpec {
  docId: string;
  kind: DocKind;
  patient: PatientRef;
  encounter: EncounterRef;
  pack: ContentPack;
  author: string;
  createdAt?: string;
}

export function buildDocument(spec: DocSpec): DocumentModel {
  const template = TEMPLATES[spec.kind];
  const nodes: Record<NodeId, DocNode> = {};
  const at = spec.createdAt ?? spec.encounter.admittedAt ?? AT;
  const human = (): DocNode['provenance'] => ({ origin: 'human', actorId: spec.author, at });
  const system = (ref: string): DocNode['provenance'] => ({ origin: 'system', actorId: ref, at });

  nodes.n_root = { id: 'n_root', type: 'document', parentId: null, order: 0, rev: 1, provenance: system('demo-seed') };

  let sectionSeq = 0;
  for (const section of template.sections({ ...spec.pack })) {
    sectionSeq += 1;
    const sectionId = `n_s${sectionSeq}`;
    nodes[sectionId] = {
      id: sectionId,
      type: 'section',
      parentId: 'n_root',
      order: sectionSeq * 10,
      rev: 1,
      title: section.title,
      sectionCode: section.code,
      provenance: human(),
    };

    let paragraphSeq = 0;
    for (const paragraph of section.paragraphs) {
      paragraphSeq += 1;
      const paragraphId = `${sectionId}_p${paragraphSeq}`;
      nodes[paragraphId] = {
        id: paragraphId,
        type: 'paragraph',
        parentId: sectionId,
        order: paragraphSeq * 10,
        rev: 1,
        provenance: human(),
      };

      const textId = `${paragraphId}_t`;
      nodes[textId] = {
        id: textId,
        type: 'text',
        parentId: paragraphId,
        order: 10,
        rev: 1,
        runs: [{ text: paragraph.text }],
        provenance: human(),
        ...(paragraph.tags ? { tags: paragraph.tags } : {}),
        ...(paragraph.keyContent ? { keyContent: true } : {}),
      };

      let fieldSeq = 0;
      for (const field of paragraph.fields ?? []) {
        fieldSeq += 1;
        const fieldId = `${paragraphId}_f${fieldSeq}`;
        nodes[fieldId] = {
          id: fieldId,
          type: 'field',
          parentId: paragraphId,
          order: 20 + fieldSeq * 10,
          rev: 1,
          dataType: typeof field.value === 'number' ? 'number' : 'text',
          value: field.value as JsonValue,
          valueText: String(field.value),
          unit: field.unit,
          tags: [field.tag],
          sampledAt: at,
          ...(field.range ? { referenceRange: field.range } : {}),
          provenance: system('system/lis'),
        };
      }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    docId: spec.docId,
    docType: template.docType,
    patient: spec.patient,
    encounter: spec.encounter,
    status: 'draft',
    createdAt: at,
    updatedAt: at,
    createdBy: spec.author,
    rootId: 'n_root',
    nodes,
    revisions: [
      { rev: 1, at, actorId: spec.author, op: 'create', targetId: 'n_root', patch: [{ op: 'add', path: '/nodes/n_root', value: nodes.n_root as unknown as JsonValue }] },
    ],
  };
}

export interface WorkspaceDoc {
  docId: string;
  title: string;
  kind: DocKind | 'template';
}

export interface WorkspaceVisit {
  visitId: string;
  visitType: NonNullable<EncounterRef['visitType']>;
  dept: string;
  date: string;
  docs: WorkspaceDoc[];
}

export const DEPARTMENTS: Array<{ code: string; name: string; enabled: boolean }> = [
  { code: 'DEPT_RESP', name: '呼吸内科', enabled: true },
  { code: 'DEPT_CARD', name: '心血管内科', enabled: true },
  { code: 'DEPT_GI', name: '消化内科', enabled: true },
  { code: 'DEPT_OB', name: '产科', enabled: true },
];

export const DOC_TYPES: Array<{ system: DocTypeRef['system']; code: string; display: string; enabled: boolean }> = [
  { system: 'WST500', code: 'WST500.1', display: '入院记录', enabled: true },
  { system: 'WST500', code: 'WST500.2', display: '门（急）诊病历', enabled: true },
  { system: 'WST500', code: 'WST500.3', display: '病程记录', enabled: true },
  { system: 'WST500', code: 'WST500.4', display: '出院记录', enabled: true },
];

export interface WorkspacePatient {
  patientId: string;
  nameMasked: string;
  gender: 'M' | 'F' | 'U';
  age: number;
  visits: WorkspaceVisit[];
}

export interface DemoWorkspace {
  patients: WorkspacePatient[];
  docs: DocumentModel[];
  defaultDocId: string;
}

const PATIENTS: Array<{
  patient: { patientId: string; nameMasked: string; gender: 'M' | 'F' | 'U'; birthDate: string; age: number };
  visits: Array<{
    visit: {
      visitId: string;
      visitType: NonNullable<EncounterRef['visitType']>;
      dept: string;
      date: string;
      admittedAt: string;
      dischargedAt?: string;
    };
    docs: Array<{ docId: string; kind: DocKind; pack: ContentPack; createdAt?: string }>;
  }>;
}> = [
  {
    patient: { patientId: 'P_DEMO_001', nameMasked: '王**', gender: 'M', birthDate: '1981-03-12', age: 45 },
    visits: [
      {
        visit: { visitId: 'V_20261008_0001', visitType: 'outpatient', dept: 'DEPT_RESP', date: '2026-10-08', admittedAt: '2026-10-08T01:00:00Z' },
        docs: [
          {
            docId: 'doc_001_opd',
            kind: 'outpatient',
            pack: {
              chiefComplaint: '发热3天，伴咳嗽、咳痰。',
              presentIllness: '患者3天前无诱因出现咳嗽、咳白色黏痰，伴发热，最高体温38.5℃，无明显胸闷气促。',
              pastHistory: '既往体健，否认高血压、糖尿病史，否认药物及食物过敏史。',
              physicalExam: '神志清楚，双肺呼吸音粗，可闻及少许湿性啰音。',
              auxiliaryExam: '血常规示白细胞升高，中性粒细胞比例增高。',
              diagnosis: '社区获得性肺炎（待完善胸片）。',
              diagnosisTag: TAG.diagnosis,
              temperature: 38.5,
              pulse: 96,
              systolic: 128,
              wbc: 12.6,
              plan: '予抗感染治疗，3日后复查血常规并完善胸片。',
            },
          },
        ],
      },
      {
        visit: { visitId: 'V_20260912_0002', visitType: 'outpatient', dept: 'DEPT_RESP', date: '2026-09-12', admittedAt: '2026-09-12T02:10:00Z' },
        docs: [
          {
            docId: 'doc_001_opd_prev',
            kind: 'outpatient',
            pack: {
              chiefComplaint: '咳嗽2周。',
              presentIllness: '患者2周前受凉后出现阵发性干咳，无发热，无咯血。',
              pastHistory: '既往体健。',
              physicalExam: '咽部稍充血，双肺呼吸音清。',
              auxiliaryExam: '胸片未见明显异常。',
              diagnosis: '急性支气管炎。',
              diagnosisTag: { system: 'ICD10', code: 'J20.9', display: '急性支气管炎' },
              temperature: 36.8,
              pulse: 78,
              systolic: 122,
              wbc: 6.4,
              plan: '对症止咳治疗，必要时复诊。',
            },
          },
        ],
      },
    ],
  },
  {
    patient: { patientId: 'P_DEMO_002', nameMasked: '李**', gender: 'F', birthDate: '1964-07-20', age: 62 },
    visits: [
      {
        visit: {
          visitId: 'V_20261005_0011',
          visitType: 'inpatient',
          dept: 'DEPT_CARD',
          date: '2026-10-05',
          admittedAt: '2026-10-05T03:00:00Z',
          dischargedAt: '2026-10-07T15:00:00Z',
        },
        docs: [
          {
            docId: 'doc_002_adm',
            kind: 'admission',
            createdAt: '2026-10-05T03:00:00Z',
            pack: {
              chiefComplaint: '反复头晕1年，加重3天。',
              presentIllness: '患者1年前发现血压升高，最高170/100mmHg，未规律服药；3天前头晕加重。',
              pastHistory: '高血压病史1年，否认糖尿病、冠心病史。',
              physicalExam: '神志清楚，双肺呼吸音清，心律齐，未闻及病理性杂音。',
              auxiliaryExam: '血常规、生化未见明显异常，心电图示窦性心律。',
              diagnosis: '高血压病2级（高危）。',
              diagnosisTag: TAG.dischargeDiagnosis,
              temperature: 36.5,
              pulse: 82,
              systolic: 168,
              wbc: 6.1,
              plan: '予降压治疗，监测血压变化，低盐低脂饮食。',
            },
          },
          {
            docId: 'doc_002_prog',
            kind: 'progress',
            createdAt: '2026-10-05T09:00:00Z',
            pack: {
              chiefComplaint: '反复头晕1年，加重3天。',
              presentIllness: '头晕症状较入院时减轻。',
              pastHistory: '高血压病史1年。',
              physicalExam: '神志清楚，血压较前下降。',
              auxiliaryExam: '复查生化未见明显异常。',
              diagnosis: '高血压病2级（高危）。',
              diagnosisTag: TAG.dischargeDiagnosis,
              temperature: 36.6,
              pulse: 78,
              systolic: 142,
              wbc: 5.8,
              plan: '继续当前降压方案，监测血压。',
            },
          },
          {
            docId: 'doc_002_dis',
            kind: 'discharge',
            createdAt: '2026-10-07T15:00:00Z',
            pack: {
              chiefComplaint: '反复头晕1年，加重3天。',
              presentIllness: '经治疗症状缓解，血压控制平稳。',
              pastHistory: '高血压病史1年，冠心病史2年。',
              physicalExam: '出院时血压 132/82mmHg。',
              auxiliaryExam: '复查未见异常。',
              diagnosis: '高血压病2级（高危）。',
              diagnosisTag: TAG.dischargeDiagnosis,
              temperature: 36.5,
              pulse: 76,
              systolic: 132,
              wbc: 5.9,
              plan: '住院期间予降压、改善循环治疗，血压控制平稳，症状缓解。',
            },
          },
        ],
      },
    ],
  },
  {
    patient: { patientId: 'P_DEMO_003', nameMasked: '赵**', gender: 'M', birthDate: '1993-11-05', age: 33 },
    visits: [
      {
        visit: { visitId: 'V_20261007_0021', visitType: 'emergency', dept: 'DEPT_GI', date: '2026-10-07', admittedAt: '2026-10-07T14:20:00Z' },
        docs: [
          {
            docId: 'doc_003_opd',
            kind: 'outpatient',
            pack: {
              chiefComplaint: '上腹隐痛1周，加重1天。',
              presentIllness: '患者1周前出现上腹隐痛，多于餐后明显，伴反酸嗳气，无呕血黑便。',
              pastHistory: '吸烟史5年，偶饮酒。',
              physicalExam: '腹平软，上腹轻压痛，无反跳痛。',
              auxiliaryExam: '血常规未见明显异常，建议胃镜检查。',
              diagnosis: '慢性胃炎（待胃镜明确）。',
              diagnosisTag: { system: 'ICD10', code: 'K29.5', display: '慢性胃炎' },
              temperature: 36.7,
              pulse: 88,
              systolic: 118,
              wbc: 7.2,
              plan: '予抑酸护胃治疗，建议胃镜检查，清淡饮食。',
            },
          },
        ],
      },
    ],
  },
];

export function buildWorkspace(): DemoWorkspace {
  const docs: DocumentModel[] = [];
  const patients: WorkspacePatient[] = [];

  for (const entry of PATIENTS) {
    const visits: WorkspaceVisit[] = [];
    for (const visitEntry of entry.visits) {
      const visitDocs: WorkspaceDoc[] = [];
      for (const docEntry of visitEntry.docs) {
        docs.push(
          buildDocument({
            docId: docEntry.docId,
            kind: docEntry.kind,
            patient: { patientId: entry.patient.patientId, nameMasked: entry.patient.nameMasked, gender: entry.patient.gender, birthDate: entry.patient.birthDate },
            encounter: {
              visitId: visitEntry.visit.visitId,
              visitType: visitEntry.visit.visitType,
              deptCode: visitEntry.visit.dept,
              admittedAt: visitEntry.visit.admittedAt,
              ...(visitEntry.visit.dischargedAt ? { dischargedAt: visitEntry.visit.dischargedAt } : {}),
            },
            pack: docEntry.pack,
            author: `DR_${entry.patient.patientId.slice(-3)}`,
            ...(docEntry.createdAt ? { createdAt: docEntry.createdAt } : {}),
          }),
        );
        visitDocs.push({ docId: docEntry.docId, title: TEMPLATES[docEntry.kind].label, kind: docEntry.kind });
      }
      visits.push({
        visitId: visitEntry.visit.visitId,
        visitType: visitEntry.visit.visitType,
        dept: visitEntry.visit.dept,
        date: visitEntry.visit.date,
        docs: visitDocs,
      });
    }
    patients.push({
      patientId: entry.patient.patientId,
      nameMasked: entry.patient.nameMasked,
      gender: entry.patient.gender,
      age: entry.patient.age,
      visits,
    });
  }

  return { patients, docs, defaultDocId: docs[0]?.docId ?? '' };
}
