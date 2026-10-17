/**
 * T25 验收自测：OFD / OFD-H 导入。
 *
 *   node src/import/import-self-test.ts
 *
 * 覆盖四层：
 *   A 容器层：ZIP 读取（含 deflate 第三方产物）、CRC 篡改检出、非 ZIP 输入
 *   B 语法层：极简 XML 解析（属性/自闭合/实体/注释/CDATA、按本地名匹配、非法输入的报错）
 *   C **闭环层（头号用例）**：导出 → 导入 → 与源文档逐项比对（文本字符数、数据元召回、
 *     机读 sourceHash），并与**独立探针**的结论交叉验证；再做"导入草稿 → 再导出 → 再导入"的两代往返
 *   D 诚实边界：路径化陷阱、无机读块、已签章源文件的导入件不继承签名
 *
 * 为什么闭环是第一优先：**连自己导出的文件都还原不回来，别家文件更不可能**。
 * 这条用例跑绿，才谈得上"导入别家 OFD-H / PDF / 扫描件"。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WriteSession, type Actor } from '../core/session.ts';
import { errorsOf, validateDocument } from '../model/index.ts';
import type { DocNode, NodeId } from '../model/types.ts';
import { buildSyntheticDoc } from '../testing/synthetic.ts';
import { TestSuite, assert, assertEqual, codeOfAsync } from '../testing/harness.ts';
import { buildZip } from '../export/zip.ts';
import { ImportError, buildImportedDraft, importOfd, verifyAgainstSource } from './ofd-import.ts';
import { ZipError, openZip, readZip } from './zip-read.ts';
import { parseXml, textOf, attrOf, findAll, findFirst } from './xml.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ARTIFACTS = join(ROOT, 'artifacts');
const PROBE = join(ROOT, 'tools', 'ofd-check', 'ofd-roundtrip-check.mjs');
const SAMPLES = join(ROOT, 'tools', 'ofd-check', 'samples');
const HUMAN: Actor = { id: 'DR_T', kind: 'human' };
const AI: Actor = { id: 'ai-pipeline', kind: 'ai' };
const PLAN = { layout: { textAsPath: false }, machineReadable: { signed: true, carrier: 'separate-xml' as const } };

const suite = new TestSuite('T25 OFD / OFD-H 导入自测', [
  '说明：C 组是"导出 → 导入"闭环，要求数据元召回 100%、文本字符数一致、机读 sourceHash 对得上。',
  '并与独立探针（tools/ofd-check）交叉验证，两个独立实现必须给出一致结论。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function ensureArtifacts(): void {
  if (!existsSync(ARTIFACTS)) mkdirSync(ARTIFACTS, { recursive: true });
}

/** 构造一份"已定稿"的病历：含 AI 采纳内容、数据元标签、关键内容与签章 */
async function signedSession(): Promise<WriteSession> {
  const { doc, ids } = buildSyntheticDoc({ sections: 3, paragraphsPerSection: 3, fieldsPerParagraph: 1 });
  const session = WriteSession.open(doc);
  const textId = ids.textIds[0] as NodeId;
  const fieldId = ids.fieldIds[0] as NodeId;

  session.updateNodeProps({ nodeId: textId, patch: { keyContent: true } }, HUMAN);
  session.updateNodeProps({ nodeId: textId, patch: { tags: [{ system: 'WST500', code: 'WST500.2.001', display: '主诉' }] } }, HUMAN);
  const { suggestionId } = session.suggestText(
    {
      nodeId: textId,
      text: '患者3天前出现咳嗽、咳痰，伴发热。',
      confidence: 0.95,
      modelId: 'local/qwen-med:7b@2026-09',
      promptId: 'tpl-chief-complaint-v2',
      evidence: [{ kind: 'lis', ref: 'LIS:20261008-0100:WBC', valueText: '9.8' }],
    },
    AI,
  );
  session.acceptSuggestion({ suggestionId, editedText: '患者3天前无诱因出现咳嗽、咳痰，痰为白色黏痰，伴发热，最高体温38.5℃。' }, HUMAN);
  session.setFieldValue({ nodeId: fieldId, value: 38.5, valueText: '38.5' }, HUMAN);
  session.confirmNode({ nodeId: textId }, HUMAN);
  session.confirmNode({ nodeId: fieldId }, HUMAN);
  await session.sign({}, HUMAN);
  return session;
}

function runProbe(file: string, expectFile?: string): { report: Record<string, unknown>; exit: number } {
  const args = [PROBE, file, '--json', `${file}.report.json`];
  if (expectFile) args.push('--expect', expectFile);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const report = JSON.parse(readFileSync(`${file}.report.json`, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
  return { report, exit: result.status ?? 2 };
}

/* --------------------------------- 用例 --------------------------------- */

async function main(): Promise<void> {
  ensureArtifacts();

  /* ========================= A 容器层（ZIP） ========================= */

  await test('A1 读取自家产物：条目齐全、CRC 全部通过、能按路径取文本', async () => {
    const session = await signedSession();
    const file = join(ARTIFACTS, 'import-own.ofd');
    await session.writeOfdFile(file, PLAN);
    const bytes = readFileSync(file);
    const archive = openZip(bytes);
    for (const required of ['OFD.xml', 'Doc_0/Document.xml', 'Doc_0/MachineReadable.xml', 'Doc_0/Signatures/Signatures.xml']) {
      assert(archive.byPath.has(required), `缺少条目：${required}`);
    }
    assert(archive.entries.every((entry) => entry.crcOk), '全部条目 CRC 应通过');
    assert((archive.text('Doc_0/Document.xml') ?? '').includes('<ofd:Document'), '应能按路径读到文本');
  });

  await test('A2 篡改一个字节 → CRC 校验失败被检出（"篡改可检出"的地基）', async () => {
    const file = join(ARTIFACTS, 'import-own.ofd');
    const bytes = readFileSync(file);
    /* 改正文里一个字节（不动中央目录），CRC 必然不符 */
    const target = bytes.indexOf('Patient'.charCodeAt(0));
    const mutated = Uint8Array.from(bytes);
    mutated[Math.max(0, target) + 1] = (mutated[Math.max(0, target) + 1] as number) ^ 0x01;
    let code = 'OK';
    try {
      readZip(mutated);
    } catch (err) {
      code = (err as ZipError).code;
    }
    assert(code === 'E_ZIP_CRC_MISMATCH' || code === 'E_ZIP_TRUNCATED', `被篡改的容器应被检出，实际：${code}`);
  });

  await test('A3 非 ZIP 输入 → E_ZIP_NOT_FOUND；导入层包装为 ImportError', async () => {
    const text = new TextEncoder().encode('这不是一个 ZIP 文件');
    let zipCode = 'OK';
    try {
      readZip(text);
    } catch (err) {
      zipCode = (err as ZipError).code;
    }
    assertEqual(zipCode, 'E_ZIP_NOT_FOUND', '应报 E_ZIP_NOT_FOUND');
    let importCode = 'OK';
    try {
      importOfd(text);
    } catch (err) {
      importCode = (err as ImportError).code;
    }
    assertEqual(importCode, 'E_IMPORT_FAILED', '导入层应包装为 ImportError');
  });

  await test('A4 兼容 deflate 压缩（第三方工具产物）：PowerShell Compress-Archive 生成的 OFD 能读', async () => {
    const file = join(SAMPLES, 'minimal.ofd');
    if (!existsSync(file)) {
      assert(true, '样例缺失，跳过');
      return;
    }
    const archive = openZip(readFileSync(file));
    const deflated = archive.entries.filter((entry) => entry.method === 8);
    assert(archive.entries.length > 0, '应至少有一个条目');
    assert(deflated.length > 0, '第三方产物应含 deflate 压缩条目（否则本用例失去意义）');
    assert(archive.entries.every((entry) => entry.crcOk), 'deflate 条目解压后 CRC 也应通过');
    const imported = importOfd(readFileSync(file));
    assert(imported.textChars > 0, `应能抽出文本，实际 ${imported.textChars}`);
  });

  /* ========================= B 语法层（XML） ========================= */

  await test('B1 解析属性/自闭合/实体/注释/CDATA，并按本地名匹配前缀', async () => {
    const xml = parseXml(`<?xml version="1.0"?>
      <!-- 注释应被忽略 -->
      <ofd:Root xmlns:ofd="urn:x" name="a&amp;b">
        <ofd:Empty flag="1"/>
        <TextCode X="10" Y="20">值 &lt;3</TextCode>
        <Script><![CDATA[ if (a<b) return; ]]></Script>
      </ofd:Root>`);
    const root = findFirst(xml, 'Root');
    assert(!!root, '应能按本地名找到 Root（忽略 ofd: 前缀）');
    assertEqual(attrOf(root, 'name'), 'a&b', '实体应被解码');
    const empty = findFirst(xml, 'Empty');
    assertEqual(attrOf(empty, 'flag'), '1', '自闭合标签的属性应可读');
    const codes = findAll(xml, 'TextCode');
    assertEqual(codes.length, 1, '应找到 1 个 TextCode');
    assertEqual(textOf(codes[0]), '值 <3', '文本实体应被解码');
    assertEqual(textOf(findFirst(xml, 'Script')), ' if (a<b) return; ', 'CDATA 内容应原样保留');
  });

  await test('B2 非法 XML 应明确报错（不静默产出半截结果）', async () => {
    let message = '';
    try {
      parseXml('<a><b></a>');
    } catch (err) {
      message = (err as Error).message;
    }
    assert(/不匹配/.test(message), `标签不匹配应报错，实际：${message || '未报错'}`);
  });

  /* ==================== C 闭环层（导出 → 导入） ==================== */

  await test('C1 闭环：导入自家 OFD-H，数据元召回 100%、文本一致、sourceHash 对得上', async () => {
    const session = await signedSession();
    const source = session.document;
    const file = join(ARTIFACTS, 'import-roundtrip.ofd');
    await session.writeOfdFile(file, PLAN);

    const imported = importOfd(readFileSync(file));
    assertEqual(imported.format, 'ofd-h', '应识别为 OFD-H');
    assertEqual(imported.machine.found, true, '应找到机读块');
    assertEqual(imported.signature.signed, true, '应识别到签名');
    assert(imported.signature.covers.some((cover) => /MachineReadable/.test(cover)), `签名应覆盖机读文件，实际：${imported.signature.covers.join(',')}`);

    const report = verifyAgainstSource(imported, source);
    assertEqual(report.missing, [], '不应有缺失的数据元');
    assertEqual(report.completeness, 1, `数据元召回率应为 100%，实际 ${report.completeness}`);
    assertEqual(report.textMatches, true, `文本字符数应一致（源 ${report.textCharsSource} / 导入 ${report.textCharsImported}）`);
    assertEqual(report.sourceHashMatch, true, '机读块的 sourceHash 应等于源文档节点指纹（证明它就是这份文档的产物）');
    assert(imported.machine.elements.length === report.elementsSource, '导入的数据元条数应与源一致');
  });

  await test('C2 与独立探针交叉验证：两个实现给出同一结论（字符数、round-trip）', async () => {
    const session = await signedSession();
    const file = join(ARTIFACTS, 'import-roundtrip.ofd');
    await session.writeOfdFile(file, PLAN);
    const expectFile = join(ARTIFACTS, 'import-roundtrip.machine.json');
    writeFileSync(expectFile, `${JSON.stringify((session.document.machineReadable?.dataElements ?? []).map((element) => ({ code: element.tag.code, valueText: element.valueText ?? String(element.value ?? '') })), null, 2)}\n`, 'utf8');

    const imported = importOfd(readFileSync(file));
    const { report, exit } = runProbe(file, expectFile);
    assertEqual(exit, 0, '探针应判定通过');
    const stats = report.stats as { textChars: number };
    assertEqual(imported.textCharsNoSpace, stats.textChars, `去空白字符数应与探针一致（导入 ${imported.textCharsNoSpace} / 探针 ${stats.textChars}）`);
    const roundTrip = report.roundTrip as { completeness: number };
    assertEqual(roundTrip.completeness, verifyAgainstSource(imported, session.document).completeness, 'round-trip 完整率应一致');
    assertEqual(roundTrip.completeness, 1, 'round-trip 应为 100%');
  });

  await test('C3 两代往返：导入草稿 → 再导出 → 再导入，数据元仍完整', async () => {
    const session = await signedSession();
    const file = join(ARTIFACTS, 'import-gen1.ofd');
    await session.writeOfdFile(file, PLAN);
    const gen1 = importOfd(readFileSync(file));

    const draft = buildImportedDraft(gen1, {
      docId: 'doc_import_gen2',
      actorId: 'DR_IMPORT',
      fileName: 'import-gen1.ofd',
      importedAt: '2026-10-08T09:00:00Z',
    });
    assertEqual(errorsOf(validateDocument(draft.doc)), [], '导入草稿必须是合法文档');
    const importedSession = WriteSession.open(draft.doc);
    const gen2File = join(ARTIFACTS, 'import-gen2.ofd');
    importedSession.writeOfdFile(gen2File, PLAN);

    const gen2 = importOfd(readFileSync(gen2File));
    const gen2Codes = gen2.machine.elements.map((element) => `${element.code}=${element.valueText}`).sort();
    const gen1Codes = gen1.machine.elements.map((element) => `${element.code}=${element.valueText}`).sort();
    assertEqual(gen2Codes, gen1Codes, '第二代往返不应丢数据元');
    assert(gen2.textChars > 0, '第二代仍应有正文文本');
  });

  await test('C5 装饰层：页眉/页脚被分出正文，但**内容与条数如实保留**（不是删除）', async () => {
    const session = await signedSession();
    const file = join(ARTIFACTS, 'import-roundtrip.ofd');
    await session.writeOfdFile(file, PLAN);
    const imported = importOfd(readFileSync(file));

    assert(imported.decorationsStripped > 0, `应识别出装饰层内容，实际 ${imported.decorationsStripped}`);
    assertEqual(imported.decorations.length, imported.decorationsStripped, '剥离条数与保留条数应一致');

    /* ① 页码不得混进正文：正文里出现"共 N 页"即说明分离失败 */
    assert(!imported.texts.some((text) => /共 \d+ 页/.test(text)), '页码不得混进正文行');
    /* ② 也不能丢：装饰内容必须能在 decorations 里找到（否则"分离"变成了"删除"） */
    assert(
      imported.decorations.some((line) => /第 1 页 共 \d+ 页/.test(line.text)),
      `装饰层应保留页码原文，实际：${imported.decorations.map((line) => line.text).join(' | ')}`,
    );
    /* ③ 必须留痕说明：否则使用方会以为页码丢了，或以为正文本来就这样 */
    assert(imported.warnings.some((text) => text.includes('已剥离')), '分出装饰层必须给出警告');

    /* ④ 正文口径不受影响：闭环校验仍应完全一致 */
    const report = verifyAgainstSource(imported, session.document);
    assertEqual(report.textMatches, true, '分离装饰层后正文文本仍应与源一致');
    assertEqual(report.completeness, 1, '分离装饰层不应影响数据元召回');
  });

  await test('C4 导入草稿：留痕为 op=import，全部节点带 imported 来源与文件指纹证据', async () => {
    const session = await signedSession();
    const file = join(ARTIFACTS, 'import-roundtrip.ofd');
    await session.writeOfdFile(file, PLAN);
    const imported = importOfd(readFileSync(file));
    const { doc, reviewNotes } = buildImportedDraft(imported, {
      docId: 'doc_import_check',
      actorId: 'DR_IMPORT',
      fileName: 'import-roundtrip.ofd',
      importedAt: '2026-10-08T09:00:00Z',
    });

    assertEqual(doc.status, 'draft', '导入件必须是草稿');
    assertEqual(doc.revisions[0]?.op, 'import', '留痕 op 应为 import');
    assertEqual(doc.revisions[0]?.actorId, 'DR_IMPORT', '留痕应记录导入人');
    assert(doc.signatureRefs === undefined || doc.signatureRefs.length === 0, '导入件不得继承签名');

    for (const node of Object.values(doc.nodes) as DocNode[]) {
      assertEqual(node.provenance.origin, 'imported', `节点 ${node.id} 的来源应为 imported`);
      const evidence = node.provenance.evidence ?? [];
      assert(evidence.length > 0, `节点 ${node.id} 必须带来源证据`);
      assert(String(evidence[0]?.ref ?? '').includes(imported.fileSha256), `节点 ${node.id} 的证据应含源文件指纹`);
    }

    const fields = (Object.values(doc.nodes) as DocNode[]).filter((node) => node.type === 'field');
    assert(fields.length > 0, '应把机读数据元落成字段节点');
    assert(fields.every((node) => node.humanConfirmed !== true), '导入内容一律标为未确认');
    assert(reviewNotes.length > 0, '应给出人工核对提示');

    const sourceInfo = (doc.extensions?.['import.source'] ?? {}) as Record<string, unknown>;
    assertEqual(sourceInfo.sha256, imported.fileSha256, 'extensions 里应保留源文件指纹');
    assertEqual(sourceInfo.signed, true, 'extensions 应记录源文件已签章（供人工判断效力）');
    /* T18 起签名是真实的国密签名：占位符必须为假，且必须记录"验签是否通过" */
    assertEqual(sourceInfo.signaturePlaceholder, false, 'T18 起签名不应再是占位符');
    assertEqual(sourceInfo.signatureAlgorithm, 'SM2-SM3', '来源档案应记录签名算法');
    assertEqual(sourceInfo.signatureVerified, true, '来源档案必须记录独立验签结论（只说"已签章"等于藏问题）');
    assertEqual((sourceInfo.signaturePublicKeyFingerprint as string).length, 64, '来源档案应记录签章公钥指纹');
  });

  await test('C7 导入侧独立验签：源文件未被改动则通过；被改动则失败并**指名文件**', async () => {
    const session = await signedSession();
    const file = join(ARTIFACTS, 'import-verify.ofd');
    await session.writeOfdFile(file, PLAN);

    const clean = importOfd(readFileSync(file));
    assertEqual(clean.signature.verification?.ok, true, '未被改动的源文件应验签通过');
    assertEqual(clean.signature.verification?.algorithm, 'SM2-SM3', '验签结论应带算法');
    assert(
      !clean.warnings.some((line) => line.includes('验签**失败**')),
      '验签通过时不应出现失败警告',
    );

    /* 篡改容器内的机读文件后重新打包：验签必须失败，并指出被改动的文件 */
    const pkg = await session.exportOfd(PLAN);
    const tampered = buildZip(
      pkg.entries.map((entry) =>
        entry.path.endsWith('MachineReadable.xml') ? { path: entry.path, data: `${String(entry.data)}<!-- tampered -->` } : entry,
      ),
      { date: new Date('2026-10-08T00:00:00Z') },
    );
    const broken = importOfd(tampered);
    assertEqual(broken.signature.verification?.ok, false, '被篡改的文件必须验签失败');
    assert(
      (broken.signature.verification?.reasons ?? []).some((reason) => reason.includes('MachineReadable.xml')),
      `验签失败必须指名被改动的文件，实际：${JSON.stringify(broken.signature.verification?.reasons)}`,
    );
    assert(broken.warnings.some((line) => line.includes('验签**失败**')), '验签失败必须作为明确警告报出');
  });

  await test('C5 导入草稿可继续走完整流程：确认 → 签章 → 再导出（探针仍 PASS）', async () => {
    const session = await signedSession();
    const file = join(ARTIFACTS, 'import-roundtrip.ofd');
    await session.writeOfdFile(file, PLAN);
    const imported = importOfd(readFileSync(file));
    const { doc } = buildImportedDraft(imported, {
      docId: 'doc_import_flow',
      actorId: 'DR_IMPORT',
      fileName: 'import-roundtrip.ofd',
      importedAt: '2026-10-08T09:00:00Z',
    });

    const importedSession = WriteSession.open(doc);
    for (const node of Object.values(doc.nodes) as DocNode[]) {
      if (node.type === 'field' || node.type === 'text') importedSession.confirmNode({ nodeId: node.id }, HUMAN);
    }
    await importedSession.sign({}, HUMAN);
    assertEqual(importedSession.document.status, 'signed', '导入件应可确认并签章');

    const out = join(ARTIFACTS, 'import-resigned.ofd');
    importedSession.writeOfdFile(out, PLAN);
    const { report, exit } = runProbe(out, join(ARTIFACTS, 'import-roundtrip.machine.json'));
    assertEqual(exit, 0, '重新导出的产物应通过探针');
    assertEqual((report.roundTrip as { completeness: number }).completeness, 1, 'round-trip 应 100%');
  });

  await test('C6 导入内容未确认不得签章；逐项确认后才放行（TS 与 JS 参考实现同步强制）', async () => {
    const session = await signedSession();
    const file = join(ARTIFACTS, 'import-roundtrip.ofd');
    await session.writeOfdFile(file, PLAN);
    const imported = importOfd(readFileSync(file));
    const { doc } = buildImportedDraft(imported, {
      docId: 'doc_import_gate',
      actorId: 'DR_IMPORT',
      fileName: 'import-roundtrip.ofd',
      importedAt: '2026-10-08T09:00:00Z',
    });

    const codeOf = (run: () => unknown): string => {
      try {
        run();
        return 'OK';
      } catch (err) {
        return (err as { code?: string }).code ?? 'UNKNOWN';
      }
    };

    /* ① 一条都没确认 → 不得签章 */
    const untouched = WriteSession.open(structuredClone(doc));
    assertEqual(await codeOfAsync(() => untouched.sign({}, HUMAN)), 'E_IMPORTED_UNCONFIRMED', '未确认的导入内容必须拦住签章');

    /* ② 只确认正文、字段仍待确认 → 仍不得签章（证明是"逐项"，不是"确认任意一条就放行"） */
    const partial = WriteSession.open(structuredClone(doc));
    for (const node of Object.values(partial.document.nodes) as DocNode[]) {
      if (node.type === 'text') partial.confirmNode({ nodeId: node.id }, HUMAN);
    }
    assertEqual(await codeOfAsync(() => partial.sign({}, HUMAN)), 'E_IMPORTED_UNCONFIRMED', '只确认正文、字段未确认时仍不得签章');

    /* ③ 正文与字段全部确认 → 放行（结构节点不需要确认，否则导入件永远签不了） */
    for (const node of Object.values(partial.document.nodes) as DocNode[]) {
      if (node.type === 'field') partial.confirmNode({ nodeId: node.id }, HUMAN);
    }
    assertEqual(await codeOfAsync(() => partial.sign({}, HUMAN)), 'OK', '内容节点全部确认后应可签章');
    assertEqual(partial.document.status, 'signed', '状态应为已签章');

    /* ④ 双实现一致：JS 参考实现必须给出同一判定（不允许单边实现新门控） */
    const jsModule = (await import('../../tools/model-check/lib/doc-store.mjs')) as {
      createStore: (doc: unknown, options?: unknown) => { sign: (params: unknown, actor: unknown) => unknown };
    };
    const jsStore = jsModule.createStore(structuredClone(doc), {});
    assertEqual(
      await codeOfAsync(() => jsStore.sign({}, HUMAN)),
      'E_IMPORTED_UNCONFIRMED',
      'JS 参考实现必须与 TS 实现判定一致',
    );
  });

  /* ======================= D 诚实边界（负例） ======================= */

  await test('D1 路径化 OFD：抽不到文本，且必须明确警告"可视化陷阱"', async () => {
    const file = join(SAMPLES, 'path-only.ofd');
    if (!existsSync(file)) {
      assert(true, '样例缺失，跳过');
      return;
    }
    const imported = importOfd(readFileSync(file));
    assertEqual(imported.textChars, 0, '路径化文件抽不出文本');
    assert(imported.pathObjects > 0, '应识别到路径对象');
    assert(imported.warnings.some((warning) => /可视化陷阱/.test(warning)), `应给出可视化陷阱警告，实际：${imported.warnings.join(' | ')}`);
    assertEqual(imported.format, 'ofd', '没有机读块时应判定为普通 OFD');
  });

  await test('D2 有文本但无机读块：识别为 OFD，并警告"结构化需要另行识别"', async () => {
    const bytes = buildZip([
      {
        path: 'OFD.xml',
        data: '<?xml version="1.0"?><ofd:OFD xmlns:ofd="http://www.ofd.org/OFD"><ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>',
      },
      {
        path: 'Doc_0/Document.xml',
        data: '<?xml version="1.0"?><ofd:Document xmlns:ofd="http://www.ofd.org/OFD"><ofd:Pages><ofd:Page ID="Page_0" BaseLoc="Pages/Page_0/Content.xml"/></ofd:Pages></ofd:Document>',
      },
      {
        path: 'Doc_0/Pages/Page_0/Content.xml',
        data: '<?xml version="1.0"?><ofd:Content xmlns:ofd="http://www.ofd.org/OFD"><ofd:Page><ofd:Content><ofd:Layer><ofd:TextObject ID="t1"><ofd:TextCode X="10" Y="10">只有版式文本，没有机读信息</ofd:TextCode></ofd:TextObject></ofd:Layer></ofd:Content></ofd:Page></ofd:Content>',
      },
    ]);
    const file = join(ARTIFACTS, 'import-no-machine.ofd');
    writeFileSync(file, bytes);

    const imported = importOfd(readFileSync(file));
    assertEqual(imported.format, 'ofd', '无機读块应判定为普通 OFD');
    assertEqual(imported.machine.found, false, '不应找到机读块');
    assert(imported.textChars > 0, '仍应能抽出文本');
    assert(imported.warnings.some((warning) => /不含机读信息/.test(warning)), '应警告缺少机读信息');

    const { doc, reviewNotes } = buildImportedDraft(imported, {
      docId: 'doc_import_nomachine',
      actorId: 'DR_IMPORT',
      fileName: 'import-no-machine.ofd',
      importedAt: '2026-10-08T09:00:00Z',
    });
    assertEqual(errorsOf(validateDocument(doc)), [], '无机读源的导入草稿也应合法');
    assert(reviewNotes.some((note) => /需人工录入或另行识别/.test(note)), '应提示结构化数据需另行处理');
  });

  await test('D3 元数据回填：源文件里的患者/文书类型可被识别并用于导入草稿', async () => {
    const session = await signedSession();
    const file = join(ARTIFACTS, 'import-roundtrip.ofd');
    await session.writeOfdFile(file, PLAN);
    const imported = importOfd(readFileSync(file));
    assert(!!imported.sourceDocument?.docTypeCode, '应识别源文件的文书类型编码');
    assert(!!imported.sourcePatient?.patientId, '应识别源文件的患者标识');

    const { doc } = buildImportedDraft(imported, {
      docId: 'doc_import_meta',
      actorId: 'DR_IMPORT',
      fileName: 'import-roundtrip.ofd',
      importedAt: '2026-10-08T09:00:00Z',
    });
    assertEqual(doc.patient.patientId, imported.sourcePatient?.patientId, '未显式指定患者时应沿用源文件元数据');
    assertEqual(doc.docType.code, imported.sourceDocument?.docTypeCode, '未显式指定文书类型时应沿用源文件元数据');
  });

  process.exit(suite.report());
}

void main();
