import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { TOUR_STEPS } from "../lib/tour.js";

/*
  分步引导。

  ── 聚光灯怎么实现 ──────────────────────────────────────────────────
  一个定位到目标矩形的空 div，加 `box-shadow: 0 0 0 9999px rgba(0,0,0,.55)`。
  阴影往外铺满整个视口，中间那块自然就是"洞"。比四块遮罩拼接稳：不会因为
  取整误差在边缘露出一条缝，也不用管目标跨越滚动容器的情况。

  ── 目标找不到怎么办 ────────────────────────────────────────────────
  改了 UI 却忘了改 tour.js 时，target 会选不中。这时**跳过该步**而不是指着
  空白讲解——教程失效是小事，把人引到不存在的地方是误导。tests/verify.mjs
  会在渲染结果里校验每个 target 都存在，所以这只是运行时兜底。
*/

const MARGIN = 12;
const CARD_W = 320;

function useTargetRect(selector, stepIndex) {
  const [rect, setRect] = useState(null);

  const measure = useCallback(() => {
    const node = selector ? document.querySelector(selector) : null;
    if (!node) return setRect(null);
    const box = node.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return setRect(null);
    return setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
  }, [selector]);

  useLayoutEffect(() => {
    measure();
    /* 面板内部可滚动，窗口 resize 也会改变布局。捕获阶段监听 scroll 才能收到
       内层容器的滚动事件（scroll 不冒泡）。 */
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure, stepIndex]);

  return rect;
}

/* 卡片位置：先按步骤声明的方位放，放不下就翻到对侧，最后再夹回视口内。 */
function cardPosition(rect, placement) {
  if (!rect) return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let side = placement;
  if (side === "auto" || !side) side = rect.left > vw / 2 ? "left" : "right";
  if (side === "right" && rect.left + rect.width + MARGIN + CARD_W > vw) side = "left";
  if (side === "left" && rect.left - MARGIN - CARD_W < 0) side = "right";
  if (side === "bottom" && rect.top + rect.height + MARGIN + 180 > vh) side = "top";
  if (side === "top" && rect.top - MARGIN - 180 < 0) side = "bottom";

  let top;
  let left;
  if (side === "right") { top = rect.top; left = rect.left + rect.width + MARGIN; }
  else if (side === "left") { top = rect.top; left = rect.left - CARD_W - MARGIN; }
  else if (side === "top") { top = rect.top - MARGIN - 170; left = rect.left; }
  else { top = rect.top + rect.height + MARGIN; left = rect.left; }

  return {
    top: `${Math.max(MARGIN, Math.min(top, vh - 190))}px`,
    left: `${Math.max(MARGIN, Math.min(left, vw - CARD_W - MARGIN))}px`,
  };
}

export default function Tour({ open, onClose }) {
  const [index, setIndex] = useState(0);
  const step = TOUR_STEPS[index];
  const rect = useTargetRect(open ? step?.target : null, index);

  /* 每次打开都从头开始——中途关掉说明没看完，下次从第三步接着放更让人困惑。 */
  useEffect(() => { if (open) setIndex(0); }, [open]);

  const close = useCallback(() => onClose?.(), [onClose]);
  const next = useCallback(() => {
    setIndex((current) => (current >= TOUR_STEPS.length - 1 ? current : current + 1));
  }, []);
  const prev = useCallback(() => setIndex((current) => Math.max(0, current - 1)), []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowRight") next();
      else if (event.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, next, prev]);

  if (!open || !step) return null;

  const last = index === TOUR_STEPS.length - 1;
  const position = cardPosition(rect, step.placement);

  return (
    <div className="tour-layer" role="dialog" aria-modal="true" aria-label={`新手教程：${step.title}`}>
      {rect ? (
        <div
          className="tour-spotlight"
          style={{
            top: `${rect.top - 4}px`,
            left: `${rect.left - 4}px`,
            width: `${rect.width + 8}px`,
            height: `${rect.height + 8}px`,
          }}
        />
      ) : (
        /* 目标不在页面上（比如这一步讲的面板当前没渲染）：整屏压暗，
           卡片居中，内容照常讲——总比指着错位置好。 */
        <div className="tour-scrim" />
      )}

      <div className="tour-card" style={position}>
        <span className="tour-progress">{index + 1} / {TOUR_STEPS.length}</span>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-actions">
          <button type="button" className="tour-skip" onClick={close}>跳过</button>
          <div className="tour-nav">
            {index > 0 && <button type="button" onClick={prev}>上一步</button>}
            <button type="button" className="tour-primary" onClick={last ? close : next}>
              {last ? "开始使用" : "下一步"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
