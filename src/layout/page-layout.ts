import {
  DEFAULT_LAYOUT,
  contentBox,
  paginatePages,
  pageFurniture,
  renderFurniture,
  renderLines,
  type ContentBox,
  type OfdFurniturePlan,
  type OfdLayoutPlan,
  type RenderImage,
  type RenderLinePlan,
} from '../export/ofd.ts';
import { probeImage, pixelsToPt } from '../media/image-probe.ts';
import { breakBeforeOf } from '../model/presentation.ts';
import type { BlockKind } from '../export/ofd.ts';
import type { DocumentModel, NodeId } from '../model/types.ts';

export interface PageLayoutPlan {
  layout?: Partial<Omit<OfdLayoutPlan, 'textAsPath'>>;
  furniture?: OfdFurniturePlan;
  imageBoxOf?: RenderLinePlan['imageBoxOf'];
}

export interface LayoutLineView {
  nodeId: NodeId;
  text: string;
  /** 版心内坐标，单位 pt，原点在纸面左上角 */
  x: number;
  y: number;
  size: number;
  bold: boolean;
  blockKind: BlockKind;
  image?: RenderImage;
}

export interface LayoutPageView {
  /** 从 1 开始，与纸面页码一致 */
  number: number;
  /** 该页由"另起一页"强制产生（界面上要能说明为什么断在这里） */
  forcedBreak: boolean;
  header: string;
  footer: string;
  lines: LayoutLineView[];
}

export interface LayoutDocument {
  widthPt: number;
  heightPt: number;
  marginPt: number;
  bindingMarginPt: number;
  lineHeightPt: number;
  fontSizePt: number;
  headerHeightPt: number;
  footerHeightPt: number;
  content: ContentBox;
  /** 页眉页脚的位置与字号：与导出端 contentXml 的算法一致，界面照抄即可 */
  furniture: { x: number; size: number; headerY: number; footerY: number };
  pages: LayoutPageView[];
  stats: { pages: number; lines: number; chars: number };
}

function resolveLayout(plan?: PageLayoutPlan['layout']): Required<Omit<OfdLayoutPlan, 'textAsPath'>> {
  const source = plan ?? {};
  return {
    pageWidthPt: source.pageWidthPt ?? DEFAULT_LAYOUT.pageWidthPt,
    pageHeightPt: source.pageHeightPt ?? DEFAULT_LAYOUT.pageHeightPt,
    marginPt: source.marginPt ?? DEFAULT_LAYOUT.marginPt,
    fontSizePt: source.fontSizePt ?? DEFAULT_LAYOUT.fontSizePt,
    lineHeightPt: source.lineHeightPt ?? DEFAULT_LAYOUT.lineHeightPt,
    paragraphGapPt: source.paragraphGapPt ?? DEFAULT_LAYOUT.paragraphGapPt,
    firstLineIndentPt: source.firstLineIndentPt ?? DEFAULT_LAYOUT.firstLineIndentPt,
    bindingMarginPt: source.bindingMarginPt ?? DEFAULT_LAYOUT.bindingMarginPt,
    headerHeightPt: source.headerHeightPt ?? DEFAULT_LAYOUT.headerHeightPt,
    footerHeightPt: source.footerHeightPt ?? DEFAULT_LAYOUT.footerHeightPt,
  };
}

/**
 * 版心的唯一算法：预览、打印、导出都从这里取。
 * 行坐标由导出端同一套断行与分页算出，前端只负责按 pt 摆位置，不再让浏览器重排。
 */
export function contentArea(plan: PageLayoutPlan = {}): ContentBox {
  const layout = resolveLayout(plan.layout);
  const parts = pageFurniture(layout, plan.furniture);
  return contentBox(layout, parts.headerHeightPt, parts.footerHeightPt);
}

export function layoutDocument(doc: DocumentModel, plan: PageLayoutPlan = {}): LayoutDocument {
  const layout = resolveLayout(plan.layout);
  const parts = pageFurniture(layout, plan.furniture);
  const area = contentArea(plan);
  const breaks = breakBeforeOf(doc);
  const lines = renderLines(doc, plan.imageBoxOf ? { imageBoxOf: plan.imageBoxOf } : {});
  const pages = paginatePages(lines, layout, area, breaks);

  const vars = {
    docType: doc.docType.display,
    patient: doc.patient.nameMasked ?? '（未脱敏）',
    visitId: doc.encounter?.visitId ?? '',
    docId: doc.docId,
  };

  const views = pages.map((placed, index): LayoutPageView => {
    const first = placed[0];
    return {
      number: index + 1,
      forcedBreak: index > 0 && first !== undefined && breaks.has(first.nodeId),
      header: renderFurniture(parts.header, { ...vars, page: index + 1, pages: pages.length }),
      footer: renderFurniture(parts.footer, { ...vars, page: index + 1, pages: pages.length }),
      lines: placed.map((line) => ({
        nodeId: line.nodeId,
        text: line.text,
        x: Number(line.x.toFixed(2)),
        y: Number(line.y.toFixed(2)),
        size: line.fontSize,
        bold: line.bold,
        blockKind: line.blockKind ?? 'body',
        ...(line.image ? { image: line.image } : {}),
      })),
    };
  });

  const placed = pages.flat();
  const furnitureSize = Math.max(7, layout.fontSizePt - 1.5);
  return {
    widthPt: layout.pageWidthPt,
    heightPt: layout.pageHeightPt,
    marginPt: layout.marginPt,
    bindingMarginPt: layout.bindingMarginPt,
    lineHeightPt: layout.lineHeightPt,
    fontSizePt: layout.fontSizePt,
    headerHeightPt: parts.headerHeightPt,
    footerHeightPt: parts.footerHeightPt,
    content: area,
    furniture: {
      x: layout.marginPt + layout.bindingMarginPt,
      size: furnitureSize,
      headerY: layout.marginPt + parts.headerHeightPt - furnitureSize * 0.4,
      footerY: layout.pageHeightPt - layout.marginPt - parts.footerHeightPt + furnitureSize * 1.6,
    },
    pages: views,
    stats: {
      pages: views.length,
      lines: placed.length,
      chars: placed.reduce((sum, line) => sum + line.text.length, 0),
    },
  };
}

/** 图片按版心等比缩放；取不到或认不出就返回 null，纸面画占位（与导出件同一口径） */
export function imageBoxResolver(area: ContentBox, read: (resRef: string) => Uint8Array | null): RenderLinePlan['imageBoxOf'] {
  return (resRef: string) => {
    const bytes = read(resRef);
    if (!bytes) return null;
    const probed = probeImage(bytes);
    if (!probed) return null;
    const naturalWidth = pixelsToPt(probed.width, probed.dpi);
    const naturalHeight = pixelsToPt(probed.height, probed.dpi);
    const scale = naturalWidth > area.maxWidth ? area.maxWidth / naturalWidth : 1;
    return { widthPt: naturalWidth * scale, heightPt: naturalHeight * scale, resourceId: resRef };
  };
}
