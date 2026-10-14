import { PERIPHERAL_MODES } from "../data/peripheralGuides/modes.js";

export default function PeripheralModesSection({ id, compact = false }) {
  const guide = PERIPHERAL_MODES[id];

  return <section className={`peripheral-modes${compact ? " is-compact" : ""}`} aria-label="工作方式与模式">
    <h3>工作方式与模式</h3>
    {guide ? <>
      <p className="peripheral-modes-intro">{guide.intro}</p>
      <div className="peripheral-modes-dimensions">
        {guide.dimensions.map((item) => <article className="peripheral-mode-dimension" key={item.title}>
          <header><strong>{item.title}</strong>{item.note && <small>{item.note}</small>}</header>
          <ul>{item.options.map((mode) => <li key={mode.name}>
            <div><strong>{mode.name}</strong>{mode.availability && <span>{mode.availability}</span>}</div>
            <p>{mode.description}</p>
          </li>)}</ul>
        </article>)}
      </div>
      {guide.caveat && <p className="peripheral-modes-caveat">{guide.caveat}</p>}
    </> : <p className="peripheral-modes-empty">此项更适合按支持能力、算法或数据格式理解。当前目录没有足够依据整理出跨型号通用的模式清单；请结合目标 MCU 的参考手册确认具体选项。</p>}
  </section>;
}
