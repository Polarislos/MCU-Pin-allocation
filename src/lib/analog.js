/*
  模拟通道解析。

  ADC / DAC 的通道不在 `pin.functions`（AF 复用表）里，而在 `additionalFunctions`
  里，且各家命名约定不同，所以单独一层：

  - ST:  `ADC123_INP10` / `ADC12_INP14` / `ADC1_INP16` / `DAC1_OUT1`
         实例前缀的数字是**逐位展开**的——`ADC12` 表示这条通道同时挂在 ADC1 和
         ADC2 上，不是"第 12 个 ADC"。直接用 /^ADC(\d+)_/ 当实例名会造出
         并不存在的 "ADC123"。
  - TI:  `A0_8` = ADC0 的 8 号通道，`DAC_OUT` 只有一路。

  只收单端正输入（ST 的 INP / IN、TI 的全部通道）。INN 是差分负端，必须与 INP
  配对使用、不能独立当一路模拟输入用，所以不作为候选。

  ST 的通道后缀有两代写法，同属 `st` 约定：H7/G4 这类带差分输入的是 `INP0`
  （P = positive），F1/F4 这类只有单端输入的就是 `IN0`，没有那个 P。逐位展开的
  实例前缀两代完全一致（F103 的 `ADC12_IN0` 同样表示挂在 ADC1 和 ADC2 上），
  所以不值得为此新开一个 convention——只把后缀里的 P 放宽成可选即可。
  写成 `INP?` 而不是 `IN[PN]?` 是有意的：INN 仍被排除在候选之外。
*/

/*
  `pattern` 只收可分配的候选；`space` 是这家约定的**全部**模拟功能名，
  包括不作为候选的差分负端。两者要分开：通用 UI profile 靠 space 判断
  `ADC12_INN3` 是模拟命名空间里的东西，而不是一个叫 "ADC12" 的外设家族。
*/
const ANALOG_CONVENTIONS = {
  st: {
    ADC: {
      pattern: /^ADC(\d+)_(INP?\d+)$/,
      space: /^ADC\d+_IN[PN]?\d+$/,
      /* 前缀每一位数字是一个独立实例：ADC123 → ADC1 / ADC2 / ADC3 */
      instances: (digits) => [...digits].map((digit) => `ADC${digit}`),
    },
    DAC: {
      pattern: /^DAC(\d+)_(OUT\d+)$/,
      space: /^DAC\d+_OUT\d+$/,
      instances: (digits) => [`DAC${digits}`],
    },
  },
  ti: {
    ADC: {
      pattern: /^A(\d+)_(\d+)$/,
      space: /^A\d+_\d+$/,
      instances: (digits) => [`ADC${digits}`],
    },
    DAC: {
      pattern: /^(DAC)_(OUT)$/,
      space: /^DAC_OUT$/,
      instances: () => ["DAC"],
    },
  },
};

export const ANALOG_FAMILIES = ["ADC", "DAC"];

export function isAnalogFamily(type) {
  return ANALOG_FAMILIES.includes(type);
}

function conventionFor(mcu, family) {
  const set = ANALOG_CONVENTIONS[mcu?.analogConvention] || ANALOG_CONVENTIONS.st;
  return set[family] || null;
}

/*
  按实例分组的模拟通道候选。

  返回 Map<instance, [{ pin, channel, function }]>，按物理脚号升序——求解器
  自己会再按引脚代价重排，这里只保证遍历顺序稳定，好让结果可复现。
*/
export function analogInputs(mcu, family) {
  const convention = conventionFor(mcu, family);
  const byInstance = new Map();
  if (!convention || !mcu?.pins) return byInstance;

  for (const pin of mcu.pins) {
    for (const name of pin.additionalFunctions || []) {
      const match = name.match(convention.pattern);
      if (!match) continue;
      const [, digits, channel] = match;
      for (const instance of convention.instances(digits)) {
        if (!byInstance.has(instance)) byInstance.set(instance, []);
        byInstance.get(instance).push({ pin, channel, function: name });
      }
    }
  }

  for (const list of byInstance.values()) {
    list.sort((left, right) => left.pin.number - right.pin.number);
  }
  return byInstance;
}

/* 这个功能名是否落在某家的模拟命名空间里（含差分负端）。 */
export function isAnalogFunctionName(mcu, name) {
  return ANALOG_FAMILIES.some((family) => conventionFor(mcu, family)?.space.test(name));
}

export function analogInstances(mcu, family) {
  return [...analogInputs(mcu, family).keys()]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

/*
  实例名反查所属家族。外设目录和引脚检视只拿得到 "ADC1" 这样的字符串，
  靠它判断该走模拟路径还是 AF 路径。
*/
export function analogFamilyOfInstance(mcu, instance) {
  if (!instance) return null;
  for (const family of ANALOG_FAMILIES) {
    if (analogInputs(mcu, family).has(instance)) return family;
  }
  return null;
}

/* 某个实例在这颗片子上的全部通道，按信号名分组——形状与
   peripherals.js 的 peripheralFunctions() 一致，可直接喂给检视面板。 */
export function analogFunctions(mcu, family, instance) {
  const list = analogInputs(mcu, family).get(instance) || [];
  return list
    .map((candidate) => [candidate.channel, [{ name: candidate.function, af: null, pin: candidate.pin }]])
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }));
}
