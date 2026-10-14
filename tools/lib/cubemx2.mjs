import { readFile } from "node:fs/promises";

export async function mergeCubeMx2(index) {
  const fragment = JSON.parse(await readFile(new URL("../data/cubemx2/index.json", import.meta.url), "utf8"));
  const sets = index.peripherals.signalSets;
  const profiles = index.peripherals.profiles;
  const setMap = fragment.signalSets.map((set) => {
    let id = sets.indexOf(set);
    if (id < 0) { id = sets.length; sets.push(set); }
    return id;
  });
  const profileMap = fragment.profiles.map((profile) => {
    const remapped = profile.split(" ").filter(Boolean).map((token) => {
      const [name, set] = token.split(":");
      return `${name}:${setMap[Number(set)]}`;
    }).join(" ");
    let id = profiles.indexOf(remapped);
    if (id < 0) { id = profiles.length; profiles.push(remapped); }
    return id;
  });
  index.devices = index.devices.filter((device) => device.family !== "STM32C5");
  index.devices.push(...fragment.devices.map((device) => ({ ...device, pf: profileMap[device.pf] })));
  index.devices.sort((a, b) => a.id.localeCompare(b.id));
  index.sources = index.sources.filter((source) => source.tool !== "STM32CubeMX2");
  index.sources.push(fragment.source);
  const types = new Set(index.peripherals.types);
  for (const profile of fragment.profiles) for (const token of profile.split(" ").filter(Boolean)) {
    types.add(token.split(":")[0].replace(/\d+$/, ""));
  }
  index.peripherals.types = [...types].sort();
  const coverage = index.specifications.coverage.st;
  const devices = index.devices.filter((device) => device.vendor === "st");
  coverage.total = devices.length;
  for (const key of ["flashKB", "ramKB", "frequencyMHz"]) coverage[key] = devices.filter((device) => Number.isFinite(device.specs?.[key])).length;
  index.generatedAt = new Date().toISOString().slice(0, 10);
  index.peripherals.generatedAt = new Date().toISOString();
  return index;
}

export async function loadCubeMx2(id) {
  if (!/^st-stm32c5[a-z0-9]+-[a-z0-9]+$/.test(id)) throw new Error("无效的 STM32C5 器件 ID");
  return JSON.parse(await readFile(new URL(`../data/cubemx2/mcus/${id}.json`, import.meta.url), "utf8"));
}
