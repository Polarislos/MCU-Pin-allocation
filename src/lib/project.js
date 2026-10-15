/*
  工程文件边界。

  一份工程 = 选了哪颗 MCU + 需求行 + 分配规则 + 排除脚 + 锁定组 + 当前方案快照。
  它要能进 git 跟着原理图一起评审，所以：

  - 引脚只存**物理脚号**。内存里的 assignment.pin 是完整的 pin 记录（含全部
    AF 列表），直接 JSON 化一份 15 脚的方案就是几十 KB 的噪声，且 diff 全是
    与设计无关的数据。载入时按脚号从 mcu.pins 反查还原。
  - 键序固定、数组排序、2 空格缩进。不依赖对象插入顺序，同一份工程无论怎么
    操作出来的，序列化结果都逐字节相同——否则 git diff 会有大量假变更。
  - savedAt 放最后一个键。它每次保存都变，放末尾让噪声只有一行。

  载入必须容错：一份对不上的工程文件应该产出 warnings 并尽量恢复，而不是让
  页面打不开。
*/
import { DEFINITIONS, SIDES } from "./allocator.js";
import { knownMcus } from "./mcuCatalog.js";

export const PROJECT_FORMAT = "mcu-pin-planner.project";
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = "pinplan.json";

function sortedNumbers(values) {
  return [...new Set(values || [])]
    .filter((value) => Number.isInteger(value))
    .sort((left, right) => left - right);
}

/* 分配组降维：pin 记录 → 脚号 + 脚名。脚名是冗余的，但它让文件可读，
   也是载入时发现"数据换了版本、脚号含义变了"的唯一依据。 */
function serializeGroup(group) {
  return {
    type: group.type,
    instance: group.instance,
    variant: group.variant || null,
    assignments: group.assignments.map((item) => ({
      signal: item.signal,
      function: item.function,
      af: item.af ?? null,
      pin: item.pin.number,
      pinName: item.pin.name,
    })),
  };
}

function serializeRequest(request) {
  return {
    id: request.id,
    type: request.type,
    variant: request.variant,
    instance: request.instance || null,
    side: request.side || null,
    fiveVolt: Boolean(request.fiveVolt),
  };
}

export function serializeProject({
  mcuId,
  mcu,
  mcuQuery = null,
  requests = [],
  options = {},
  excludedPins = [],
  lockedGroups = [],
  solution = null,
  activeIndex = 0,
  savedAt = new Date().toISOString(),
}) {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    mcu: {
      id: mcuId,
      partNumber: mcu?.partNumber || null,
      package: mcu?.package || null,
      source: mcu?.source
        ? { document: mcu.source.document, revision: mcu.source.revision }
        : null,
      /* 按需器件（不在固化目录里）重新取回引脚数据要用的索引查询。
         固化器件不写这个键，旧工程文件的内容因此逐字节不变。 */
      ...(mcuQuery ? { query: { vendor: mcuQuery.vendor, part: mcuQuery.part, package: mcuQuery.package || "" } } : {}),
    },
    options: {
      protectDebug: options.protectDebug !== false,
      protectOscillator: options.protectOscillator !== false,
    },
    excludedPins: sortedNumbers([...excludedPins]),
    requests: requests.map(serializeRequest),
    lockedGroups: lockedGroups.map(serializeGroup),
    plan: solution
      ? { activeIndex: Number(activeIndex) || 0, groups: solution.groups.map(serializeGroup) }
      : null,
    savedAt,
  };
}

/* 显式按固定顺序写出，不依赖 JSON.stringify 对插入顺序的沿用。 */
export function projectToJson(project) {
  const ordered = {
    format: project.format,
    version: project.version,
    mcu: project.mcu,
    options: project.options,
    excludedPins: project.excludedPins,
    requests: project.requests,
    lockedGroups: project.lockedGroups,
    plan: project.plan,
    savedAt: project.savedAt,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function parseProject(text) {
  let input;
  try {
    input = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`不是合法的 JSON：${error.message}`], value: null };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["工程文件的顶层必须是对象"], value: null };
  }
  if (input.format !== PROJECT_FORMAT) {
    return { ok: false, errors: [`不是引脚规划器工程文件（format=${input.format ?? "缺失"}）`], value: null };
  }
  if (input.version !== PROJECT_VERSION) {
    return { ok: false, errors: [`工程文件版本 ${input.version} 与当前版本 ${PROJECT_VERSION} 不符`], value: null };
  }
  if (!input.mcu?.id) {
    return { ok: false, errors: ["工程文件没有记录 MCU"], value: null };
  }
  return { ok: true, errors: [], value: input };
}

/* af 为 null = 模拟通道，它在 additionalFunctions 里；否则要在 AF 表里
   找到同名同编号的条目。 */
function pinProvides(pin, item) {
  if (/^GPIO\d+$/.test(item.function || "")) return pin.kind === "gpio";
  if (item.af == null) return (pin.additionalFunctions || []).includes(item.function);
  return pin.functions.some((entry) => entry.name === item.function && entry.af === item.af);
}

function hydrateGroup(group, byNumber, warnings, label) {
  const definition = DEFINITIONS[group?.type];
  if (!definition) {
    warnings.push(`${label}：未知的接口类型 ${group?.type ?? "空"}，已跳过`);
    return null;
  }
  const assignments = [];
  for (const item of group.assignments || []) {
    const pin = byNumber.get(item.pin);
    if (!pin) {
      warnings.push(`${label} ${group.instance}：脚 ${item.pin} 不在当前器件上，整组已丢弃`);
      return null;
    }
    /* 脚号对上但脚名对不上，说明文件来自另一份器件数据。这时的分配是无意义的，
       宁可丢掉也不能装作还成立。 */
    if (item.pinName && item.pinName !== pin.name) {
      warnings.push(`${label} ${group.instance}：脚 ${item.pin} 在当前数据里是 ${pin.name}，文件记的是 ${item.pinName}，整组已丢弃`);
      return null;
    }
    /* 功能名和 AF 编号必须在这个脚上真实存在。这些值会原样进 .ioc 和 HAL 头文件，
       不校验就等于把文件里的任意字符串直接写进用户的工程。 */
    if (!pinProvides(pin, item)) {
      warnings.push(`${label} ${group.instance}：${pin.name} 上没有 ${item.function}${item.af == null ? "" : `(AF${item.af})`}，整组已丢弃`);
      return null;
    }
    assignments.push({ signal: item.signal, function: item.function, af: item.af ?? null, pin });
  }
  if (!assignments.length) {
    warnings.push(`${label} ${group.instance}：没有有效的分配，已跳过`);
    return null;
  }
  return {
    type: group.type,
    instance: group.instance,
    variant: definition.variants[group.variant] ? group.variant : definition.defaultVariant,
    assignments,
    locked: true,
  };
}

/*
  把校验过的工程对象还原成 App 能直接吃的状态。
  catalog 默认用固化目录 + 本次会话已取回的按需器件，测试里可以注入。

  引脚表是懒加载的，所以调用方必须先 await loadMcuById(value.mcu.id, value.mcu.query)。
  没加载就还原会拿到一份没有引脚的 mcu，进而把工程里每个引脚都判成"不存在"
  ——那是一条会骗人的错误路径，宁可在这里直接失败。
*/
export function hydrateProject(value, catalog = knownMcus()) {
  const warnings = [];
  const record = catalog.find((item) => item.id === value.mcu.id);
  if (!record) {
    return { ok: false, errors: [`工程文件指定的 MCU「${value.mcu.id}」不在当前目录里`], value: null };
  }
  const mcu = record.data;
  if (!mcu?.pins) {
    return { ok: false, errors: [`MCU「${value.mcu.id}」的引脚数据尚未加载`], value: null };
  }
  if (value.mcu.partNumber && value.mcu.partNumber !== mcu.partNumber) {
    warnings.push(`工程文件记录的型号是 ${value.mcu.partNumber}，当前目录里同 id 的是 ${mcu.partNumber}`);
  }
  if (value.mcu.source?.revision && value.mcu.source.revision !== mcu.source?.revision) {
    warnings.push(`数据源版本不同：文件 Rev ${value.mcu.source.revision}，当前 Rev ${mcu.source?.revision}`);
  }

  const byNumber = new Map(mcu.pins.map((pin) => [pin.number, pin]));

  const requests = [];
  for (const request of value.requests || []) {
    const definition = DEFINITIONS[request?.type];
    if (!definition) {
      warnings.push(`需求行：未知的接口类型 ${request?.type ?? "空"}，已跳过`);
      continue;
    }
    if (request.variant && !definition.variants[request.variant]) {
      warnings.push(`需求行 ${request.type}：未知的接线变体 ${request.variant}，已改用默认值`);
    }
    requests.push({
      id: String(request.id || `r${requests.length + 1}`),
      type: request.type,
      variant: definition.variants[request.variant] ? request.variant : definition.defaultVariant,
      instance: request.instance || null,
      side: SIDES[request.side] ? request.side : null,
      fiveVolt: Boolean(request.fiveVolt),
    });
  }

  const excludedPins = new Set();
  for (const number of value.excludedPins || []) {
    if (byNumber.has(number)) excludedPins.add(number);
    else warnings.push(`排除引脚：脚 ${number} 不在当前器件上，已忽略`);
  }

  const lockedGroups = (value.lockedGroups || [])
    .map((group) => hydrateGroup(group, byNumber, warnings, "锁定组"))
    .filter(Boolean);

  const planGroups = (value.plan?.groups || [])
    .map((group) => hydrateGroup(group, byNumber, warnings, "方案"))
    .filter(Boolean);

  return {
    ok: true,
    errors: [],
    warnings,
    value: {
      mcuId: record.id,
      requests,
      options: {
        protectDebug: value.options?.protectDebug !== false,
        protectOscillator: value.options?.protectOscillator !== false,
      },
      excludedPins,
      lockedGroups,
      /* 方案快照只用于对比基线和刷新后接着看，不当成"求解结果"——它没有
         visited / poolSize 这些搜索元信息，也不该冒充。 */
      plan: planGroups.length ? { activeIndex: value.plan.activeIndex || 0, groups: planGroups } : null,
    },
  };
}

/* 一步到位：文本 → 可用状态。UI 只需处理 {ok, errors, warnings, value}。 */
export function loadProject(text, catalog = knownMcus()) {
  const parsed = parseProject(text);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [], value: null };
  return hydrateProject(parsed.value, catalog);
}

export function projectFileName(mcu) {
  return `${mcu?.partNumber || "mcu"}-pin-plan.${PROJECT_EXTENSION}`;
}
