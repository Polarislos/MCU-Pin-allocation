/*
  AI integration boundary. The model may produce this envelope after parsing
  a user's natural-language request. It must be validated and confirmed before
  being converted into the allocator's request rows.
*/
export const AI_REQUIREMENTS_VERSION = "0.1";

export const AI_ASSISTANT_TOOLS = [
  "search_mcu",
  "get_mcu_capabilities",
  "search_modules",
  "get_module_requirements",
  "validate_requirements",
  "solve_pin_plan",
];

export const AI_REQUEST_TYPES = ["SPI", "I2C", "UART", "FDCAN", "SDMMC", "QUADSPI", "USB", "ETH", "TIM", "ADC", "DAC"];

export function createRequirementsEnvelope({ mcuId, modules = [], constraints = [], notes = [] } = {}) {
  return {
    version: AI_REQUIREMENTS_VERSION,
    mcuId: mcuId || null,
    modules,
    constraints,
    notes,
  };
}

/*
  这是运行时的轻量校验，不依赖额外 JSON Schema 包，适合浏览器离线运行。
  它刻意拒绝模型直接返回 pin / assignment，避免 AI 绕过本地求解器写入最终结果。
*/
export function validateRequirementsEnvelope(input, { mcuId = null } = {}) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["AI 返回值不是 JSON 对象"], value: null };
  }
  if (input.modules != null && !Array.isArray(input.modules)) errors.push("modules 必须是数组");
  if (input.constraints != null && !Array.isArray(input.constraints)) errors.push("constraints 必须是数组");
  if (input.notes != null && !Array.isArray(input.notes)) errors.push("notes 必须是数组");

  const modules = Array.isArray(input.modules) ? input.modules.map((module, moduleIndex) => {
    if (!module || typeof module !== "object") {
      errors.push(`modules[${moduleIndex}] 必须是对象`);
      return null;
    }
    if (module.pin || module.assignments) errors.push(`modules[${moduleIndex}] 不允许包含 pin assignment`);
    const requirements = Array.isArray(module.requirements) ? module.requirements.map((requirement, requirementIndex) => {
      if (!requirement || typeof requirement !== "object") {
        errors.push(`modules[${moduleIndex}].requirements[${requirementIndex}] 必须是对象`);
        return null;
      }
      if (!AI_REQUEST_TYPES.includes(requirement.type)) errors.push(`不支持的接口类型：${requirement.type || "空"}`);
      if (requirement.pin || requirement.pinName || requirement.assignments) errors.push(`接口 ${requirement.type || "未知"} 不允许直接指定物理引脚`);
      const count = requirement.count == null ? 1 : Number(requirement.count);
      if (!Number.isInteger(count) || count < 1 || count > 16) errors.push(`接口 ${requirement.type || "未知"} 的 count 必须是 1–16 的整数`);
      return { ...requirement, count: Number.isInteger(count) && count > 0 ? count : 1 };
    }).filter(Boolean) : [];
    if (!module.requirements || !Array.isArray(module.requirements)) errors.push(`modules[${moduleIndex}].requirements 必须是数组`);
    return {
      id: String(module.id || `module-${moduleIndex + 1}`),
      name: String(module.name || module.id || `模块 ${moduleIndex + 1}`),
      variant: module.variant || null,
      requirements,
    };
  }).filter(Boolean) : [];

  const value = createRequirementsEnvelope({
    mcuId: input.mcuId || mcuId || null,
    modules,
    constraints: Array.isArray(input.constraints) ? input.constraints : [],
    notes: Array.isArray(input.notes) ? input.notes : [],
  });
  return { ok: errors.length === 0, errors, value };
}
