/*
  够用就好的 XML 解析器。

  为什么不装 fast-xml-parser 之类：这个工程的 dependencies 只有 vite/react，
  devDependencies 是空的，而要解析的两份文件是 CubeMX 生成的、格式极其规整的
  子集——没有 CDATA、没有混合内容、没有处理指令（除了开头的 <?xml?>）、
  没有命名空间前缀参与语义。为这点需求引入一个传递依赖不划算。

  支持：元素、属性、自闭合标签、注释、五个预定义实体。
  不支持：CDATA、DTD、数字字符引用——这两份文件里都不出现，遇到会原样留着。
*/

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);
}

function parseAttributes(source) {
  const attrs = {};
  const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(source);
  while (match) {
    attrs[match[1]] = decode(match[2]);
    match = pattern.exec(source);
  }
  return attrs;
}

/*
  返回根元素：{ name, attrs, children }。文本节点直接丢弃——这两份文件里
  只有 <Core>Arm Cortex-M3</Core> 这类纯文本元素需要取值，所以文本单独收进
  节点的 `text` 字段，不作为子节点参与遍历。
*/
export function parseXml(source) {
  const stack = [{ name: "#root", attrs: {}, children: [], text: "" }];
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:[^>"]|"[^"]*")*?)(\/?)>/g;

  let lastIndex = 0;
  let match = pattern.exec(source);
  while (match) {
    /* 标签之间的文本归属于当前打开的元素 */
    const between = source.slice(lastIndex, match.index).trim();
    if (between) stack[stack.length - 1].text += decode(between);
    lastIndex = pattern.lastIndex;

    const [raw, closeName, openName, attrSource, selfClosing] = match;
    if (!raw.startsWith("<!--") && !raw.startsWith("<?")) {
      if (closeName) {
        if (stack.length > 1) stack.pop();
      } else {
        const node = { name: openName, attrs: parseAttributes(attrSource || ""), children: [], text: "" };
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
      }
    }
    match = pattern.exec(source);
  }

  const root = stack[0].children[0];
  if (!root) throw new Error("XML 里没有根元素");
  return root;
}

/* 直接子元素，按标签名过滤。 */
export function childrenNamed(node, name) {
  return node.children.filter((child) => child.name === name);
}

export function firstNamed(node, name) {
  return node.children.find((child) => child.name === name) || null;
}

/* 深度优先找出所有同名后代。 */
export function descendantsNamed(node, name) {
  const found = [];
  const walk = (current) => {
    for (const child of current.children) {
      if (child.name === name) found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}
