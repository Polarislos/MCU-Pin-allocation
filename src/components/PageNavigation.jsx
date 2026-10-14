const pages = [["planner", "引脚规划"], ["mcus", "MCU 选型"], ["peripherals", "外设总览"]];

export default function PageNavigation({ activePage, onNavigate }) {
  return <nav className="app-primary-nav" aria-label="主页面">
    {pages.map(([page, label]) => <button key={page} type="button"
      className={activePage === page ? "is-active" : ""}
      aria-current={activePage === page ? "page" : undefined}
      onClick={() => onNavigate(page)}>{label}</button>)}
  </nav>;
}
