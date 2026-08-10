/*
  方案对比。

  两种场景共用同一套引擎：
  - 方案 A ↔ 方案 B：同一次求解产出的多套方案之间挑
  - 当前 ↔ 基线文件：这一版相比上一版改了什么（硬件评审要回答的问题）

  配对规则是 `${type}:${instance}`，组内再按 signal 配对。实例本身变了
  （SPI1 → SPI2）会表现为一组 removed + 一组 added，而不是被抹平成"SPI 换了脚"
  ——换外设实例是真实的设计变更，评审时必须看见。
*/

function groupKey(group) {
  return `${group.type}:${group.instance}`;
}

function indexGroups(plan) {
  const map = new Map();
  for (const group of plan?.groups || []) map.set(groupKey(group), group);
  return map;
}

function assignmentInfo(item) {
  return item ? { pin: item.pin.number, pinName: item.pin.name, af: item.af ?? null, function: item.function } : null;
}

function samePin(left, right) {
  return Boolean(left) && Boolean(right) && left.pin.number === right.pin.number;
}

function diffGroupSignals(from, to) {
  const fromBySignal = new Map((from?.assignments || []).map((item) => [item.signal, item]));
  const toBySignal = new Map((to?.assignments || []).map((item) => [item.signal, item]));
  /* 信号顺序以新的一侧为准，只在旧侧出现的补在后面——读的人关心的是
     "现在这一组长什么样"，被删掉的信号排在末尾。 */
  const signals = [...toBySignal.keys(), ...[...fromBySignal.keys()].filter((signal) => !toBySignal.has(signal))];

  return signals.map((signal) => {
    const left = fromBySignal.get(signal);
    const right = toBySignal.get(signal);
    let status = "same";
    if (!left) status = "added";
    else if (!right) status = "removed";
    else if (!samePin(left, right)) status = "moved";
    return { signal, status, from: assignmentInfo(left), to: assignmentInfo(right) };
  });
}

function pinsOf(plan) {
  const map = new Map();
  for (const group of plan?.groups || []) {
    for (const item of group.assignments) {
      map.set(item.pin.number, { pin: item.pin.number, pinName: item.pin.name, signal: item.signal, group: groupKey(group) });
    }
  }
  return map;
}

/*
  left = 旧的一侧（基线 / 方案 A），right = 新的一侧（当前 / 方案 B）。
  两侧都接受 { groups: [...] } 形状——求解结果里的 solution 和工程文件还原出来的
  plan 都是这个形状，所以不需要各写一套。
*/
export function diffPlans(left, right) {
  const fromGroups = indexGroups(left);
  const toGroups = indexGroups(right);
  const keys = [...toGroups.keys(), ...[...fromGroups.keys()].filter((key) => !toGroups.has(key))];

  const groups = keys.map((key) => {
    const from = fromGroups.get(key);
    const to = toGroups.get(key);
    const signals = diffGroupSignals(from, to);
    let status = "same";
    if (!from) status = "added";
    else if (!to) status = "removed";
    else if (signals.some((item) => item.status !== "same")) status = "changed";
    const source = to || from;
    return { key, type: source.type, instance: source.instance, status, signals };
  });

  const fromPins = pinsOf(left);
  const toPins = pinsOf(right);
  const taken = [...toPins.values()].filter((item) => !fromPins.has(item.pin));
  const freed = [...fromPins.values()].filter((item) => !toPins.has(item.pin));
  const moved = groups.flatMap((group) => group.signals
    .filter((signal) => signal.status === "moved")
    .map((signal) => ({ group: group.key, signal: signal.signal, from: signal.from, to: signal.to })));

  return {
    groups,
    pins: {
      taken: taken.sort((a, b) => a.pin - b.pin),
      freed: freed.sort((a, b) => a.pin - b.pin),
      moved,
    },
    summary: {
      groupsAdded: groups.filter((group) => group.status === "added").length,
      groupsRemoved: groups.filter((group) => group.status === "removed").length,
      groupsChanged: groups.filter((group) => group.status === "changed").length,
      signalsMoved: moved.length,
      pinsTaken: taken.length,
      pinsFreed: freed.length,
    },
  };
}

export function isEmptyDiff(diff) {
  const { summary } = diff;
  return summary.groupsAdded === 0 && summary.groupsRemoved === 0
    && summary.groupsChanged === 0 && summary.pinsTaken === 0 && summary.pinsFreed === 0;
}

/*
  需求行层面的对比。按 id 配对——id 在一次会话里是稳定的，改变体 / 改实例
  仍是同一行。id 对不上（比如两份文件各自新建的行）就退回按"类型 + 出现次序"配对。
*/
function requestSignature(request) {
  return [request.type, request.variant, request.instance || "", request.side || "", request.fiveVolt ? "5v" : ""].join("|");
}

export function diffRequests(left = [], right = []) {
  const leftById = new Map(left.map((request) => [request.id, request]));
  const rightById = new Map(right.map((request) => [request.id, request]));
  const sharedIds = right.filter((request) => leftById.has(request.id)).length;

  if (sharedIds === 0 && left.length && right.length) {
    /* 两份需求各建各的 id，退回按类型分桶后逐个配对。 */
    const buckets = new Map();
    for (const request of left) {
      if (!buckets.has(request.type)) buckets.set(request.type, []);
      buckets.get(request.type).push(request);
    }
    const rows = [];
    for (const request of right) {
      const bucket = buckets.get(request.type);
      const match = bucket?.shift();
      if (!match) rows.push({ status: "added", from: null, to: request });
      else if (requestSignature(match) !== requestSignature(request)) rows.push({ status: "changed", from: match, to: request });
      else rows.push({ status: "same", from: match, to: request });
    }
    for (const leftovers of buckets.values()) {
      for (const request of leftovers) rows.push({ status: "removed", from: request, to: null });
    }
    return rows;
  }

  const rows = right.map((request) => {
    const match = leftById.get(request.id);
    if (!match) return { status: "added", from: null, to: request };
    if (requestSignature(match) !== requestSignature(request)) return { status: "changed", from: match, to: request };
    return { status: "same", from: match, to: request };
  });
  for (const request of left) {
    if (!rightById.has(request.id)) rows.push({ status: "removed", from: request, to: null });
  }
  return rows;
}
