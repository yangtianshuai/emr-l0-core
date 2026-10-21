import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashNodes } from './hash.ts';
import { isDocNode, isDocumentModel, isFieldNode, isTextNode } from './guards.ts';
import { codesOf, errorsOf, validateDocument, validateSemantics, validateStructure } from './validate.ts';
import { MigrationError, knownVersions, migrate, migrationPath } from './migrations.ts';
import { DocumentError, fromJson, parseDocument, toJson } from './serialize.ts';
import { SCHEMA_VERSION, SEMANTIC_CODES, type DocumentModel } from './types.ts';
import { assert, assertEqual, TestSuite } from '../testing/harness.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SAMPLES = join(ROOT, 'tools', 'model-check', 'samples');
const VALID = join(SAMPLES, 'sample-note.valid.json');
const INVALID = join(SAMPLES, 'invalid', 'sample-note.invalid.json');
const SIGNED = join(SAMPLES, 's4-signed-doc.json');

const EXPECTED_SEMANTIC_CODES = Object.values(SEMANTIC_CODES).slice().sort();

const suite = new TestSuite('T01 模型层自测', [
  '交叉验收（交给工具链复核）：',
  '  node tools/model-check/model-fidelity-check.mjs .\\tools\\model-check\\samples\\ts-model-output.json',
  '  node tools/model-check/schema-validate.mjs .\\tools\\model-check\\samples\\ts-model-output.json',
  '  node tools/model-check/schema-validate.mjs .\\tools\\model-check\\samples\\ts-model-migrated.json',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort().reverse()) out[key] = reverseKeys(src[key]);
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  const validRaw = readJson(VALID);

  await test('类型守卫：合法文档通过 / 非法输入拒绝', () => {
    assert(isDocumentModel(validRaw), '合法文档应通过 isDocumentModel');
    assert(!isDocumentModel({ ...validRaw, nodes: {} }), '空 nodes 应被拒绝');
    assert(!isDocumentModel({ ...validRaw, nodes: { n_root: { id: 'x' } } }), '残缺节点应被拒绝');
    const root = validRaw.nodes as Record<string, unknown>;
    assert(isDocNode(root.n_root), 'isDocNode 应识别 document 节点');
    assert(isTextNode(root.n_t_cc), 'isTextNode 应识别 text 节点');
    assert(isFieldNode(root.n_f_temp), 'isFieldNode 应识别 field 节点');
    assert(!isFieldNode(root.n_t_cc), 'text 节点不应被识别为 field');
  });

  await test('序列化往返：valid 夹具语义零差异', () => {
    const parsed = parseDocument(validRaw);
    const json = toJson(parsed.doc);
    const again = fromJson(json);
    assertEqual(again, parsed.doc, '往返后文档应完全一致');
    assertEqual(parsed.migrated, [], '当前版本文档不应触发迁移');
  });

  await test('序列化往返：签章产物语义零差异', () => {
    if (!existsSync(SIGNED)) return;
    const doc = fromJson(readJson(SIGNED));
    assertEqual(fromJson(toJson(doc)), doc, '签章产物往返应完全一致');
  });

  await test('canonical 输出与键序无关（跨实现可复现）', () => {
    const doc = fromJson(validRaw);
    const reversed = reverseKeys(doc) as DocumentModel;
    assertEqual(toJson(reversed, { canonical: true }), toJson(doc, { canonical: true }), '打乱键序后 canonical 输出应字节一致');
  });

  await test('哈希与工具链实现逐字节一致（含键序打乱）', async () => {
    const doc = fromJson(validRaw);
    const toolPath = new URL('../../tools/model-check/lib/model-utils.mjs', import.meta.url).href;
    const toolLib = (await import(toolPath)) as { hashNodes: (nodes: unknown) => string };
    const local = hashNodes(doc.nodes);
    const tool = toolLib.hashNodes(doc.nodes);
    assertEqual(local, tool, '未打乱键序时两者哈希应一致');
    const shuffled = reverseKeys(doc.nodes);
    assertEqual(hashNodes(shuffled as typeof doc.nodes), local, '打乱键序后本实现的哈希必须不变（canonical）');
    assertEqual(toolLib.hashNodes(shuffled), local, '打乱键序后工具链的哈希也必须不变（canonical）——否则跨实现会误判机读信息陈旧');
  });

  await test('校验等价：valid 夹具 0 error', () => {
    const doc = fromJson(validRaw);
    const issues = validateDocument(doc);
    assertEqual(errorsOf(issues), [], `合法文档不应有错误，实际：${JSON.stringify(codesOf(issues))}`);
  });

  await test('校验等价：invalid 夹具命中全部 11 类语义规则', () => {
    const raw = readJson(INVALID);
    const structural = validateStructure(raw);
    assert(structural.length > 0, 'invalid 夹具应命中结构错误（缺少 value / 枚举非法）');
    const semanticIssues = validateSemantics(raw as unknown as DocumentModel);
    assertEqual(codesOf(semanticIssues), EXPECTED_SEMANTIC_CODES, '语义规则码应与工具链完全一致');
  });

  await test('未知 schemaVersion 报 E_SCHEMA_VERSION_UNKNOWN', () => {
    const raw = { ...validRaw, schemaVersion: '9.9.9' };
    const codes = codesOf(validateSemantics(raw as unknown as DocumentModel));
    assert(codes.includes(SEMANTIC_CODES.E_SCHEMA_VERSION_UNKNOWN), `应报版本未知，实际：${codes.join(',')}`);
    let threw = false;
    try {
      migrate(raw, SCHEMA_VERSION);
    } catch (err) {
      threw = err instanceof MigrationError && err.code === 'E_SCHEMA_VERSION_UNKNOWN';
    }
    assert(threw, '迁移未知版本应抛 MigrationError(E_SCHEMA_VERSION_UNKNOWN)');
  });

  await test('迁移链：0.9.0 → 1.0.0 可执行且产物合法', () => {
    const doc = fromJson(validRaw);
    const downgraded = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    downgraded.schemaVersion = '0.9.0';
    const mr = downgraded.machineReadable as Record<string, unknown> | undefined;
    if (mr) {
      mr.modelSchemaVersion = '0.9.0';
      delete mr.sourceHash;
    }
    assertEqual(migrationPath('0.9.0', SCHEMA_VERSION), ['1.0.0'], '应解析出 0.9.0 → 1.0.0 路径');
    const migrated = migrate(downgraded);
    assertEqual(migrated.applied, ['0.9.0→1.0.0'], '应记录迁移步骤');
    assertEqual(migrated.doc.schemaVersion, SCHEMA_VERSION, '迁移后版本应为当前版本');
    const back = fromJson(migrated.doc);
    assertEqual(errorsOf(validateDocument(back)), [], '迁移产物必须通过校验');
    const sourceHash = (back.machineReadable as { sourceHash?: string } | undefined)?.sourceHash;
    assert(!!sourceHash, '迁移应为机读块补齐 sourceHash');
    assertEqual(sourceHash, hashNodes(back.nodes), 'sourceHash 应与内容指纹一致');
  });

  await test('迁移框架：无路径时明确报错（不静默通过）', () => {
    assertEqual(migrationPath('0.9.0', '0.9.0'), [], '同版本应返回空路径');
    assertEqual(migrationPath('0.1.0', '1.0.0'), null, '未登记版本应返回 null');
    assert(knownVersions().includes('0.9.0') && knownVersions().includes('1.0.0'), `已知版本应含 0.9.0 与 1.0.0：${knownVersions().join(',')}`);
  });

  await test('严格性：未知字段与非法枚举必须被拒绝', () => {
    const withUnknown = { ...validRaw, unknownTopField: 1 };
    assert(codesOf(validateStructure(withUnknown)).includes('E_UNKNOWN_FIELD'), '顶层未知字段应被拒绝');
    const nodes = JSON.parse(JSON.stringify(validRaw.nodes)) as Record<string, Record<string, unknown>>;
    nodes.n_f_temp.unknownNodeField = 'x';
    assert(codesOf(validateStructure({ ...validRaw, nodes })).includes('E_UNKNOWN_FIELD'), '节点未知字段应被拒绝');
    const badStatus = { ...validRaw, status: 'finished' };
    assert(codesOf(validateStructure(badStatus)).includes('E_ENUM_INVALID'), '非法状态应被拒绝');
    const badTime = { ...validRaw, updatedAt: '2026-10-08 01:40' };
    assert(codesOf(validateStructure(badTime)).includes('E_DATETIME_INVALID'), '非法时间格式应被拒绝');
  });

  await test('DocumentError：结构守卫失败时给出明确错误码', () => {
    let code = '';
    try {
      fromJson({ schemaVersion: SCHEMA_VERSION, docId: 'x' });
    } catch (err) {
      code = err instanceof DocumentError ? err.code : 'NOT_DOCUMENT_ERROR';
    }
    assertEqual(code, 'E_GUARD_FAILED', '残缺文档应抛 E_GUARD_FAILED');
  });

  await test('产出交叉验收文件（供 S2/S5 复核）', () => {
    if (!existsSync(SAMPLES)) mkdirSync(SAMPLES, { recursive: true });
    const doc = fromJson(validRaw);
    writeFileSync(join(SAMPLES, 'ts-model-output.json'), `${toJson(doc, { canonical: true, pretty: true })}\n`, 'utf8');

    const downgraded = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    downgraded.schemaVersion = '0.9.0';
    const mr = downgraded.machineReadable as Record<string, unknown> | undefined;
    if (mr) {
      mr.modelSchemaVersion = '0.9.0';
      delete mr.sourceHash;
    }
    const migrated = fromJson(migrate(downgraded).doc);
    writeFileSync(join(SAMPLES, 'ts-model-migrated.json'), `${toJson(migrated, { pretty: true })}\n`, 'utf8');
    assert(existsSync(join(SAMPLES, 'ts-model-output.json')), '应写出 ts-model-output.json');
    assert(existsSync(join(SAMPLES, 'ts-model-migrated.json')), '应写出 ts-model-migrated.json');
  });

  process.exit(suite.report());
}

void main();
