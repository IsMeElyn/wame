'use strict';
const os = require('os');

let base = { cpu: process.cpuUsage(), t: process.hrtime.bigint(), pct: 0 };

function compute(update) {
  const cu = process.cpuUsage();
  const now = process.hrtime.bigint();
  const elapsedUs = Number(now - base.t) / 1000;
  let pct = base.pct;
  if (elapsedUs > 1e6) pct = (((cu.user - base.cpu.user) + (cu.system - base.cpu.system)) / elapsedUs) * 100;
  if (update) base = { cpu: cu, t: now, pct };
  return pct;
}

function build(pct) {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    uptimeMs: Math.round(process.uptime() * 1000),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    cpuPercent: Number(pct.toFixed(1)),
    loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
    cpus: os.cpus().length,
    freeMem: os.freemem(),
    totalMem: os.totalmem(),
  };
}

/** Snapshot yang memperbarui baseline CPU (dipakai timer periodik). */
const tick = () => build(compute(true));
/** Snapshot tanpa mengubah baseline (aman dipanggil dari command). */
const peek = () => build(compute(false));

module.exports = { tick, peek };
