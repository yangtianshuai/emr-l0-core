// T17 · OFD / OFD-H 导出（零依赖）。
// 且演示私钥可由种子推导 —— 生产必须换成经认证的密码模块（见 src/crypto/provider.ts）。

import { DOCUMENT_COVERS, signTargets, verifyTargets, type SignatureBlock, type SignatureTarget, type VerifySignatureResult } from '../crypto/signature.ts';
import { utf8 } from '../crypto/sm3.ts';
import type { Signer } from '../crypto/provider.ts';
import { parseSignaturesXml, signaturesXml } from '../crypto/ofd-signature-xml.ts';
import { orderedNodeIds } from '../model/machine.ts';
import { controlCellsOf } from '../model/control.ts';
import { IMAGE_EXTENSION, pixelsToPt, probeImage, type ImageMime } from '../media/image-probe.ts';
import type { ControlNode, DataElementTag, DocNode, DocumentModel, MachineReadableBlock, NodeId } from '../model/types.ts';
import { buildZip, type ZipEntry } from './zip.ts';

export interface OfdLayoutPlan {
  /** 必须是 false：文本路径化会让文件在视觉上正确、机器上不可抽取（"可视化陷阱"） */
  textAsPath: boolean;
  pageWidthPt?: number;
  pageHeightPt?: number;
  marginPt?: number;
  fontSizePt?: number;
  lineHeightPt?: number;
  /**
   * 段前间距（pt）。
   * 这不是排版美观问题，而是"段落边界能否被还原"的信息载体：
   * 若所有行等距且同缩进，版式文件里段落边界在原理上不可恢复（实测踩到），
   * 导出端必须把边界"画"出来（段前间距 + 首行缩进），导入端才可能聚回段落。
    */
  paragraphGapPt?: number;
  /** 正文段首行缩进（pt）：中文排版习惯，也是段落边界的第二重线索 */
  firstLineIndentPt?: number;
  /**
   * 装订边（pt）：只加在左侧的额外留白，供纸质病历左侧装订。
   * 默认 0（不改动既有版式）；启用后正文左边界与可用宽度同时收窄，
   * 装订孔不会压到文字 —— 这是纸质归档的实际要求，不是排版美观问题。
    */
  bindingMarginPt?: number;
  /** 页眉区高度（pt）。未指定且启用页眉时按行高 × 1.5 推导 */
  headerHeightPt?: number;
  /** 页脚区高度（pt）。未指定且启用页脚时按行高 × 1.5 推导 */
  footerHeightPt?: number;
}

export interface OfdFurniturePlan {
  /**
   * 页眉模板。占位符：`{docType}` `{patient}` `{visitId}` `{page}` `{pages}` `{docId}`。
   * 空串表示不出页眉。
   */
  header?: string;
  footer?: string;
}

export interface OfdExportPlan {
  layout: OfdLayoutPlan;
  machineReadable: {
    /** 必须是 true：机读信息必须纳入签名覆盖范围 */
    signed: boolean;
    carrier?: 'separate-xml' | 'inline';
  };
  /** 页眉/页脚计划；不传则用 DEFAULT_FURNITURE（打印链路的默认安全值） */
  furniture?: OfdFurniturePlan;
}

export const DEFAULT_LAYOUT: Required<Omit<OfdLayoutPlan, 'textAsPath'>> = {
  pageWidthPt: 595,
  pageHeightPt: 842,
  marginPt: 56,
  fontSizePt: 10.5,
  lineHeightPt: 16,
  paragraphGapPt: 6,
  firstLineIndentPt: 21,
  bindingMarginPt: 0,
  headerHeightPt: 0,
  footerHeightPt: 0,
};

export const DEFAULT_FURNITURE: Required<OfdFurniturePlan> = {
  header: '{docType} · 患者 {patient}{visitId} · 共 {pages} 页',
  footer: '第 {page} 页 共 {pages} 页 · 文书号 {docId}',
};

/**
 * 装饰层（页眉/页脚/水印）的 Layer ID 前缀 —— 导出与导入两侧的共同契约。
 * 导入端据此把页码从正文行流中分出来（而不是混进正文，也不是静默丢弃）。
  */
export const FURNITURE_LAYER_PREFIX = 'layer-furniture';
export const HEADER_LAYER_ID = `${FURNITURE_LAYER_PREFIX}-header`;
export const FOOTER_LAYER_ID = `${FURNITURE_LAYER_PREFIX}-footer`;

/** 版式块的种类：导入侧据此判断"这一段该不该缩进/是否标题" */
export type BlockKind = 'title' | 'body' | 'list' | 'table' | 'signature' | 'other';

/**
 * 版面里的一块图（pt）。`resourceId` 是容器内 `DocumentRes.xml` 的 `MultiMedia` ID ——
 * 图片不是文本对象，它在 Content.xml 里是 `ImageObject` + `ResourceID`，
 * 字节本体在 `Res/MultiMedia/` 下。三者（对象 / 资源清单 / 字节）必须同进同出，
 * 少任何一个，归档件里的图就是一张空框。
  */
export interface RenderImage {
  resRef: string;
  /** 指向容器内资源（`MM_1`）。导出前由 `buildOfdPackage` 分配好 */
  resourceId: string;
  altText?: string;
  widthPt: number;
  heightPt: number;
}

export interface RenderLine {
  text: string;
  fontSize: number;
  bold: boolean;
  nodeId: NodeId;
  /**
   * 该行属于哪个版式块（= 来源节点 id）。
   * 同一节点被折行拆出的多行共享同一个 nodeId —— 导入侧正是靠"同块续行"把它们合回一段。
    */
  blockKind?: BlockKind;
  /**
   * 这一行是一张图：`text` 为空（纸面上不产文字对象，否则会与图重叠），
   * 由 `contentXml` 改产 `ImageObject`。`y` 对图片行是图框顶部，
   * 对文字行是基线 —— 两处用法各自明确，别把 `y - fontSize` 套到图上。
    */
  image?: RenderImage;
}

/** 图片排版的输入：一张图在版面上占多大（已按正文可用宽度封顶） */
export interface RenderLinePlan {
  /**
   * 由调用方按正文可用宽度封顶后给出尺寸 —— `renderLines` 既不知道版心宽度，
   * 也拿不到图片字节（它必须保持纯函数、可单测）。
   * 返回 null = 这个地址取不到可用的图（文件缺失 / 不是图片）：此时画一行占位文字，
   * 而不是静默跳过 —— 归档件少一块而没人知道，是最难查的一类缺页。
    */
  imageBoxOf?: (resRef: string, altText: string) => { widthPt: number; heightPt: number; resourceId: string } | null;
}

export interface OfdPackage {
  entries: ZipEntry[];
  bytes: Uint8Array;
  pages: number;
  stats: { textObjects: number; textChars: number; dataElements: number; bytes: number };
  /** 容器级签名块（无签章文档为 null），供导出后立即自检或第三方验签 */
  signature: SignatureBlock | null;
  warnings: string[];
}

export interface OfdExportOptions {
  date?: Date;
  /**
   * 签名后端。文档已签章时必须提供：否则会导出一份"已签章但没有签名值"的文件，
   * 那是最糟的产物（看起来已签、实际无签名）。
    */
  signer?: Signer;
  /**
   * 取一张图的字节。由调用方注入：`export/ofd.ts` 是纯函数层，
   * 不认识"图存在哪儿"（demo 存在 `state/resources`，用例用内存夹具）。
   * 返回 null = 取不到：纸面画一行 `[图片缺失：…]` 并记进 `warnings`，
   * 不静默跳过 —— 归档件少一块而没人知道，比导出失败更难查。
    */
  resolveImage?: (resRef: string) => Uint8Array | null;
}

/**
 * 独立验签：从容器 entries 里解析 Signatures.xml，按 SignedInfo 里的 Reference 清单
 * 重新计算每个文件的 SM3，再用内嵌公钥验 SM2 签名。
 * 完全不依赖签名时的内存状态 —— 这正是"第三方可验证"的含义。
  */
export function verifyOfdEntries(entries: ZipEntry[]): VerifySignatureResult | null {
  const signatureEntry = entries.find((entry) => /Signatures\.xml$/.test(entry.path));
  if (!signatureEntry) return null;
  const text = typeof signatureEntry.data === 'string' ? signatureEntry.data : new TextDecoder('utf-8').decode(signatureEntry.data);
  const block = parseSignaturesXml(text);
  if (!block) return null;
  const targets: SignatureTarget[] = block.references
    .map((reference) => {
      const entry = entries.find((item) => item.path === reference.path);
      if (!entry) return null;
      return { path: reference.path, bytes: typeof entry.data === 'string' ? utf8(entry.data) : entry.data };
    })
    .filter((target): target is SignatureTarget => target !== null);
  /* 容器里必然存在未被签名覆盖的文件（OFD.xml / DocumentRes.xml 等），故不要求全覆盖 */
  return verifyTargets(block, targets, { requireAllCovered: false });
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 估算文本宽度（pt）：CJK/全角按 1 em，其余按 0.5 em；用于换行与分页估算 */
export function estimateWidth(text: string, fontSizePt: number): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? fontSizePt : fontSizePt * 0.5;
  }
  return width;
}

function wrapLine(text: string, fontSizePt: number, maxWidth: number): string[] {
  if (text.length === 0) return [''];
  const out: string[] = [];
  let current = '';
  let width = 0;
  for (const char of text) {
    const charWidth = estimateWidth(char, fontSizePt);
    if (width + charWidth > maxWidth && current.length > 0) {
      out.push(current);
      current = '';
      width = 0;
    }
    current += char;
    width += charWidth;
  }
  out.push(current);
  return out;
}

function fieldText(node: Extract<DocNode, { type: 'field' }>): string {
  const label = node.tags?.[0]?.display ?? '';
  const value = node.valueText ?? (node.value === null || node.value === undefined ? '' : String(node.value));
  return [label, value, node.unit ?? ''].filter((part) => part !== '').join(' ');
}

function inlinePart(node: DocNode): string | null {
  if (node.type === 'text') return node.runs.map((run) => run.text).join('');
  if (node.type === 'field') return fieldText(node);
  if (node.type === 'image') return `[图像：${node.altText ?? node.resRef}]`;
  if (node.type === 'control') return `[控件：${node.controlKind}]`;
  return null;
}

/** 把文档渲染为有序"逻辑行"（与页面无关，便于单测） */
export function renderLines(doc: DocumentModel, plan: RenderLinePlan = {}): RenderLine[] {
  const nodes = doc.nodes;
  const base = DEFAULT_LAYOUT.fontSizePt;
  const lines: RenderLine[] = [];
  const consumed = new Set<NodeId>();

  /**
   * 预建"父 → 有序子"映射（一次遍历）。
   *
   *  早期实现在每个节点上都做 `Object.values(nodes).filter(item => item.parentId === id)`，
   * 那是 O(n²)：1000 页（32k 节点）实测导出耗时 169 秒（约 10 亿次比较）。
   * 阴险之处是 100 页时只表现为"有点慢"（0.85s），完全看不出结构性缺陷 ——
   * 只有把规模推上去才会暴露。任何"在循环里扫全表"的写法都会长成这样。
    */
  const childMap: Record<string, DocNode[]> = {};
  for (const item of Object.values(nodes)) {
    if (item.parentId === null || item.parentId === undefined) continue;
    const bucket = childMap[item.parentId] ?? (childMap[item.parentId] = []);
    bucket.push(item);
  }
  for (const bucket of Object.values(childMap)) bucket.sort((a, b) => a.order - b.order);
  const kidsOf = (id: NodeId): DocNode[] => childMap[id] ?? [];

  const push = (
    text: string,
    nodeId: NodeId,
    options: { fontSize?: number; bold?: boolean; prefix?: string; blockKind?: BlockKind } = {},
  ): void => {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (trimmed.length === 0) return;
    lines.push({
      text: `${options.prefix ?? ''}${trimmed}`,
      fontSize: options.fontSize ?? base,
      bold: options.bold === true,
      nodeId,
      blockKind: options.blockKind ?? 'body',
    });
  };

  const pushControl = (node: ControlNode): void => {
    const controlName = (node.provenance.evidence ?? [])
      .find((evidence) => evidence.field === 'control')?.valueText;
    push(controlName ?? node.definitionId ?? '专科控件', node.id);
    /* 空格不导出（"没填"与"填了个空"在纸面上都是空着，但纸面只关心有没有内容） */
    const cellByKey = new Map(controlCellsOf(node).map((cell) => [cell.key, cell]));
    const isImageShape = node.shape === 'image';
    for (const [cellKey, cellValue] of Object.entries(node.payload ?? {})) {
      const cell = cellByKey.get(cellKey);
      if (!cell || cellValue === null || cellValue === undefined || cellValue === '') continue;
      push(
        isImageShape
          ? `${cell.label}：[影像：${String(cellValue)}]`
          : `${cell.label}：${String(cellValue)}${cell.unit ? ` ${cell.unit}` : ''}`,
        node.id,
      );
    }
  };

  const pushImage = (node: Extract<DocNode, { type: 'image' }>): void => {
    const altText = node.altText ?? '';
    /* 空槽（`resRef` 是空串）不是"图丢了"，是"还没贴"。
       纸面上必须把这两件事分开：都写成「图片缺失」的话，审计会去追一起
       根本没发生过的资源事故，而真正该催的是"这一格还没填"。 */
    if (node.resRef === '') {
      push(`[待贴图${altText ? `：${altText}` : ''}]`, node.id);
      return;
    }
    const box = plan.imageBoxOf?.(node.resRef, altText) ?? null;
    if (!box) {
      push(`[图片缺失：${altText || node.resRef}]`, node.id);
      return;
    }
    lines.push({
      text: '',
      fontSize: base,
      bold: false,
      nodeId: node.id,
      image: {
        resRef: node.resRef,
        resourceId: box.resourceId,
        ...(altText ? { altText } : {}),
        widthPt: box.widthPt,
        heightPt: box.heightPt,
      },
    });
    /* 图注排在图下方、字号小一号：它是这张图的说明而不是正文。
       同 nodeId ⇒ 紧贴图不空行（`paginatePages` 只在不同 nodeId 之间加段前间距）。 */
    if (node.caption) push(node.caption, node.id, { fontSize: Math.max(7, base - 1) });
  };

  const listMarkerOf = (node: Extract<DocNode, { type: 'listItem' }>): string => {
    const parent = node.parentId === null || node.parentId === undefined ? undefined : nodes[node.parentId];
    if (!parent || parent.type !== 'listGroup' || parent.ordered !== true) return '· ';
    const index = kidsOf(parent.id)
      .filter((child) => child.type === 'listItem')
      .findIndex((child) => child.id === node.id);
    return `${index + 1}. `;
  };

  for (const id of orderedNodeIds({ nodes, rootId: doc.rootId })) {
    const node = nodes[id];
    if (!node || consumed.has(node.id)) continue;

    switch (node.type) {
      case 'section': {
        push(node.title ?? node.sectionCode ?? '', node.id, { fontSize: base + 2, bold: true, blockKind: 'title' });
        break;
      }
      case 'paragraph': {
        const parts: string[] = [];
        for (const child of kidsOf(node.id)) {
          /* 控件是块级内容：先把它前面那截句子成行，再让它整块自成几行。
             不这样做，`inlinePart` 会把它压成 `[控件：kind]` 一行内部标识。  */
          if (child.type === 'control') {
            consumed.add(child.id);
            push(parts.join(''), node.id);
            parts.length = 0;
            pushControl(child);
            continue;
          }
          /* 图同样是块级内容：贴图挂在段落下面（`parentId` 就是段落），
             不在这里单独成块，`inlinePart` 只会吐一句 `[图像：地址]`，
             而图本身一个字都不会进归档件。 */
          if (child.type === 'image') {
            consumed.add(child.id);
            push(parts.join(''), node.id);
            parts.length = 0;
            pushImage(child);
            continue;
          }
          const part = inlinePart(child);
          if (part === null) continue;
          consumed.add(child.id);
          if (part.trim().length > 0) parts.push(part.trim());
        }
        push(parts.join(''), node.id);
        break;
      }
      case 'listItem': {
        const parts: string[] = [];
        const prefix = listMarkerOf(node);
        for (const child of kidsOf(node.id)) {
          if (child.type === 'control') {
            consumed.add(child.id);
            push(parts.join(''), node.id, { prefix, blockKind: 'list' });
            parts.length = 0;
            pushControl(child);
            continue;
          }
          if (child.type === 'image') {
            consumed.add(child.id);
            push(parts.join(''), node.id, { prefix, blockKind: 'list' });
            parts.length = 0;
            pushImage(child);
            continue;
          }
          const part = inlinePart(child);
          if (part === null) continue;
          consumed.add(child.id);
          if (part.trim().length > 0) parts.push(part.trim());
        }
        push(parts.join(''), node.id, { prefix, blockKind: 'list' });
        break;
      }
      case 'table': {
        const rows = kidsOf(node.id);
        for (const row of rows) {
          consumed.add(row.id);
          const cells = kidsOf(row.id);
          const texts: string[] = [];
          for (const cell of cells) {
            consumed.add(cell.id);
            const parts: string[] = [];
            for (const child of kidsOf(cell.id)) {
              const part = inlinePart(child);
              if (part === null) continue;
              consumed.add(child.id);
              parts.push(part.trim());
            }
            texts.push(parts.join(''));
          }
          push(`| ${texts.join(' | ')} |`, row.id, { blockKind: 'table' });
        }
        break;
      }
      case 'signatureBlock': {
        push(`签名：${node.signerRole ?? 'author'} ${node.signerId ?? ''}`, node.id, { blockKind: 'signature' });
        break;
      }
      case 'text': {
        push(node.runs.map((run) => run.text).join(''), node.id);
        break;
      }
      case 'field': {
        push(fieldText(node), node.id);
        break;
      }
      case 'image': {
        /* 直接挂在章节（而非段落）下的图走这一支：与段落里的那一种共用 `pushImage`
           —— 两处各写一遍的结果是"同一张图换个挂法就变成一行文字"。 */
        pushImage(node);
        break;
      }
      case 'control': {
        /* 直接挂在章节（而非段落）下的控件走这一支：与段落里那一种共用同一份纸面画法
           （`pushControl`）—— 两处各写一遍的结果是"同一个控件换个挂法就少几行"。 */
        pushControl(node);
        break;
      }
      case 'extension': {
        push(`[扩展：${node.namespace}]`, node.id);
        break;
      }
      default:
        break;
    }
  }
  return lines;
}

export interface PlacedLine extends RenderLine {
  x: number;
  y: number;
  page: number;
}

/** 正文可用区：页眉、页脚、装订边都会压缩它 */
export interface ContentBox {
  /** 首行基线 */
  top: number;
  /** 末行基线上限 */
  bottom: number;
  left: number;
  maxWidth: number;
}

export function contentBox(
  layout: Required<Omit<OfdLayoutPlan, 'textAsPath'>>,
  headerHeightPt = 0,
  footerHeightPt = 0,
): ContentBox {
  return {
    top: layout.marginPt + headerHeightPt + layout.lineHeightPt,
    bottom: layout.pageHeightPt - layout.marginPt - footerHeightPt,
    left: layout.marginPt + layout.bindingMarginPt,
    maxWidth: layout.pageWidthPt - layout.marginPt * 2 - layout.bindingMarginPt,
  };
}

export function paginatePages(
  lines: RenderLine[],
  layout: Required<Omit<OfdLayoutPlan, 'textAsPath'>>,
  area: ContentBox = contentBox(layout),
): PlacedLine[][] {
  const pages: PlacedLine[][] = [];
  let page = 0;
  let y = area.top;
  let previousBlock: NodeId | null = null;

  const rowOf = (index: number): PlacedLine[] => {
    while (pages.length <= index) pages.push([]);
    return pages[index] as PlacedLine[];
  };

  for (const line of lines) {
    const atPageTop = y <= area.top + 0.01;
    const blockChanged = previousBlock !== null && previousBlock !== line.nodeId;
    /* 段前间距：把段落边界"画"出来，导入端才有线索可依（见 OfdLayoutPlan 注释）。
       标题前留更大空隙，标题因此也能被导入端按间距识别。 */
    if (blockChanged && !atPageTop) {
      y += line.blockKind === 'title' ? layout.paragraphGapPt * 1.5 : layout.paragraphGapPt;
    }
    const indent = line.blockKind === 'body' && blockChanged && !atPageTop ? layout.firstLineIndentPt : 0;

    /* 图：不可拆、不折行。放不下就整块换页；比一页还高时按比例缩到一页高 ——
       宁可缩小，也不要被页边裁掉半张（裁掉的正是"结论在哪"那一半）。
       `y` 在这里是图框顶部，不是基线。  */
    if (line.image) {
      const usable = area.bottom - area.top;
      const height = Math.min(line.image.heightPt, usable);
      const width = height === line.image.heightPt
        ? line.image.widthPt
        : line.image.widthPt * (height / line.image.heightPt);
      if (y + height > area.bottom + 0.01 && y > area.top + 0.01) {
        page += 1;
        y = area.top;
      }
      rowOf(page).push({ ...line, image: { ...line.image, widthPt: width, heightPt: height }, x: area.left, y, page });
      y += height + layout.paragraphGapPt;
      previousBlock = line.nodeId;
      continue;
    }

    /* 孤行控制：标题与其后两行必须同页，否则整块下移 */
    if (line.blockKind === 'title' && y > area.bottom - layout.lineHeightPt * 2) {
      page += 1;
      y = area.top;
    }

    const segments = wrapLine(line.text, line.fontSize, area.maxWidth - indent);
    for (const [index, segment] of segments.entries()) {
      if (y > area.bottom) {
        page += 1;
        y = area.top;
      }
      rowOf(page).push({ ...line, text: segment, x: area.left + (index === 0 ? indent : 0), y, page });
      y += layout.lineHeightPt;
    }
    previousBlock = line.nodeId;
  }
  return pages.length === 0 ? [[]] : pages;
}

/** 扁平形态：保持向后兼容（既有调用方与用例按"行数组"使用） */
export function paginate(lines: RenderLine[], layout: Required<Omit<OfdLayoutPlan, 'textAsPath'>>): PlacedLine[] {
  return paginatePages(lines, layout).flat();
}

export interface FurnitureVars {
  docType: string;
  patient: string;
  visitId: string;
  docId: string;
  page: number;
  pages: number;
}

/**
 * 页眉/页脚模板渲染。
 *
 * `{patient}` 由调用方传入脱敏姓名（`nameMasked`）；调用方在缺失时传"（未脱敏）"，
 * 而不是回落到 `patientId` —— 页眉是纸质件上最容易泄露身份的位置。
  */
export function renderFurniture(template: string, vars: FurnitureVars): string {
  return template
    .replace(/\{docType\}/g, vars.docType)
    .replace(/\{patient\}/g, vars.patient)
    .replace(/\{visitId\}/g, vars.visitId ? ` · ${vars.visitId}` : '')
    .replace(/\{docId\}/g, vars.docId)
    .replace(/\{page\}/g, String(vars.page))
    .replace(/\{pages\}/g, String(vars.pages))
    .trim();
}

/** 单行 → TextObject 片段。idPrefix 让"正文/页眉/页脚"三类对象在容器内也可区分 */
function textObjectXml(text: string, x: number, y: number, size: number, bold: boolean, idPrefix: string, index: number): string {
  const width = Math.max(1, estimateWidth(text, size));
  const height = size * 1.6;
  return [
    `        <ofd:TextObject ID="${idPrefix}${index}" Font="${bold ? 'F2' : 'F1'}" Size="${size}" Boundary="${x.toFixed(2)} ${(y - size).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}">`,
    `          <ofd:TextCode X="${x.toFixed(2)}" Y="${y.toFixed(2)}">${esc(text)}</ofd:TextCode>`,
    '        </ofd:TextObject>',
  ].join('\n');
}

function imageObjectXml(image: RenderImage, x: number, y: number, idPrefix: string, index: number): string {
  const width = image.widthPt.toFixed(2);
  const height = image.heightPt.toFixed(2);
  return [
    `        <ofd:ImageObject ID="${idPrefix}${index}" ResourceID="${esc(image.resourceId)}" Boundary="${x.toFixed(2)} ${y.toFixed(2)} ${width} ${height}" CTM="${width} 0 0 ${height} 0 0">`,
    '        </ofd:ImageObject>',
  ].join('\n');
}

function contentXml(
  pageLines: PlacedLine[],
  layout: Required<Omit<OfdLayoutPlan, 'textAsPath'>>,
  pageIndex: number,
  pageCount: number,
  furniture: Required<OfdFurniturePlan>,
  furnitureVars: Omit<FurnitureVars, 'page' | 'pages'>,
  headerHeightPt: number,
  footerHeightPt: number,
): string {
  const size = Math.max(7, layout.fontSizePt - 1.5);
  const layers: string[] = [];

  if (furniture.header) {
    const text = renderFurniture(furniture.header, { ...furnitureVars, page: pageIndex + 1, pages: pageCount });
    if (text !== '') {
      const y = layout.marginPt + headerHeightPt - size * 0.4;
      layers.push(
        [`      <ofd:Layer ID="${HEADER_LAYER_ID}">`, textObjectXml(text, layout.marginPt + layout.bindingMarginPt, y, size, false, 'hdr_', 0), '      </ofd:Layer>'].join('\n'),
      );
    }
  }

  const objects = pageLines
    .map((line, index) => (line.image
      ? imageObjectXml(line.image, line.x, line.y, 'i', index)
      : textObjectXml(line.text, line.x, line.y, line.fontSize, line.bold, 't', index)))
    .join('\n');
  layers.push(['      <ofd:Layer ID="layer0">', objects, '      </ofd:Layer>'].join('\n'));

  if (furniture.footer) {
    const text = renderFurniture(furniture.footer, { ...furnitureVars, page: pageIndex + 1, pages: pageCount });
    if (text !== '') {
      const y = layout.pageHeightPt - layout.marginPt - footerHeightPt + size * 1.6;
      layers.push(
        [`      <ofd:Layer ID="${FOOTER_LAYER_ID}">`, textObjectXml(text, layout.marginPt + layout.bindingMarginPt, y, size, false, 'ftr_', 0), '      </ofd:Layer>'].join('\n'),
      );
    }
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ofd:Page xmlns:ofd="http://www.ofd.org/OFD" ID="__PAGE_ID__">',
    '  <ofd:Area>',
    `    <ofd:PhysicalBox>0 0 ${layout.pageWidthPt} ${layout.pageHeightPt}</ofd:PhysicalBox>`,
    '  </ofd:Area>',
    '  <ofd:Content>',
    layers.join('\n'),
    '  </ofd:Content>',
    '</ofd:Page>',
    '',
  ].join('\n');
}

function tagAttrs(tag: DataElementTag): string {
  return [`system="${esc(tag.system)}"`, `code="${esc(tag.code)}"`, tag.display ? `display="${esc(tag.display)}"` : ''].filter(Boolean).join(' ');
}

function machineXml(block: MachineReadableBlock, doc: DocumentModel): string {
  const elements = block.dataElements
    .map((element) => {
      const value = element.valueText ?? (element.value === null || element.value === undefined ? '' : String(element.value));
      const attrs = [
        tagAttrs(element.tag),
        `nodeId="${esc(element.nodeId)}"`,
        `origin="${esc(element.origin)}"`,
        element.unit ? `unit="${esc(element.unit)}"` : '',
        typeof element.confidence === 'number' ? `confidence="${element.confidence}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `  <ofdh:DataElement ${attrs}>${esc(value)}</ofdh:DataElement>`;
    })
    .join('\n');

  const refs = (block.keyContentRefs ?? [])
    .map((ref) => {
      const attrs = [ref.tag ? tagAttrs(ref.tag) : '', `nodeId="${esc(ref.nodeId)}"`, `present="${ref.present}"`].filter(Boolean).join(' ');
      return `  <ofdh:KeyContentRef ${attrs}/>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- 机读信息（"-H" 载体）：派生数据，不得人工编辑；sourceHash 用于陈旧检测 -->`,
    `<ofdh:MachineReadable xmlns:ofdh="urn:cn:ofdh:machine:1.0" generatedAt="${esc(block.generatedAt)}" generator="${esc(block.generator)}" modelSchemaVersion="${esc(block.modelSchemaVersion)}" sourceHash="${esc(block.sourceHash ?? '')}">`,
    `  <ofdh:Document docId="${esc(doc.docId)}" docTypeSystem="${esc(doc.docType.system)}" docTypeCode="${esc(doc.docType.code)}" status="${esc(doc.status)}"/>`,
    `  <ofdh:Patient patientId="${esc(doc.patient.patientId)}"${doc.patient.nameMasked ? ` nameMasked="${esc(doc.patient.nameMasked)}"` : ''}${doc.patient.gender ? ` gender="${esc(doc.patient.gender)}"` : ''}/>`,
    elements,
    refs,
    '</ofdh:MachineReadable>',
    '',
  ].join('\n');
}

/** 容器内一张图片资源：ID / 文件名 / 字节 / 像素与 DPI（排版要按它换算 pt） */
interface ImageResource {
  id: string;
  file: string;
  mime: ImageMime;
  bytes: Uint8Array;
  width: number;
  height: number;
  dpi: number;
}

/** OFD `MultiMedia` 的 Format 属性取值（大写，与大多数阅读器一致） */
function mediaFormatOf(mime: ImageMime): string {
  if (mime === 'image/jpeg') return 'JPEG';
  if (mime === 'image/webp') return 'WEBP';
  return 'PNG';
}

/**
 * 文档里用到的图片地址，按文档顺序去重。
 *
 * 顺序必须是文档顺序（而不是"谁先被访问"）：导出是可重放的，同一份病历两次导出的
 * 资源编号与容器布局应当逐字节一致 —— 否则"同一份病历的两个归档件指纹不同"，
 * 而指纹正是用来判断"有没有被人动过"的。
  */
function imageRefsOf(doc: DocumentModel): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of orderedNodeIds({ nodes: doc.nodes, rootId: doc.rootId })) {
    const node = doc.nodes[id];
    if (!node || node.type !== 'image') continue;
    if (node.resRef === '' || seen.has(node.resRef)) continue;
    seen.add(node.resRef);
    out.push(node.resRef);
  }
  return out;
}

async function containerSignature(doc: DocumentModel, entries: ZipEntry[], options: OfdExportOptions): Promise<SignatureBlock | null> {
  const ref = doc.signatureRefs?.[0];
  if (!ref) return null;
  if (!options.signer) {
    throw new Error('文档已签章，但导出时未提供签名后端（signer）——不允许导出"无签名的已签章文件"');
  }

  const covers = ref.covers && ref.covers.length > 0 ? ref.covers : [...DOCUMENT_COVERS];
  /* covers 里写的是逻辑名（Document.xml / Pages/Page_0/Content.xml / MachineReadable.xml），
     容器内的真实路径统一加 Doc_0/ 前缀 */
  const paths = new Set(covers.map((name) => (name.startsWith('Doc_0/') ? name : `Doc_0/${name}`)));
  /* 资源类文件必须一并覆盖：字体清单与图片字节由导出过程生成，
     文档签章那一刻不可能把它们写进 covers。漏签的后果很实在：
     把 Res/MultiMedia/1.png 换成一另一张图、ResourceID 仍指同一个文件名，
     签名照样验得过 —— 那等于"图可以换而病历没被改过"。
     只补容器里真实存在的 Res/* 文件（不凭空要求）。  */
  for (const entry of entries) {
    if (entry.path.startsWith('Doc_0/Res/')) paths.add(entry.path);
  }
  const targets: SignatureTarget[] = [...paths].map((path) => {
    const entry = entries.find((item) => item.path === path);
    if (!entry) {
      throw new Error(`签名覆盖清单里的文件在容器中不存在：${path}（不允许对不存在的文件签名）`);
    }
    return { path, bytes: typeof entry.data === 'string' ? utf8(entry.data) : entry.data };
  });

  return signTargets(
    targets,
    {
      signatureRef: ref.signatureRef,
      documentId: doc.docId,
      signerRole: ref.signerRole ?? 'author',
      signerId: ref.signerId ?? '',
      signedAt: ref.signedAt ?? doc.updatedAt,
    },
    options.signer,
  );
}

export async function buildOfdPackage(doc: DocumentModel, plan: OfdExportPlan, options: OfdExportOptions = {}): Promise<OfdPackage> {
  const layout: Required<Omit<OfdLayoutPlan, 'textAsPath'>> = {
    pageWidthPt: plan.layout.pageWidthPt ?? DEFAULT_LAYOUT.pageWidthPt,
    pageHeightPt: plan.layout.pageHeightPt ?? DEFAULT_LAYOUT.pageHeightPt,
    marginPt: plan.layout.marginPt ?? DEFAULT_LAYOUT.marginPt,
    fontSizePt: plan.layout.fontSizePt ?? DEFAULT_LAYOUT.fontSizePt,
    lineHeightPt: plan.layout.lineHeightPt ?? DEFAULT_LAYOUT.lineHeightPt,
    paragraphGapPt: plan.layout.paragraphGapPt ?? DEFAULT_LAYOUT.paragraphGapPt,
    firstLineIndentPt: plan.layout.firstLineIndentPt ?? DEFAULT_LAYOUT.firstLineIndentPt,
    bindingMarginPt: plan.layout.bindingMarginPt ?? DEFAULT_LAYOUT.bindingMarginPt,
    headerHeightPt: plan.layout.headerHeightPt ?? DEFAULT_LAYOUT.headerHeightPt,
    footerHeightPt: plan.layout.footerHeightPt ?? DEFAULT_LAYOUT.footerHeightPt,
  };
  const block = doc.machineReadable;
  if (!block) throw new Error('文档缺少 machineReadable，导出前必须先派生机读信息');

  const furniture: Required<OfdFurniturePlan> = {
    header: plan.furniture?.header ?? DEFAULT_FURNITURE.header,
    footer: plan.furniture?.footer ?? DEFAULT_FURNITURE.footer,
  };
  /* 页眉/页脚区高度：未显式指定时按行高 × 1.5 推导 —— 否则正文会与页码重叠 */
  const headerHeightPt = furniture.header === '' ? 0 : layout.headerHeightPt > 0 ? layout.headerHeightPt : layout.lineHeightPt * 1.5;
  const footerHeightPt = furniture.footer === '' ? 0 : layout.footerHeightPt > 0 ? layout.footerHeightPt : layout.lineHeightPt * 1.5;
  const furnitureVars = {
    docType: doc.docType.display,
    /* 只印脱敏姓名；缺失时写"（未脱敏）"，绝不回落到 patientId  */
    patient: doc.patient.nameMasked ?? '（未脱敏）',
    visitId: doc.encounter?.visitId ?? '',
    docId: doc.docId,
  };

  /* ---------- 图片资源：先收齐、再排版 ----------
     顺序不能反：排版要知道"这张图占多宽多高"，而尺寸只能从图片字节本身来（像素 ÷ DPI）。
     反过来"让界面把宽高报上来"是不行的 —— 同一张图从剪贴板贴、从文件拖、从 PACS 取，
     三条路的宽高来源各不相同，归档件就会因为"图是怎么进来的"而长得不一样。  */
  const imageResources = new Map<string, ImageResource>();
  const warnings: string[] = [];
  for (const resRef of imageRefsOf(doc)) {
    const bytes = options.resolveImage?.(resRef) ?? null;
    if (!bytes) {
      warnings.push(`图片取不到（${resRef}）：纸面已画成「[图片缺失：…]」占位，归档件里没有这张图`);
      continue;
    }
    const probed = probeImage(bytes);
    if (!probed) {
      warnings.push(`图片格式无法识别（${resRef}）：只接受 PNG / JPEG / WebP，归档件里没有这张图`);
      continue;
    }
    const index = imageResources.size + 1;
    imageResources.set(resRef, {
      id: `MM_${index}`,
      file: `${index}.${IMAGE_EXTENSION[probed.mime]}`,
      mime: probed.mime,
      bytes,
      width: probed.width,
      height: probed.height,
      dpi: probed.dpi,
    });
  }

  const pageArea = contentBox(layout, headerHeightPt, footerHeightPt);
  const imageBoxOf = (resRef: string): { widthPt: number; heightPt: number; resourceId: string } | null => {
    const resource = imageResources.get(resRef);
    if (!resource) return null;
    const naturalWidth = pixelsToPt(resource.width, resource.dpi);
    const naturalHeight = pixelsToPt(resource.height, resource.dpi);
    const scale = naturalWidth > pageArea.maxWidth ? pageArea.maxWidth / naturalWidth : 1;
    return { widthPt: naturalWidth * scale, heightPt: naturalHeight * scale, resourceId: resource.id };
  };

  const lines = renderLines(doc, { imageBoxOf });
  const pages = paginatePages(lines, layout, pageArea);
  const pageCount = pages.length;
  const placed = pages.flat();

  const entries: ZipEntry[] = [];
  entries.push({
    path: 'OFD.xml',
    data: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ofd:OFD xmlns:ofd="http://www.ofd.org/OFD" Version="1.1" DocType="OFD">',
      '  <ofd:DocBody>',
      `    <ofd:DocInfo><ofd:DocID>${esc(doc.docId)}</ofd:DocID><ofd:Creator>L0-Demo</ofd:Creator><ofd:CreatorVersion>1.0</ofd:CreatorVersion></ofd:DocInfo>`,
      '    <ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot>',
      '  </ofd:DocBody>',
      '</ofd:OFD>',
      '',
    ].join('\n'),
  });

  const pageRefs = Array.from({ length: pageCount }, (_, index) => `    <ofd:Page ID="Page_${index}" BaseLoc="Pages/Page_${index}/Content.xml"/>`).join('\n');
  entries.push({
    path: 'Doc_0/Document.xml',
    data: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ofd:Document xmlns:ofd="http://www.ofd.org/OFD">',
      '  <ofd:CommonData>',
      '    <ofd:MaxUnitID>9999</ofd:MaxUnitID>',
      '    <ofd:PageArea>',
      `      <ofd:PhysicalBox>0 0 ${layout.pageWidthPt} ${layout.pageHeightPt}</ofd:PhysicalBox>`,
      '    </ofd:PageArea>',
      `    <ofd:DocumentRes>Doc_0/Res/DocumentRes.xml</ofd:DocumentRes>`,
      `    <ofd:Author>${esc(doc.createdBy)}</ofd:Author>`,
      `    <ofd:CreationDate>${esc(doc.createdAt)}</ofd:CreationDate>`,
      `    <ofd:ModDate>${esc(doc.updatedAt)}</ofd:ModDate>`,
      doc.encounter?.visitId ? `    <ofd:CustomDatas><ofd:CustomData Name="VisitID">${esc(doc.encounter.visitId)}</ofd:CustomData></ofd:CustomDatas>` : '',
      '  </ofd:CommonData>',
      '  <ofd:Pages>',
      pageRefs,
      '  </ofd:Pages>',
      '</ofd:Document>',
      '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
  });

  /* 逐页生成：pages 已按页分桶，这里不再对全量行做 filter（见 paginatePages 注释） */
  for (let index = 0; index < pageCount; index += 1) {
    entries.push({
      path: `Doc_0/Pages/Page_${index}/Content.xml`,
      data: contentXml(
        pages[index] ?? [],
        layout,
        index,
        pageCount,
        furniture,
        furnitureVars,
        headerHeightPt,
        footerHeightPt,
      ).replace('__PAGE_ID__', `Page_${index}`),
    });
  }

  entries.push({
    path: 'Doc_0/Res/DocumentRes.xml',
    data: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ofd:Res xmlns:ofd="http://www.ofd.org/OFD" BaseLoc="Res">',
      '  <ofd:Fonts>',
      '    <ofd:Font ID="F1" FontName="SimSun" FamilyName="宋体"/>',
      '    <ofd:Font ID="F2" FontName="SimHei" FamilyName="黑体"/>',
      '  </ofd:Fonts>',
      /* 图片资源清单：`MediaFile` 相对 `BaseLoc="Res"`，所以写 `MultiMedia/1.png`。
         少了这一段，Content.xml 里的 `ResourceID` 就是指向空气的引用 ——
         阅读器画不出图，而文件"看起来是完整的"。 */
      ...(imageResources.size === 0 ? [] : [
        '  <ofd:MultiMedias>',
        ...[...imageResources.values()].map((item) => [
          `    <ofd:MultiMedia ID="${esc(item.id)}" Type="Image" Format="${esc(mediaFormatOf(item.mime))}">`,
          `      <ofd:MediaFile>MultiMedia/${esc(item.file)}</ofd:MediaFile>`,
          '    </ofd:MultiMedia>',
        ].join('\n')),
        '  </ofd:MultiMedias>',
      ]),
      '</ofd:Res>',
      '',
    ].join('\n'),
  });

  /* 图片字节本体。打包顺序按 ID（= 文档顺序），保证同一份病历两次导出逐字节一致  */
  for (const item of imageResources.values()) {
    entries.push({ path: `Doc_0/Res/MultiMedia/${item.file}`, data: item.bytes });
  }

  entries.push({ path: 'Doc_0/MachineReadable.xml', data: machineXml(block, doc) });

  /* 签名放在最后：它要覆盖前面所有文件的真实字节 */
  const signature = await containerSignature(doc, entries, options);
  if (signature) entries.push({ path: 'Doc_0/Signatures/Signatures.xml', data: signaturesXml(signature) });

  const bytes = buildZip(entries, { date: options.date ?? new Date(doc.updatedAt) });
  /* 图片行不是文本对象（它们各自是一个 `ImageObject`）。把它算进 `textObjects`，
     统计就会说"这份病历有 42 个文本对象"，而实际读回来少一行 —— 排查时会绕远路。 */
  const textLines = placed.filter((line) => line.image === undefined);
  const textChars = textLines.reduce((sum, line) => sum + line.text.length, 0);
  return {
    entries,
    bytes,
    pages: pageCount,
    stats: { textObjects: textLines.length, textChars, dataElements: block.dataElements.length, bytes: bytes.length },
    signature,
    warnings,
  };
}
