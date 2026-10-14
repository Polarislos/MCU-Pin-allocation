import { useState } from "react";

export default function McuCompareBar({ devices = [], ids, onChange, comparing, onCompare, onReturn }) {
  const [editing, setEditing] = useState(null);
  const [query, setQuery] = useState("");
  const normalized = query.trim().toUpperCase();
  const matches = normalized ? devices.filter((device) =>
    `${device.part} ${device.package || ""}`.toUpperCase().includes(normalized)) : [];
  const choose = (device) => {
    const next = [...ids];
    next[editing] = device.id;
    onChange(next.filter(Boolean));
    setEditing(null);
    setQuery("");
  };
  return <section className="mcu-dual-compare" aria-label="双 MCU 对比">
    <div className="mcu-dual-slots">
      {[0, 1].map((slot) => {
        const device = devices.find((item) => item.id === ids[slot]);
        return <div className="mcu-dual-slot" key={slot}>
          <strong>MCU {slot === 0 ? "A" : "B"}</strong>
          <span>{device ? `${device.part} · ${device.package || "封装未收录"}` : "请选择型号和封装"}</span>
          <button type="button" className="secondary-button" onClick={() => { setEditing(slot); setQuery(""); }}>{device ? "替换" : "选择"}</button>
          {device && <button type="button" className="linklike" aria-label={`移除 MCU ${slot === 0 ? "A" : "B"}`} onClick={() => onChange(ids.filter((id) => id !== device.id))}>移除</button>}
        </div>;
      })}
    </div>
    <div className="mcu-dual-actions">
      <button type="button" className="secondary-button" disabled={ids.length !== 2} onClick={() => onChange([...ids].reverse())}>交换 A/B</button>
      <button type="button" className="primary-button" disabled={ids.length !== 2} onClick={comparing ? onReturn : onCompare}>{comparing ? "返回选型" : ids.length === 1 ? "继续选择第二个 MCU" : "开始对比"}</button>
    </div>
    {editing !== null && <div className="mcu-compare-picker">
      <label>选择 MCU {editing === 0 ? "A" : "B"}<input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入型号，也可加封装，例如 STM32H743 LQFP100" /></label>
      <button type="button" className="secondary-button" onClick={() => setEditing(null)}>取消</button>
      <ul>{matches.slice(0, 30).map((device) => <li key={device.id}><button type="button" disabled={ids.some((id, slot) => slot !== editing && id === device.id)} onClick={() => choose(device)}>{device.part} · {device.package || "封装未收录"} · {device.pinCount || "?"} 脚</button></li>)}</ul>
      <small>{!normalized ? "输入型号后选择具体封装。" : matches.length === 0 ? "没有匹配的型号。" : matches.length > 30 ? `共 ${matches.length} 项，显示前 30 项，请补充型号或封装缩小范围。` : `${matches.length} 个封装组合`}</small>
      <small>型号中的 x 是厂商数据库的等级占位符，不是完整订货型号。</small>
    </div>}
  </section>;
}
