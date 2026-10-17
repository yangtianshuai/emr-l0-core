/**
 * 发布前隐私与密钥排查脚本自测（P1~P5）。
 *
 * ## 为什么一个"检查工具"也需要用例
 *
 * 因为它**静默失灵的表现与干净完全一样**：没报问题。
 * 本套件就是被这样一次失灵逼出来的 —— `"label": "张医生（内科）"` 的真实数据里，
 * 人名后面跟着科室，而规则要求"闭合引号紧跟纯中文"，于是整条失配，
 * 报告上表现为"没搜到姓名"，而人读到的是"没问题"。**这是这类工具最危险的失败模式**。
 *
 * 所以锁死的五条：
 *   P1 身份证号：**校验位复算**才叫命中；生日段不是日期的不报（宁可不报，不可误报）；
 *   P2 措辞不误报：`患者：门诊号`「住址替换为等长假值」这类**文案**不得当数据报出来；
 *   P3 值的形态要容得下真实写法（人名后面跟科室）—— 守住上面那次漏报；
 *   P4 **报告里不出现明文**：工具不能变成新的泄露源；
 *   P5 私钥归因：只有**确能由公开种子推导**的才允许降级，降级错了就是放过一把真私钥。
 */

import { TestSuite, assert, assertEqual } from '../testing/harness.ts';
import { demoKeyPair } from '../crypto/provider.ts';
import {
  applyReview,
  attributeKnownKeys,
  demoPrivateHexes,
  fingerprintOf,
  isIgnored,
  keyFileVerdict,
  scanText,
  type Finding,
} from './phi-scan.ts';

const suite = new TestSuite('发布前隐私与密钥排查自测', [
  '说明：扫描器失灵的表现与"仓库干净"完全一样（都没报问题），所以它必须自己有用例守住。',
  '全部离线：规则是纯函数，构造一段文本即可断言判定方向。',
]);

const test = (name: string, fn: () => void | Promise<void>): Promise<void> => suite.test(name, fn);

function hitsOf(text: string): Finding[] {
  const out: Finding[] = [];
  scanText(text, 'inline', out);
  return out;
}

function hitsOfRule(text: string, rule: string): Finding[] {
  return hitsOf(text).filter((item) => item.rule === rule);
}

await test('P1 身份证号：校验位通过才叫命中，生日段不是日期的不报', () => {
  /* 两个号都是**合成的**：前 17 位固定为 `11010119810312001`（地区码 + 1981-03-12，虚构人员），
     末位分别填"按国标算法算出的正确校验位 `8`"与"错误的 `1`"。
     这能验证实现照不照国标算 —— 但它替代不了"与外部权威样例比对"（那正是密码学那边用国标向量的做法）。 */
  const passed = hitsOfRule('证件号：110101198103120018', '身份证号');
  assertEqual(passed.length, 1, '校验位通过的号必须报出来（那几乎一定是按真实规则编制的）');
  assert(passed[0]?.detail.includes('校验位通过') === true, '必须写明依据是"校验位通过"，否则它只是"18 位数字"');

  const failed = hitsOfRule('证件号：110101198103120011', '身份证号');
  assertEqual(failed.length, 1, '形似身份证号也要报（但不能断言它是真的）');
  assert(failed[0]?.detail.includes('校验位不通过') === true, '校验位不符要如实说出，供人判断是不是编号');

  /* 生日段不是日期：多半是别的编号（订单号/时间戳拼接），不报 —— 宁可不报，不可误报 */
  assertEqual(hitsOfRule('流水号：110101198199990011', '身份证号').length, 0, '生日段非法的不应报');
});

await test('P2 措辞不误报：提示文案不是数据', () => {
  /* 这三条都来自仓库真实文本（自测标题 / 代码注释 / 文档表格），首轮全被误报过 */
  assertEqual(hitsOf('await test("A3 患者：病历号 / 性别 / 出生日期识别")').length, 0, '测试标题里的"患者：病历号"不得报');
  assertEqual(hitsOf('/** 是否隐藏患者身份（姓名/就诊号以外的一切标识不进入视图） */').length, 0, '注释里的措辞不得报');
  assertEqual(hitsOf('| 身份证/电话/住址替换为等长假值 | 删除整段/整节点 |').length, 0, '文档表格里的措辞不得报');
});

await test('P3 值形态：人名后面跟着科室（守住那次静默漏报）', () => {
  const hits = hitsOfRule('{"label": "张医生（内科）"}', 'JSON 里的姓名 / 标签字段');
  assertEqual(hits.length, 1, '真实数据里人名后面常跟着科室，规则必须容得下');
  assert(hits[0]?.detail.includes('张**') === true, '姓名应脱敏展示（保留姓氏便于人工核对）');

  /* 反例：值不是中文人名的字段不应报 */
  assertEqual(hitsOfRule('{"label": "internal-medicine"}', 'JSON 里的姓名 / 标签字段').length, 0, '英文标签不应报');
});

await test('P4 报告里不出现明文：工具不得成为新的泄露源', () => {
  const hits = hitsOf('联系电话：13812345678');
  assert(hits.length >= 1, '手机号应被报出来');
  for (const item of hits) {
    assert(!item.detail.includes('13812345678'), `报告里出现了明文号码：${item.where}`);
    assert(item.detail.includes('*'), '命中必须打码展示');
  }
  const nameHits = hitsOf('患者姓名：王建国');
  assert(nameHits.length >= 1, '姓名应被报出来');
  assert(!nameHits.some((item) => item.detail.includes('王建国')), '报告里不得出现完整姓名');
});

await test('P5 私钥归因：只有确能由公开种子推导的才允许降级', () => {
  const known = demoPrivateHexes(['phi-scan-self-test-seed']);

  /* ① 演示私钥：可由公开种子推导 → 降级为"已知可公开"，且必须**说清是哪个种子** */
  const demoHex = demoKeyPair('phi-scan-self-test-seed').privateKey.toString(16).padStart(64, '0');
  const demoFinding: Finding = {
    level: 'must',
    rule: 'JSON 里的密钥字段',
    where: 'demo.json:1',
    detail: '（打码）',
    fingerprint: '-',
    secret: demoHex,
  };
  const unknownDemo = attributeKnownKeys([demoFinding], known);
  assertEqual(unknownDemo.length, 0, '演示私钥不应被算作"无法归因"');
  assertEqual(demoFinding.level, 'public', '演示私钥应降级为"已知可公开"');
  assert(demoFinding.detail.includes('phi-scan-self-test-seed'), '降级理由必须写明种子，便于人工复核');

  /* ② 来历不明的私钥：**保持在"必须处置"**，并出现在未知清单里 */
  const alienFinding: Finding = {
    level: 'must',
    rule: 'JSON 里的密钥字段',
    where: 'alien.json:1',
    detail: '（打码）',
    fingerprint: '-',
    secret: 'f'.repeat(64),
  };
  const unknownAlien = attributeKnownKeys([alienFinding], known);
  assertEqual(unknownAlien, ['alien.json:1'], '无法归因的私钥必须留在未知清单（降级错了就是放过一把真私钥）');
  assertEqual(alienFinding.level, 'must', '无法归因的私钥必须保持"必须处置"');
});

await test('P6 .gitignore 判据：父目录规则算覆盖，注释不算规则', () => {
  const text = ['# 注释行', '/logs/', '/artifacts/state/', '!/artifacts/state/keep.json', ''].join('\n');
  assertEqual(isIgnored(text, 'logs'), true, '目录规则应覆盖目录自身');
  assertEqual(isIgnored(text, 'logs/a.log'), true, '父目录被忽略时，其下文件也算覆盖');
  assertEqual(isIgnored(text, 'artifacts/state'), true, '带前导斜杠的规则要能识别');
  assertEqual(isIgnored('artifacts\n', 'artifacts/state'), true, '整目录规则应覆盖其下所有路径');
  assertEqual(isIgnored(text, 'artifacts/recipient-keys.json'), false, '没写进规则的路径不得算已覆盖');
  assertEqual(isIgnored('# /logs/', 'logs'), false, '注释行不是规则（否则"提一句就以为挡住了"）');

  /* 已知限度：本判据**不处理 `!` 取反**，于是会保守地说"已覆盖"。
     真要精确判断应交给 `git check-ignore`，但那要求仓库已 init —— 这一步不该由排查脚本替使用者决定。 */
  assertEqual(isIgnored(text, 'artifacts/state/keep.json'), true, '取反的情形按"已覆盖"处理（保守方向已知）');
});

await test('P7 复核记录：按指纹降级、理由必须带出来、失效记录要报出', () => {
  const raw = '证件号：110101198103120011';
  const fresh = hitsOf(raw).find((item) => item.rule === '身份证号') as Finding;
  assert(!!fresh, '前置：该文本应命中身份证号规则');
  assertEqual(fresh.fingerprint, fingerprintOf('身份证号', '110101198103120011'), '指纹 = 规则名 + 原值的哈希');

  /* 指纹**不含路径与行号**：同一段合成数据出现在别处、或行号变了，复核记录不该失效 */
  const moved = hitsOf(`\n\n\n${raw}`).find((item) => item.rule === '身份证号') as Finding;
  assertEqual(moved.where === fresh.where, false, '前置：两处位置不同（行号不同）');
  assertEqual(moved.fingerprint, fresh.fingerprint, '位置变了，指纹必须不变（否则复核记录会被行号变化反复作废）');

  /* ① 命中复核记录 → 降级为 reviewed，且把理由与复核人带进报告 */
  const entry = { fingerprint: fresh.fingerprint, note: '自测夹具：合成号', reviewedBy: 'T', reviewedAt: '2026-10-10' };
  const stale = applyReview([fresh], [entry]);
  assertEqual(fresh.level, 'reviewed', '命中复核记录应降级为"已复核"');
  assertEqual(stale.length, 0, '有对应命中的记录不算失效');
  assert(fresh.detail.includes('自测夹具：合成号') && fresh.detail.includes('T 2026-10-10'), '理由与复核人必须出现在报告里');

  /* ② 记录里写着、仓库里已无对应内容 → 必须报为"失效"（否则清单会悄悄烂掉） */
  const orphan = { fingerprint: 'deadbeefdeadbeef', note: '早已删除的内容', reviewedBy: 'T', reviewedAt: '2026-10-10' };
  assertEqual(applyReview([], [orphan]).length, 1, '无对应命中的复核记录应被报出');

  /* ③ 复核**不得**盖过更严重的档：已归因为"已知可公开"的演示私钥保持原档（它本来就允许公开） */
  const pub: Finding = {
    level: 'public',
    rule: 'JSON 里的密钥字段',
    where: 'x:1',
    detail: '（打码）',
    fingerprint: 'abc',
  };
  applyReview([pub], [{ fingerprint: 'abc', note: 'x', reviewedBy: 'T', reviewedAt: '2026-10-10' }]);
  assertEqual(pub.level, 'public', '已有更高档结论的不应被复核记录改写');
});

await test('P8 密钥文件分级：空壳降为"需人工确认"，有内容仍是"必须处置"', () => {
  /* 这条是被一次**假警报**逼出来的：清除密钥时"把文件写空"的旧实现留下 0 字节的空壳，
     于是每次发布前排查都为它报一次"必须处置"。假警报的代价不是噪声，是**报告被跳读**。 */
  const empty = keyFileVerdict('.key', 0);
  assertEqual(empty.level, 'review', '0 字节的密钥文件不含材料，不该报最高级别');
  assert(empty.detail.includes('空'), '降级必须写明理由（"它是空的"），否则看起来像放水');
  assert(empty.detail.includes('落盘失败'), '空壳也可能意味着"本该有内容却没写进去"，这条提示不能省');

  assertEqual(keyFileVerdict('.key', 1234).level, 'must', '有内容的密钥文件必须仍由人确认（可能是生产私钥）');
  assertEqual(keyFileVerdict('.p12', 1).level, 'must', '任何非空的密钥 / 证书文件都是"必须处置"');
  assertEqual(keyFileVerdict('.pem', 0).level, 'review', '判定与后缀无关，只看有没有内容');
});

process.exit(suite.report());
