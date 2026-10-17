/**
 * 模板体系 · 类型定义（K4）。
 *
 * ## 一句话：模板是**数据**，实例化是**代码**
 *
 * 一份模板要说清的是"这份文书长什么样"：有哪些章节、每章哪些段落、哪些是数据元、
 * 哪些是关键内容、哪些值由表达式算出来。这些**全是可序列化的声明**，因此可以随包交付、
 * 可以版本化、可以按医院定制 —— 而"怎么把声明变成节点"是引擎的事，包里改不了。
 *
 * 与规则包（`src/qc/rule-pack.ts`）同一条纪律：**表达式只能组合封闭注册表里的算子与函数**，
 * 不能带新逻辑进来。于是任何一个模板包都不可能绕开门控去写文档。
 *
 * ## 为什么模板**不**包含正文内容
 *
 * 模板给的是**骨架与槽位**，不是"一份写好的病历"。若模板里塞满成段文本，实例化出来的
 * 就不再是"待填写的文书"，而是"一份看起来写完的病历" —— 而医生的第一反应会是"这写的是谁"。
 * 因此只有两类文本允许出现在模板里：
 *   ① **章节结构文本**（标题、说明性短语）；
 *   ② **占位提示**（如 `待补充`），且它会被既有的形式质控规则 `R-FORM-03` 抓出来。
 * 真正的病历内容必须由医生写、或由 AI 走建议通道产出。
 *
 * ## 与文档模型的关系
 *
 * 一个 slot 实例化后就是文档里的一个节点（text / field），**不是**新的节点类型 ——
 * 模板层不能扩展文档模型。这条约束让"模板产物必然通过 `validateDocument`"成为可验证的性质，
 * 而不是一句承诺。
 */

import type { ControlFieldSnapshot, ControlKind, ControlShape, DataElementTag, DocTypeRef, FieldDataType, JsonValue } from '../model/types.ts';
import type { Pack, PackItemBase } from '../knowledge/pack.ts';

/* ------------------------------ 表达式 ------------------------------ */

/**
 * 表达式的**值**。刻意只有数字与字符串两类：
 *   - 数字覆盖全部计量与评分；
 *   - 字符串只用于日期（ISO8601），因为孕周/年龄这类"控件"必须由两个日期相减得到。
 * 布尔与枚举不进表达式：它们没有可计算的语义，混进来只会让求值规则变得不可解释。
 */
export type ExprValue = number | string;

/**
 * 表达式 AST（**封闭**：只有这四种节点）。
 *
 * 为什么不接受字符串表达式：那要么需要 `eval`（模板包里就能塞可执行代码，直接推翻"包是数据"），
 * 要么需要自己写解析器（多一层可错的语法）。AST 没有语法、只有结构 ——
 * 校验它就是在校验一棵 JSON 树，错了能精确指到哪个节点。
 */
export type ExprNode =
  | { kind: 'num'; value: number }
  /** 引用同一模板内的**填写项**（field 槽位），按 `key` 找 */
  | { kind: 'slot'; key: string }
  /** 引用实例化上下文（患者/就诊/时间），按点路径找，如 `patient.nameMasked` */
  | { kind: 'ctx'; key: string }
  | { kind: 'fn'; name: string; args: ExprNode[] };

/* ------------------------------- 槽位 ------------------------------- */

/**
 * 参考范围：**与 `model/types.ts` 的 `FieldNode.referenceRange` 同一形状**。
 *
 * 为什么另给一个名字而不是就地内联：它有三个使用者（模板定义、目录投影、编辑抽屉），
 * 各写一份形状迟早漂移 —— 而漂移的症状是"模板存得进去、产出的文档校验不过"。
 */
export type ReferenceRange = { low?: number; high?: number; text?: string; unit?: string };

/**
 * 模板槽位：实例化后对应文档里的一个节点。
 *
 * **`key` 是模板内的唯一名字**，不是节点 id（节点 id 由引擎生成）。表达式靠它引用填写项。
 */
export type TemplateSlot =
  | {
      slot: 'text';
      key: string;
      /** 结构文本或占位提示；`{{ctx.path}}` 会被上下文替换，**替换不到就原样保留并告警** */
      text?: string;
      tags?: DataElementTag[];
      keyContent?: boolean;
      /** 强制另起一段（默认：text 槽位本来就会另起一段） */
      newParagraph?: boolean;
    }
  | {
      slot: 'field';
      key: string;
      dataType: FieldDataType;
      /** 模板可给一个默认值（如就诊日期）；不给就是空待填 */
      value?: JsonValue;
      unit?: string;
      /** 从上下文取值的点路径（如 `encounter.admittedAt`）；取不到就是空待填 */
      from?: string;
      tags?: DataElementTag[];
      keyContent?: boolean;
      required?: boolean;
      /**
       * **参考范围**（模板预设"这一格多少算正常"）。
       *
       * 为什么模板要能预设它：消费方是**趋势的异常标记**（`model/trend.ts` 的 `flagOf`
       * 按它算出偏高 / 偏低 / 正常）。缺了它，趋势图只能画出一条线，回答不了
       * 医生最关心的那个问题 —— 而"这个值是不是异常"恰恰要有一个**预先定义**的口径：
       * 让每个医生各填一次，"正常范围"就变成了十几个不同的口径。
       *
       * `text` 承载无法数值化的范围（如"阴性"）：那一格只做显示，不参与高低判定。
       */
      referenceRange?: ReferenceRange;
      newParagraph?: boolean;
    }
  | {
      slot: 'expression';
      key: string;
      /** 引用本包**医学表达式控件库**里的一个控件（`ExpressionDefinition.itemId`） */
      useExpression: string;
      tags?: DataElementTag[];
      keyContent?: boolean;
      /** 覆盖控件默认单位（同一控件在不同文书里单位可能不同） */
      unit?: string;
      newParagraph?: boolean;
    }
  | {
      slot: 'table';
      key: string;
      /** 表头各列（列名即表头单元格的文本），**至少一列** */
      columns: TemplateTableColumn[];
      /** 数据行数（模板给几行空行让医生填）。不写 = 1 行 */
      rows?: number;
      /**
       * ⚠️ 表格**没有** `tags` / `keyContent`，这是有意的：
       *
       *   - `keyContent` 的含义是"未人工确认就签不出去"。它要求节点有一个**确认动作**，
       *     而医生端只在文本 / 填写项上有「确认内容」按钮 —— 给表格标上它，等于造一份
       *     签不出去的病历（门控拦得住，人却不知道去哪儿确认）。
       *     表格里的格子是填写项，要标关键内容应在**列上**给（本版尚未开放）。
       *   - 表格不是数据元：机器读的是**格子里的填写项**（每个格子是一个 field 节点），
       *     给表格整体绑一个 tag 只会造出一条值为空、来源不明的数据元。
       */
      newParagraph?: boolean;
    }
  | {
      /**
       * 列表：产出 `listGroup` → 每项一个 `listItem`（里面一句 `text`，末尾可选一个 `field`）。
       *
       * 与表格同一族：它也是**块级**内容（必然另起一段），并且同样
       * **不绑数据元、不标关键内容** —— 机器读的是填写项，而医生端没有
       * "确认这一整条列表"的动作，标上它就是一份签不出去、也无处确认的病历。
       *
       * 每一项可以是"纯文字"，也可以带一个格子（`field`）：后者才是数据元的来源
       * （"体温 ____ ℃"）。这与表格的列完全同构 —— 列表不产数据元，格子才产。
       */
      slot: 'list';
      key: string;
      /** 列表项（至少一项） */
      items: TemplateListItem[];
      /** 有序 = 编号（`1. ` / `2. `）；缺省 = 圆点 */
      ordered?: boolean;
      newParagraph?: boolean;
    }
  | {
      slot: 'control';
      key: string;
      /** 引用本包**专科控件库**里的一个控件（`ControlDefinition.itemId`） */
      useControl: string;
      /**
       * 记录行数（只有 `series` 用；不写 = `model/control.ts` 的默认行数）。
       *
       * 为什么行数由模板给、而不是写死在控件定义里：同一个体温单，门诊要两条、
       * 住院要一整页 —— 行数是**这份文书的排布**，不是控件的属性。
       * `matrix` 不吃这一项：它的行列来自控件定义本身（32 颗牙不该由模板改）。
       */
      rows?: number;
      /**
       * 与表格不同，控件**可以**标关键内容：它有一个确认动作
       * （医生端整个控件一个「确认内容」按钮）。表格不行，是因为"没有确认一个表格的入口"，
       * 标上去等于造一份签不出去的病历。
       *
       * 但控件槽**没有** `tags`：控件不是数据元，机器读的是**控件里带 tag 的字段**
       * （见 `ControlFieldSnapshot.tag`）—— 给控件整体绑一个 tag 只会造出一条
       * 值为空、来源不明的数据元。
       */
      keyContent?: boolean;
      newParagraph?: boolean;
    }
  | {
      /**
       * 空段落：给医生留一块**什么都还没有**的地方。
       *
       * 它产出的节点与 `text` 槽位文本留空时**完全一样**（一个 runs 为空的 text 节点），
       * 差别只在"模板作者的意思"：选 `text` 是说"这一段的字由模板给"，
       * 选 `paragraph` 是说"这一段留白，等医生写"。界面上因此不给"结构文本"输入框 ——
       * 留着一个框只会让人以为空着是没填完。
       *
       * 为什么仍允许 `keyContent`：它生成的是文本节点，医生端有「确认内容」按钮，
       * 标成关键内容之后"没确认就签不出去"是**可达**的，不是一句空话。
       */
      slot: 'paragraph';
      key: string;
      keyContent?: boolean;
      /** 只有手写包才会带：段落本来就另起一段，这里原样透传，不在界面上给勾选框 */
      newParagraph?: boolean;
    }
  | {
      /**
       * 图片槽：开出来是一个**待贴图的空槽**（`resRef` 为空串），医生在这一格上贴图。
       *
       * 为什么默认留空、而不让模板直接引用一张固定图：模板是纯 JSON，图字节不在包里。
       * 模板里写死一个 `/res/xxx`，换台机器、清一次资源目录，这张图就裂了 ——
       * 而裂的方式是"病历里这块空了"，不是报错。固定图（科室示意图之类）
       * 要真做，得让包自己带资源，那是另一轮的事。
       *
       * 没有 `keyContent`：与表格同一条理由 —— 医生端**没有"确认这一张图"的动作**，
       * 标上去等于造一份签不出去、也不知道去哪儿确认的病历。
       */
      slot: 'image';
      key: string;
      /** 图片地址。留空（推荐）= 待贴的空槽；填了就固定引用那个资源 */
      resRef?: string;
      /** 医生端的提示（也是空槽上画出来的那行字），如「胸部 CT 正位」 */
      altText?: string;
      /** 图注：排在图下方。`{{ctx.path}}` 会被上下文替换 */
      caption?: string;
      newParagraph?: boolean;
    };

/**
 * 表格的一列。
 *
 * 为什么列上要带 `dataType` / `unit`：一张表的价值全在"每个格子是什么" ——
 * 全是自由文本的表，机器读不出一个数，趋势与质控都用不上它
 * （而"体温单"这类表格恰恰是住院最常见、也最需要结构化的一张表）。
 */
/**
 * 列表的一项：一句文字，末尾可以跟一个**填写项**（如"体温 ____ ℃"）。
 *
 * 为什么文字与格子分开、不做成一串富文本：它们在文档里本来就是两类节点
 * （`text` 与 `field`）。揉成一段字符串，等于把"这一格进不进机读"藏进一句话里 ——
 * 而机读只认 `field` 上的 `tags`。
 */
export interface TemplateListItem {
  /** 这一项的文字（可含 `{{ctx.path}}`） */
  text: string;
  /**
   * 这一项末尾的填写项。给了就在 `listItem` 下再生成一个 `field` 节点，
   * 与表格格子同一套（`dataType` / `unit` / `tags`）。
   *
   * ⚠️ 仍然没有 `keyContent`：医生端列表项里只有一个输入框，没有"确认这一项"的动作。
   */
  field?: {
    dataType: FieldDataType;
    unit?: string;
    tags?: DataElementTag[];
  };
}

export interface TemplateTableColumn {
  /** 列名：它就是表头格子里那行字 */
  title: string;
  /** 这一列的值类型；不写 = text */
  dataType?: FieldDataType;
  /** 这一列的单位（如 mmHg）；不写 = 无单位 */
  unit?: string;
  /**
   * 这一列绑的**数据元**（如 WS445 / DE05.01.001 / 体温）。
   *
   * 标签落在**格子里的填写项**上，不是表格上：表格只是容器，机器读的是一格一格的值。
   * 同一列的多行共用同一条标签 —— "这一列是体温"这件事与第几行无关，
   * 而 `code` 保持一致正是跨文书比对要的（同一个数据元在不同文书里认得出是同一个）。
   *
   * ⚠️ 列上仍**没有** `keyContent`：格子是填写项没错，但医生端表格里的格子只有一个输入框，
   * 没有"确认这一格"的动作 —— 标上去等于造一份签不出去、也无处确认的病历。
   */
  tags?: DataElementTag[];
}

export interface TemplateSection {
  /** 章节编码（如 `chiefComplaint`）。写进 `sectionCode`，是跨文书比对的锚点之一 */
  sectionCode: string;
  title: string;
  slots: TemplateSlot[];
  /**
   * **必备章节**（`true` = 这一章是这份文书必须有的部分）。
   *
   * 引擎把它抄进 `SectionNode.required`，于是**写路径拦得住**：开出的病历里这一章删不掉
   * （见 `core/session.ts` 的 `deleteNode`）。只在模板里声明、不进文档的话，
   * "必备"就只是一句写在包里的好听话 —— 而医生删掉它时系统一句话都不会说。
   *
   * 语义的边界要说清：它管"**这一章在不在**"，不管"写得够不够长"。
   * 后者是质控的事，在开文书那一刻无法判定（刚开出来的草稿必然还是空的）。
   */
  required?: boolean;
  /**
   * **章节级关键内容**：这一章整体按关键内容对待。
   *
   * 与槽位级 `keyContent` 的关系：槽位级管"这一格"，章节级管"这一章"。
   * 两者都抄进文档的 `keyContent`（章节节点自身也允许标），
   * 于是"关键内容未人工确认不得签章"那条门对整章同样成立。
   */
  keyContent?: boolean;
  /**
   * **章节说明**：写给医生看的"这一章要写清什么"。
   *
   * 为什么它必须有（而不是靠标题暗示）：标题只有三五个字，
   * 而"主诉要写清症状 + 部位 + 时间"这类要求不写下来就只能靠口口相传。
   * 它**不进文档**（不是病历内容，是写这份病历时给人的提示），
   * 因此打开文书时由界面单独展示，不会混进正文、也不会进签名覆盖范围。
   */
  description?: string;
}

export interface TemplateDefinition extends PackItemBase {
  itemType: 'template';
  itemId: string;
  name: string;
  docType: DocTypeRef;
  sections: TemplateSection[];
  /**
   * **适用科室**（存的是科室**编码**，不是名称）。**不配置 = 通用**（全院都能开）。
   *
   * 它是**真的判定**（`deptAllowsTemplate`）：
   *   - 清单过滤：医生端「新建」里不会列出"本次就诊开不出"的文书；
   *   - 开具校验：硬开一份科室不匹配的文书会被拒（`E_TPL_DEPT_MISMATCH`），并说明原因。
   *
   * 编码必须来自**科室字典**（`storage/department-store.ts`）：两边（就诊 `encounter.deptCode`
   * 与这里）按编码对齐。存名称会让"科室改名"变成一句谎话 —— 病历里写着旧名、字典里已是新名，
   * 没有任何地方会报错。配一个字典里不存在的编码，后果是**这份文书谁都开不出**，
   * 所以保存时会当场被拒（见 `validateTemplateDepartments`）。
   */
  departments?: string[];
  /**
   * **状态**：`draft` = 草稿（还没定稿），`active` = 已发布。**不写 = 已发布**（既有包不受影响）。
   *
   * 为什么必须有它：新建的文书骨架一开始必然是**不完整的**，让它当场就能开，
   * 医生会照着它开出结构残缺的病历，而"这份病历为什么少一章"事后无从解释。
   * 于是：**草稿 = 医生端开不出，但看得见、改得动**（`listTemplates` 排除它）；
   * 发布是一次**显式动作**，不是"保存完就悄悄上线"。
   */
  status?: 'draft' | 'active';
  description?: string;
}

/**
 * 医学表达式控件（K4 要求 ≥5 个）。
 *
 * 它是**可复用**的：模板用 `useExpression` 引用它，于是"体质指数怎么算"只定义一次、
 * 全院的文书都引用同一份定义。控件库里改了公式，所有引用它的模板同时生效 ——
 * 这正是"知识资产"与"写死在一份表单里"的区别。
 */
export interface ExpressionDefinition extends PackItemBase {
  itemType: 'expression';
  /** 如 `expr.bmi` */
  itemId: string;
  name: string;
  unit?: string;
  expression: ExprNode;
  description?: string;
}

/**
 * **章节片段**：一段可复用的章节（一串章节 + 其中的槽位）。
 *
 * ## 它解决什么
 *
 * 没有它的时候，一份新文书**只能从零拼**：本院 20 份文书里重复出现的
 * "体格检查""既往史"要一章一章重敲一遍。片段把"经常一起出现的一串章节"
 * 变成**一次插入**，并且改一处不影响已经开出的病历（片段是素材，不是引用）。
 *
 * ## 三条设计选择（每条都能换来一个更省事的做法，也都有代价）
 *
 * 1. **片段没有 `status`（草稿 / 已发布）**。那道开关存在的理由是"已发布的模板
 *    可能已经开出过病历"——而片段**开不出病历**，它只是被拼进某份草稿。
 *    给它加一道发布门，只会让"想插一章"变成"先撤稿"。
 * 2. **片段引用控件不在这里校验**（见 `engine.ts` 的 `validateTemplateSections`）：
 *    片段是素材，"它引用的控件在本包里存不存在"要等它被拼进**某一份模板**时才有答案。
 * 3. **插入 = 把章节复制过去**，不是建立引用。于是"改了片段"不会回头改动已经用它拼好的模板 ——
 *    与"改模板不影响已开出的病历"同一条纪律：**下游不能被上游悄悄改掉**。
 *    代价是片段内容要更新时得重新插一次，这一点在界面上要说清。
 */
export interface FragmentDefinition extends PackItemBase {
  itemType: 'fragment';
  /** 如 `frag.custom.1` */
  itemId: string;
  name: string;
  /** 片段内容：一串章节，顺序即插入顺序 */
  sections: TemplateSection[];
  /** 说明：这个片段什么时候用、给谁用 */
  description?: string;
}

/* ---------------------------- 专科控件（自定义） ---------------------------- */

/**
 * 形状与它的白名单**定义在模型层**（`model/types.ts`），这里只转出。
 *
 * 为什么下沉：形状要随 `ControlNode.shape` 进文档（渲染器是纯函数，医生端 / 预览 /
 * 导入 / 导出都拿不到包），而模型层不能反过来依赖模板层。模板侧读形状的那批代码
 * （包装载校验、目录投影、编辑抽屉）照旧从本模块取，引用点一处都不用改。
 */
export type { ControlShape } from '../model/types.ts';
export { CONTROL_SHAPES } from '../model/types.ts';

/**
 * 控件里的一个字段。
 *
 * 取值类型、单位、参考范围、取值域**全部复用 `FieldNode` 那一套** ——
 * 控件不引入新词汇，只是"把一组字段装进一个格子"（见 `ControlFieldSnapshot`）。
 */
export interface ControlFieldDef extends ControlFieldSnapshot {
  /**
   * `dataType === 'expression'` 时必填：引用**同包内**的表达式控件。
   *
   * 为什么"合计怎么算"也走表达式控件、而不给控件体系单开一套计分规则：
   * 那会变成第二处"公式怎么表达"，而两处口径迟早分叉。表达式是**结构**（AST）、
   * 不是文本，所以它带不来可执行代码，控件的"包是数据"这条线不受影响。
   */
  useExpression?: string;
  /** `series` 形状：哪个字段是时间轴（趋势按它排序） */
  axis?: 'time';
  /** 开文书时的初值。**模板给的是骨架，不编临床内容** —— 只用来填"新病人也算得出来"那种默认值 */
  defaultValue?: JsonValue;
}

/**
 * **专科控件定义**（K4 的"≥5 个专科控件"那一半）。
 *
 * ## 它和 ExpressionDefinition 的分工
 *
 *   - `expression` 回答"这个值**怎么算**"（标量、无界面）；
 *   - `control`   回答"这个控件**长什么样、填什么**"（结构、有界面）。
 *
 * 两者都进包、都是**纯声明**：控件里没有任何可执行内容，"怎么算"一律推给表达式。
 *
 * ## 内置与自定义走同一条路
 *
 * `ctrl.std.*` 是随产品分发的标准控件，`ctrl.custom.N` 是院内自建 ——
 * 形状与校验完全一样，差别只在谁维护。**模型只有一条路**（否则"内置那套"与"自定义那套"
 * 会各自漂移，历史病历里出现两种解读方式）。
 */
export interface ControlDefinition extends PackItemBase {
  itemType: 'control';
  /** `ctrl.std.*`（随产品）/ `ctrl.custom.N`（院内自建） */
  itemId: string;
  name: string;
  /** 语义类型：质控条件与机读分类按它问"这是什么控件"（沿用既有六个取值） */
  controlKind: ControlKind;
  shape: ControlShape;
  /**
   * 定义版本，缺省 1。
   *
   * **改了字段语义就必须升版，绝不原地改**：已开出的病历里存的是当时那份字段快照，
   * 原地改会让"同一份 payload 在两次导出里被解读成两种意思"。
   */
  version?: number;
  fields: ControlFieldDef[];
  /** `matrix` 形状的行（如 32 颗牙）；其它形状不给 */
  rows?: Array<{ key: string; label: string }>;
  /** `matrix` 形状的列（如 龋 / 充填 / 缺失） */
  columns?: Array<{ key: string; label: string }>;
  layout?: { columns?: number; maxPoints?: number };
  description?: string;
  /** 跨院识别：机身之外的那一层（同 name 不同 code 的两份控件是两件事） */
  code?: { system: string; code: string; display?: string };
}

export type TemplatePackItem = TemplateDefinition | ExpressionDefinition | FragmentDefinition | ControlDefinition;

/**
 * 模板包。与规则包走**同一套通用层**（清单校验 / 契约匹配 / 冲突 / 开关 / 指纹），
 * 差别只在条目形状 —— 这正是把"包"抽成类别无关那一层的收益。
 */
export type TemplatePack = Pack<TemplatePackItem>;

/* ---------------------------- 实例化上下文 ---------------------------- */

/**
 * 上下文：表达式 `ctx:` 与文本占位符 `{{...}}` 的取值来源。
 * 全部是标量 —— 上下文里的东西要么是"事实"（患者、就诊、时间），要么没有。
 */
export interface TemplateContext {
  [path: string]: ExprValue | undefined;
}

export interface InstantiateInput {
  templateId: string;
  docId: string;
  createdBy: string;
  patient: { patientId: string; nameMasked?: string; gender?: 'M' | 'F' | 'U'; birthDate?: string };
  encounter?: { visitId?: string; visitType?: 'outpatient' | 'inpatient' | 'emergency' | 'physical-exam'; deptCode?: string; admittedAt?: string; dischargedAt?: string };
  /**
   * 开单医生。
   *
   * **只有账号（`actorId`），没有姓名**：本系统的账号里就没有姓名字段
   * （`auth/user-store.ts` 的 `AdminUser`）。给一个取不到值的 `doctor.name`，
   * 表现是"这一格一直空着"，而人会以为是模板配错了。
   */
  doctor?: { actorId?: string };
  /** 实例化时间（ISO8601）：**必须由调用方给**，否则同一次实例化两次跑出来的时间戳不同 */
  at: string;
  /**
   * 覆盖/补充上下文（优先级高于由 patient/encounter/doctor/at 派生的默认值）。
   *
   * 用途是**那些引擎自己查不到的**上下文：`encounter.deptName` 要靠科室字典翻译，
   * 而字典在库侧、不在模板引擎手里（引擎只管"把给它的值填进去"）。
   */
  context?: TemplateContext;
}

/** 实例化产物：一份**待医生填写的草稿** + 如实上报的告警 */
export interface InstantiateResult {
  templateId: string;
  /** 产出处的出处标识（包#模板@内容指纹）—— 写进每个节点的 evidence */
  source: string;
  /** 槽位 key → 生成的节点 id（便于后续"按槽位定位"，如把外部数据填回某个数据元） */
  slots: Record<string, string>;
  warnings: string[];
}
