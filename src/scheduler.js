'use strict';

/**
 * 贪心调度器：在黑夜区间内按「最早窗口截止优先」生成不冲突观测序列。
 *
 * 约束模型：
 * - 每个目标必须完整落在某一段可见窗口内（E 段 = 翻转前，W 段 = 翻转后）；
 *   不允许一次曝光跨子午线翻转点。
 * - 相邻目标之间需要转台耗时 slewMin；
 * - 若相邻两次观测位于子午线不同侧（望远镜叉臂换向），额外需要 flipMin；
 * - 首个目标不计转台耗时（假设从停驻位出发）。
 *
 * 每轮从未排目标的所有可行（窗口段, 开始时刻）组合中，选择窗口截止最早者，
 * 使时间资源优先让给最紧张的目标，从而最大化排入数量。
 */
function schedule(targets, night, slewMin, flipMin) {
  const slewMs = Math.max(0, slewMin) * 60000;
  const flipMs = Math.max(0, flipMin) * 60000;
  const pool = targets.map((tg, index) => ({
    index,
    expMs: tg.expMin * 60000,
    segments: tg.segments,
    done: false,
  }));

  let now = night.start;
  let side = null; // 当前叉臂所在侧：'E' | 'W' | null
  const plan = [];

  for (;;) {
    let best = null;
    for (const tg of pool) {
      if (tg.done) continue;
      for (const seg of tg.segments) {
        if (seg.end - seg.start < tg.expMs) continue;
        const needFlip = side !== null && side !== seg.side;
        const setupMs = side === null ? 0 : slewMs + (needFlip ? flipMs : 0);
        const start = Math.max(now + setupMs, seg.start);
        const end = start + tg.expMs;
        if (end > seg.end) continue;
        if (!best || seg.end < best.segEnd || (seg.end === best.segEnd && start < best.start)) {
          best = { tg, start, end, segEnd: seg.end, side: seg.side, setupMs, needFlip };
        }
      }
    }
    if (!best) break;
    best.tg.done = true;
    plan.push({
      index: best.tg.index,
      start: Math.round(best.start),
      end: Math.round(best.end),
      side: best.side,
      slewMin: side === null ? 0 : slewMin,
      flipBefore: best.needFlip,
      setupMs: best.setupMs,
    });
    now = best.end;
    side = best.side;
  }
  return plan;
}

module.exports = { schedule };
