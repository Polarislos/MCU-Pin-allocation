/*
  组合可行性：第 3 层判断。

    1 外设存在       deviceSearch.js 的 type / instance / group 条件
    2 封装信号满足   peripheralUsage.js 的用途条件
    3 引脚分配可行   这里：把条件翻译成求解器请求，在这颗片子的**完整引脚表**上
                     一起求解——SWD 调试口、晶振脚默认保留，还可以叠加当前工程
                     已有的接口需求

  前两层只看索引里的摘要，能对三千多颗一起筛；这一层要整颗器件的引脚数据，
  所以只能逐颗按需做（界面上是每条结果的"检查组合"按钮）。

  ── 翻译规则 ──────────────────────────────────────────────────────
  - 用途条件 → 求解器请求，signals 直接取用途定义（allocator.js 的自定义信号表）。
    "任选其一"的单信号备选（NE1–NE4、RS 用哪根地址线）交给求解器的槽位；多信号
    的备选（SDRAM 的两个 bank、QSPI 的两个 bank）展开成多次求解，任一次有解即可。
  - 外设类型 / 实例 / 分组 → 求解器已有的类型，按该类型的**默认接法**（SPI 全双工
    3 线、SDMMC 4 位、ETH RMII…）。结果里写明用的是哪种接法。
  - 求解器没有对应类型的条件（CRC、DMA2D、"有 FMC" 这种不带用途的存在条件）
    不参与求解，列在 unchecked 里——它们要么不占脚，要么"占几个脚"取决于用途。

  ── 结论的措辞 ────────────────────────────────────────────────────
    feasible     找到了一套无冲突方案（附上方案）
    infeasible   每一次求解都穷举完毕且无解——这是证明，不是猜测
    unknown      没找到方案，但有求解没跑完（节点预算、组合截断、展开次数封顶）
    skipped      "任意一个"模式：没有"一起分配"的问题
*/
import { DEFINITIONS, allocatePins } from "./allocator.js";
import { PERIPHERAL_GROUPS } from "./deviceSearch.js";
import { capabilityById, matchCapability } from "./capabilities.js";
import { usageById, usageCovers, normalizeParams } from "./peripheralUsage.js";

/* 索引里的外设类型 → 求解器类型 + 实例名约束（正则源码）。
   同一个求解器类型下的实例要分开：用户要的是 USART 就不能拿 LPUART 交差。 */
const TYPE_TO_SOLVER = {
  SPI: { type: "SPI", instance: "SPI\\d+" },
  I2C: { type: "I2C", instance: "I2C\\d+" },
  USART: { type: "UART", instance: "USART\\d+" },
  UART: { type: "UART", instance: "UART\\d+" },
  LPUART: { type: "UART", instance: "LPUART\\d+" },
  FDCAN: { type: "FDCAN", instance: "FDCAN\\d+" },
  CAN: { type: "FDCAN", instance: "CAN\\d*" },
  /* TI MSPM0：CANFD0 在引脚数据里写作 CAN0 */
  MCAN: { type: "FDCAN", instance: "CAN\\d+" },
  SDMMC: { type: "SDMMC", instance: "SDMMC\\d+" },
  SDIO: { type: "SDMMC", instance: "SDIO" },
  QUADSPI: { type: "QUADSPI", instance: "QUADSPI" },
  ETH: { type: "ETH", instance: "ETH" },
  TIM: { type: "TIM", instance: "TIM\\d+" },
  GPTIMER: { type: "TIM", instance: "TIM[AG]\\d+" },
  /* datasheet 写 OTG_FS，CubeMX 库写 USB_OTG_FS */
  USB_OTG_FS: { type: "USB", instance: "(?:USB_)?OTG_FS" },
  USB_OTG_HS: { type: "USB", instance: "(?:USB_)?OTG_HS" },
  USB: { type: "USB", instance: "USB" },
  /* 模拟类按通道池走，不按实例名过滤 */
  ADC: { type: "ADC" },
  DAC: { type: "DAC" },
};

const USAGE_TO_SOLVER = {
  sd: { type: "SDMMC", instance: "SDMMC\\d+|SDIO" },
  "fmc-sdram": { type: "FMC", instance: "FMC" },
  "fmc-sram": { type: "FMC", instance: "FMC|FSMC" },
  "fmc-nor": { type: "FMC", instance: "FMC|FSMC" },
  "fmc-nand": { type: "FMC", instance: "FMC|FSMC" },
  "fmc-lcd": { type: "FMC", instance: "FMC|FSMC" },
  qspi: { type: "QUADSPI", instance: "QUADSPI" },
  eth: { type: "ETH", instance: "ETH" },
  dcmi: { type: "DCMI", instance: "DCMI|DCMIPP" },
  ltdc: { type: "LTDC", instance: "LTDC|LCD" },
};

/* 展开次数上限。SDRAM 两个 bank × QSPI 两个 bank 也才 4 次，24 次绰绰有余；
   真触顶时如实降级成 unknown。 */
const MAX_ATTEMPTS = 24;
/* 每次求解的节点预算。一次检查可能要跑好几次，用默认的 18 万会让界面等太久；
   预算用尽时结论是 unknown 而不是 infeasible，不会误判。 */
const NODE_BUDGET = 60000;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function variantLabel(type, variant) {
  return DEFINITIONS[type]?.variants?.[variant]?.label || "";
}

/* 用途 → 信号槽位 + 需要展开的多信号备选 */
function usageSlots(usage, params) {
  const slots = [];
  const branches = [];
  for (const requirement of usage.requires(normalizeParams(usage, params))) {
    if (requirement.every((option) => option.length === 1)) {
      slots.push(requirement.length === 1 ? requirement[0][0] : requirement.map((option) => option[0]));
    } else {
      branches.push(requirement);
    }
  }
  return { slots, branches };
}

/* 所有展开组合（笛卡儿积），超过上限截断并报告 */
function expand(branchLists) {
  let combos = [[]];
  let truncated = false;
  for (const options of branchLists) {
    const next = [];
    for (const combo of combos) {
      for (const option of options) {
        if (next.length >= MAX_ATTEMPTS) {
          truncated = true;
          break;
        }
        next.push([...combo, option]);
      }
    }
    combos = next;
  }
  return { combos, truncated };
}

/*
  条件 → 请求模板。profile 是这颗器件在索引里的外设档案（deviceSearch.profileOf），
  用来知道"分组"条件在这颗片子上具体落在哪些类型上。
  返回 { templates: [{ label, request, branches }], unchecked: [label] }
*/
export function planRequests(conditions, { vendor, profile = [], labelOf = (condition) => condition.value } = {}) {
  const templates = [];
  const unchecked = [];

  const pushTyped = (condition, solver, count, extra = {}) => {
    const definition = DEFINITIONS[solver.type];
    for (let index = 0; index < count; index += 1) {
      templates.push({
        label: labelOf(condition),
        request: {
          type: solver.type,
          variant: definition.defaultVariant,
          ...(solver.instance ? { instancePattern: solver.instance } : {}),
          ...extra,
        },
        branches: [],
        note: variantLabel(solver.type, definition.defaultVariant),
      });
    }
  };

  for (const condition of conditions) {
    const label = labelOf(condition);
    if (condition.kind === "usage") {
      const usage = usageById(condition.value);
      const solver = USAGE_TO_SOLVER[condition.value];
      if (!usage || !solver || !usageCovers(vendor)) {
        unchecked.push(`${label}（用途检查未覆盖此厂商）`);
        continue;
      }
      const { slots, branches } = usageSlots(usage, condition.params);
      for (let index = 0; index < (condition.min || 1); index += 1) {
        templates.push({
          label,
          request: { type: solver.type, instancePattern: solver.instance, signals: slots },
          branches,
          note: "",
        });
      }
      continue;
    }

    if (condition.kind === "instance") {
      const instance = profile.find((item) => item.name === condition.value);
      const solver = instance && TYPE_TO_SOLVER[instance.type];
      if (!solver) {
        unchecked.push(`${label}（求解器没有这类外设）`);
        continue;
      }
      /* 实例名在两种数据源里可能差一个 USB_ 前缀 */
      const name = condition.value.replace(/^USB_(?=OTG_)/, "");
      const pattern = condition.value.startsWith("USB_OTG_") ? `(?:USB_)?${escapeRegExp(name)}` : escapeRegExp(name);
      if (solver.type === "ADC" || solver.type === "DAC") pushTyped(condition, solver, 1, { instance: condition.value });
      else pushTyped(condition, { ...solver, instance: pattern }, 1);
      continue;
    }

    /* 能力：按这家厂商的映射取命中实例；没映射就是未收录，不参与 */
    let capabilityHits = null;
    if (condition.kind === "capability") {
      capabilityHits = matchCapability(capabilityById(condition.value), vendor, profile);
      if (capabilityHits === null) {
        unchecked.push(`${label}（此厂商未收录该能力）`);
        continue;
      }
    }

    /* type / group / capability：这颗片子上命中的类型里，挑求解器认得的 */
    const types = condition.kind === "type"
      ? [condition.value]
      : capabilityHits
        ? [...new Set(capabilityHits.map((item) => item.type))]
        : [...new Set(profile.filter((item) => conditionTypes(condition).has(item.type)).map((item) => item.type))];
    const solvers = types.map((type) => TYPE_TO_SOLVER[type]).filter(Boolean);
    const solverTypes = [...new Set(solvers.map((item) => item.type))];
    if (solverTypes.length !== 1) {
      unchecked.push(`${label}（${solverTypes.length ? "跨多类求解器外设" : "求解器没有这类外设"}）`);
      continue;
    }
    const patterns = solvers.map((item) => item.instance).filter(Boolean);
    pushTyped(condition, {
      type: solverTypes[0],
      instance: patterns.length === solvers.length ? patterns.map((item) => `(?:${item})`).join("|") : null,
    }, condition.min || 1);
  }
  return { templates, unchecked };
}

function conditionTypes(condition) {
  return new Set(PERIPHERAL_GROUPS.find((group) => group.id === condition.value)?.types || []);
}

function summarize(solution, requests, labels) {
  const byId = new Map(requests.map((request, index) => [request.id, labels[index]]));
  return solution.groups.map((group) => ({
    label: byId.get(group.requestId) || group.type,
    instance: group.instance,
    pins: group.assignments.map((item) => ({ signal: item.signal, pin: item.pin.name, number: item.pin.number })),
  }));
}

/*
  在一颗器件上检查。
    mcu         完整引脚数据（ensureMcuLoaded / fetchRuntimeMcu 的结果）
    conditions  搜索条件
    options     { vendor, profile, labelOf, extraRequests, mode, protectDebug, protectOscillator }
*/
export function checkFeasibility(mcu, conditions, options = {}) {
  if (options.mode === "any") {
    return { status: "skipped", reason: "\"任意一个\"模式下各条件不需要同时满足", unchecked: [], requests: [] };
  }
  const { templates, unchecked } = planRequests(conditions, options);
  const extra = (options.extraRequests || [])
    .filter((request) => DEFINITIONS[request?.type])
    .map((request) => ({
      label: `工程：${DEFINITIONS[request.type].label}${variantLabel(request.type, request.variant) ? ` · ${variantLabel(request.type, request.variant)}` : ""}`,
      /* 换了器件，原工程里指定的实例未必存在；方位、耐压这类约束照留 */
      request: { type: request.type, variant: request.variant, side: request.side, fiveVolt: request.fiveVolt },
      branches: [],
      note: "",
    }));
  const all = [...templates, ...extra];
  const described = all.map((item) => ({ label: item.label, note: item.note }));
  if (all.length === 0) {
    return { status: "skipped", reason: "没有能交给求解器的条件", unchecked, requests: described };
  }

  /* 每个模板的每个多信号需求项是一个展开位，所有展开位做笛卡儿积 */
  const branchSlots = [];
  all.forEach((item, templateIndex) => {
    item.branches.forEach((options, branchIndex) => branchSlots.push({ templateIndex, branchIndex, options }));
  });
  const branchCombos = branchSlots.length ? expand(branchSlots.map((slot) => slot.options)) : { combos: [[]], truncated: false };

  let provenAll = true;
  let attempts = 0;
  for (const combo of branchCombos.combos) {
    attempts += 1;
    const requests = all.map((item, index) => {
      const chosen = branchSlots
        .map((slot, slotIndex) => (slot.templateIndex === index ? combo[slotIndex] : null))
        .filter(Boolean)
        .flat();
      const request = { ...item.request, id: `f${index}` };
      if (request.signals) request.signals = [...request.signals, ...chosen];
      return request;
    });
    const result = allocatePins(mcu, requests, {
      maxSolutions: 1,
      nodeBudget: NODE_BUDGET,
      protectDebug: options.protectDebug !== false,
      protectOscillator: options.protectOscillator !== false,
    });
    if (result.solutions.length > 0) {
      return {
        status: "feasible",
        solution: summarize(result.solutions[0], result.requests, all.map((item) => item.label)),
        unchecked,
        requests: described,
        attempts,
      };
    }
    if (!result.proven) provenAll = false;
  }
  return {
    status: provenAll && !branchCombos.truncated ? "infeasible" : "unknown",
    unchecked,
    requests: described,
    attempts,
  };
}
