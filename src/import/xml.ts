// 极简 XML 解析器（零依赖），只覆盖 OFD 需要的读取子集。
// 查找一律按本地名匹配（忽略前缀）：ofd:TextCode 与 TextCode 等价。

export interface XmlNode {
  /** 原始名（保留前缀），例如 ofd:TextCode */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** 直接文本片段（不含子元素） */
  text: string;
}

export class XmlError extends Error {
  code = 'E_XML_PARSE';

  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

function localName(name: string): string {
  const index = name.indexOf(':');
  return index >= 0 ? name.slice(index + 1) : name;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"|([A-Za-z_][\w.:-]*)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const name = (match[1] ?? match[3]) as string;
    const value = match[2] ?? match[4] ?? '';
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  let cursor = 0;

  while (cursor < source.length) {
    const lt = source.indexOf('<', cursor);
    if (lt < 0) {
      stack[stack.length - 1]!.text += decodeEntities(source.slice(cursor));
      break;
    }
    if (lt > cursor) stack[stack.length - 1]!.text += decodeEntities(source.slice(cursor, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('注释未闭合');
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('CDATA 未闭合');
      stack[stack.length - 1]!.text += source.slice(lt + 9, end);
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<?', lt) || source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      if (end < 0) throw new XmlError('声明未闭合');
      cursor = end + 1;
      continue;
    }
    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt);
      if (end < 0) throw new XmlError('结束标签未闭合');
      const name = source.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top === root) throw new XmlError(`结束标签不匹配：</${name}>`);
      if (top.name !== name) throw new XmlError(`结束标签不匹配：期望 </${top.name}>，实际 </${name}>`);
      cursor = end + 1;
      continue;
    }
    const end = findTagEnd(source, lt);
    if (end < 0) throw new XmlError('开始标签未闭合');
    const inner = source.slice(lt + 1, end);
    const selfClosing = inner.trimEnd().endsWith('/');
    const body = selfClosing ? inner.trimEnd().slice(0, -1) : inner;
    const nameMatch = /^([A-Za-z_][\w.:-]*)/.exec(body.trim());
    if (!nameMatch) throw new XmlError(`非法标签：${body.slice(0, 40)}`);
    const name = nameMatch[1] as string;
    const node: XmlNode = { name, attrs: parseAttrs(body.slice(name.length)), children: [], text: '' };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
    cursor = end + 1;
  }

  if (stack.length !== 1) throw new XmlError(`标签未闭合：${stack[stack.length - 1]?.name}`);
  return root;
}

// 跳过属性值里的 '>'；不处理 DTD 内部子集（OFD 不会出现）
function findTagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let index = from + 1; index < source.length; index += 1) {
    const char = source[index] as string;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '>') return index;
  }
  return -1;
}

export function childrenOf(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => localName(child.name) === name);
}

export function childOf(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => localName(child.name) === name);
}

export function findAll(node: XmlNode, name: string, acc: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (localName(child.name) === name) acc.push(child);
    findAll(child, name, acc);
  }
  return acc;
}

export function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  return findAll(node, name)[0];
}

export function attrOf(node: XmlNode | undefined, name: string): string | undefined {
  if (!node) return undefined;
  if (node.attrs[name] !== undefined) return node.attrs[name];
  // 属性可能带前缀（如 xlink:href），按本地名兜底
  const key = Object.keys(node.attrs).find((item) => localName(item) === name);
  return key ? node.attrs[key] : undefined;
}

export function textOf(node: XmlNode | undefined): string {
  if (!node) return '';
  let out = node.text;
  for (const child of node.children) out += textOf(child);
  return out;
}

export function localNameOf(name: string): string {
  return localName(name);
}
