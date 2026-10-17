/**
 * WS/T 500 导入的黄金样例。
 *
 * ⚠️ 声明：本样例由本项目**手写**，只覆盖"本项目需要映射的元素"
 * （文档头、患者、章节树、叙述文本、entry/observation 数据元、无值条目、无编码条目、
 * 非 WS/T 500 的 codeSystem、命名空间前缀混用）。
 * 它**不是**一份合规的 WS/T 500 文档，也**不构成任何符合性声明**；
 * 未经真实厂商/平台导出的文档验证前，不得据此对外声称"支持 WS/T 500"。
 *
 * 用途有两个：
 *   1) 自测的期望值来源（黄金样例比对：映射结果必须逐项等于人工核对的期望）；
 *   2) 产出 `artifacts/wst500-sample.xml`，供 Demo 直接点击导入体验完整链路。
 */

export const WST500_SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:cd="urn:hl7-org:v3">
  <id root="2.16.156.10011.2.1.1.3" extension="DOC_OPD_20261008_001"/>
  <code code="WST500.01.001" codeSystem="2.16.156.10011.2.1.1.3" displayName="门（急）诊病历"/>
  <title>门（急）诊病历</title>
  <effectiveTime value="20261008103000"/>
  <author>
    <assignedAuthor>
      <id extension="DR_1001"/>
      <assignedPerson>
        <name>李建</name>
      </assignedPerson>
      <representedOrganization>
        <name>示例市第一人民医院</name>
      </representedOrganization>
    </assignedAuthor>
  </author>
  <recordTarget>
    <patientRole>
      <id extension="P_DEMO_901"/>
      <patient>
        <name>
          <family>王</family>
          <given>小明</given>
        </name>
        <administrativeGenderCode code="1" displayName="男"/>
        <birthTime value="19900312"/>
      </patient>
    </patientRole>
  </recordTarget>
  <component>
    <cd:structuredBody>
      <component>
        <section>
          <code code="WST500.2.001" codeSystem="2.16.156.10011.2.1.1.4" displayName="主诉"/>
          <title>主诉</title>
          <text>
            <paragraph>发热3天，伴咳嗽、咳痰。</paragraph>
            <paragraph>无药物及食物过敏史。</paragraph>
          </text>
        </section>
      </component>
      <component>
        <section>
          <code code="WST500.2.002" codeSystem="2.16.156.10011.2.1.1.4" displayName="现病史"/>
          <title>现病史</title>
          <text>
            <paragraph>患者3天前无诱因出现咳嗽、咳痰，痰为白色黏痰，伴发热，最高体温38.5℃。</paragraph>
          </text>
        </section>
      </component>
      <component>
        <section>
          <code code="WST500.2.010" codeSystem="2.16.156.10011.2.1.1.4" displayName="体格检查"/>
          <title>体格检查</title>
          <text>
            <paragraph>神志清楚，双肺呼吸音粗，可闻及少许湿性啰音。</paragraph>
          </text>
          <entry>
            <observation classCode="OBS" moodCode="EVN">
              <code code="DE04.01.068" codeSystem="2.16.156.10011.2.1.1.4" displayName="体温"/>
              <value xsi:type="PQ" value="38.5" unit="℃"/>
            </observation>
          </entry>
        </section>
      </component>
      <component>
        <section>
          <code code="WST500.2.020" codeSystem="2.16.156.10011.2.1.1.4" displayName="辅助检查"/>
          <title>辅助检查</title>
          <entry>
            <observation classCode="OBS" moodCode="EVN">
              <code code="WBC" codeSystem="2.16.840.1.113883.6.1" displayName="白细胞计数"/>
              <value xsi:type="PQ" value="12.6" unit="10^9/L"/>
            </observation>
          </entry>
          <entry>
            <observation classCode="OBS" moodCode="EVN">
              <code code="CRP" codeSystem="2.16.840.1.113883.6.1" displayName="C反应蛋白"/>
              <value xsi:type="PQ" value="42" unit="mg/L"/>
            </observation>
          </entry>
          <entry>
            <observation classCode="OBS" moodCode="EVN">
              <code code="SMOKE" codeSystem="2.16.156.10011.2.1.1.4" displayName="吸烟史"/>
            </observation>
          </entry>
          <entry>
            <act>
              <text>没有编码的条目</text>
            </act>
          </entry>
        </section>
      </component>
      <component>
        <section>
          <code code="WST500.2.030" codeSystem="2.16.156.10011.2.1.1.4" displayName="初步诊断"/>
          <title>初步诊断</title>
          <entry>
            <observation classCode="OBS" moodCode="EVN">
              <code code="J15.900" codeSystem="2.16.840.1.113883.6.3" displayName="社区获得性肺炎"/>
              <value xsi:type="ST">社区获得性肺炎</value>
            </observation>
          </entry>
          <component>
            <section>
              <code code="WST500.2.031" codeSystem="2.16.156.10011.2.1.1.4" displayName="诊断明细"/>
              <title>诊断明细</title>
              <text>
                <paragraph>社区获得性肺炎（待完善胸部影像）。</paragraph>
              </text>
            </section>
          </component>
        </section>
      </component>
    </cd:structuredBody>
  </component>
</ClinicalDocument>
`;

/** 只有文档头、没有结构化正文的样例（用于"不假装有正文"的用例） */
export const WST500_HEADER_ONLY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id root="2.16.156.10011.2.1.1.3" extension="DOC_HEADER_ONLY"/>
  <code code="WST500.01.001" codeSystem="2.16.156.10011.2.1.1.3" displayName="门（急）诊病历"/>
  <title>只有头部的文档</title>
  <effectiveTime value="20261008090000"/>
  <recordTarget>
    <patientRole>
      <id extension="P_DEMO_902"/>
      <patient>
        <name><family>赵</family><given>小刚</given></name>
        <administrativeGenderCode code="2" displayName="女"/>
        <birthTime value="19850720"/>
      </patient>
    </patientRole>
  </recordTarget>
</ClinicalDocument>
`;

/** 声明 GBK 编码、内容为纯 ASCII（用于验证编码分支不崩；真实 GBK 字节流见自测说明） */
export const WST500_GBK_DECLARED_XML = `<?xml version="1.0" encoding="GBK"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id extension="DOC_GBK"/>
  <title>encoding-declared-gbk</title>
</ClinicalDocument>
`;

/**
 * 黄金期望：人工逐项核对的结果。
 * 任何一项对不上都说明**映射规则变了**（而不是"测试太严"）——这正是黄金样例的价值。
 */
export const WST500_SAMPLE_EXPECT = {
  documentId: 'DOC_OPD_20261008_001',
  docTypeCode: 'WST500.01.001',
  docTypeDisplay: '门（急）诊病历',
  effectiveTime: '2026-10-08T10:30:00',
  authorName: '李建',
  authorOrg: '示例市第一人民医院',
  patientId: 'P_DEMO_901',
  /** 源文件里是"王小明"（family+given 拼接），导入后必须已脱敏 */
  rawName: '王小明',
  nameMasked: '王**',
  gender: 'M' as const,
  birthDate: '1990-03-12',
  /** 顶层 5 个章节 + 1 个嵌套子章节 */
  sectionCount: 6,
  topLevelTitles: ['主诉', '现病史', '体格检查', '辅助检查', '初步诊断'],
  nestedChildTitle: '诊断明细',
  paragraphCount: 5,
  fieldCount: 4,
  skippedEntries: 2,
  /** 本样例的数据元都在 entry 的直接子层级（depth=0），故不算"深层嵌套" */
  nestedFields: 0,
  /** 样例里的取值都是 PQ/ST，没有编码型（CD/CE）取值 */
  codedValues: 0,
  depthTruncated: 0,
  temperature: { code: 'DE04.01.068', display: '体温', valueText: '38.5', unit: '℃', system: 'WST500' as const },
  /** 非 WS/T 500 根 OID 的 codeSystem：归类为 local，且必须保留源 OID 供人工核对 */
  wbc: { code: 'WBC', valueText: '12.6', unit: '10^9/L', system: 'local' as const, sourceCodeSystem: '2.16.840.1.113883.6.1' },
  /** 源文件里出现过的 codeSystem（去重） */
  codeSystems: ['2.16.156.10011.2.1.1.4', '2.16.840.1.113883.6.1', '2.16.840.1.113883.6.3'],
};
