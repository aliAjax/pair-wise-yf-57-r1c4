// 合并账逻辑冒烟测试：两版冲突 / 逐字段合并 / 失效回退 / 幂等入账 / 弱网中断
const babel = require('@babel/core');
const Module = require('module');
const path = require('path');

const origLoad = Module._load;
const cache = new Map();
const fs = require('fs');
const taroStorage = {};
const taroMock = {
  getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(taroStorage, k) ? taroStorage[k] : ''),
  setStorageSync: (k, v) => { taroStorage[k] = v; },
  removeStorageSync: (k) => { delete taroStorage[k]; },
  getLocation: async () => ({ latitude: 30.5, longitude: 103.2 }),
};
function tryResolveTs(request, parent) {
  const base = path.resolve(path.dirname(parent.filename), request);
  for (const cand of [base, base + '.ts', path.join(base, 'index.ts')]) {
    if (cand.endsWith('.ts') && fs.existsSync(cand)) return cand;
  }
  return null;
}
Module._load = function (request, parent, isMain) {
  if (request === '@tarojs/taro') return taroMock;
  if (request.startsWith('.')) {
    const file = tryResolveTs(request, parent);
    if (file) {
      if (cache.has(file)) return cache.get(file);
      const src = fs.readFileSync(file, 'utf8');
      const out = babel.transformSync(src, { presets: [['taro', { framework: 'react', ts: true, modules: 'commonjs' }]], filename: file }).code;
      const m = new Module(file, parent);
      m.paths = Module._nodeModulePaths(path.dirname(file));
      m.filename = file;
      cache.set(file, m.exports);
      m._compile(out, file);
      return m.exports;
    }
  }
  return origLoad.call(this, request, parent, isMain);
};

const { mergeLedger } = require('./src/sync/ledger.ts');
const server = require('./src/sync/server.ts');

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
}

// ---- 场景 1：合并（与 store 种子同构的本地台账） ----
const local = {
  observations: [
    { id: 'o1', deviceId: 'dev-local', rev: 1, sync: 'synced', lastAckedRev: 1,
      acked: { time: 't', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', latitude: 30.5821, longitude: 103.2174, reviewed: false, reviewNote: undefined },
      time: 't', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', latitude: 30.5821, longitude: 103.2174, reviewed: false },
    { id: 'o2', deviceId: 'dev-local', rev: 1, sync: 'queued', time: 't', note: '红外相机外壳松动', risk: 'high', reviewed: false },
    { id: 'o3', deviceId: 'dev-local', rev: 1, sync: 'synced', lastAckedRev: 1,
      acked: { time: 't', note: '样线南段没有异常', risk: 'low', reviewed: true, reviewNote: '样线南段已复核，同意记录' },
      time: 't', note: '样线南段没有异常', risk: 'low', reviewed: true, reviewNote: '样线南段已复核，同意记录' },
  ],
  points: [
    { id: 'p1', deviceId: 'dev-local', rev: 2, sync: 'synced', lastAckedRev: 1,
      acked: { latitude: 30.58, longitude: 103.215, at: '07:20', source: 'gps' },
      latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps' },
    { id: 'p2', deviceId: 'dev-local', rev: 1, sync: 'synced', lastAckedRev: 1,
      acked: { latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' },
      latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' },
  ],
  samples: [
    { id: 's1', deviceId: 'dev-local', rev: 1, sync: 'synced', lastAckedRev: 1,
      acked: { code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'verified', observationId: 'o1' },
      code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'verified', observationId: 'o1' },
  ],
};

(async () => {
  const remote = await server.fetchAll();
  const outcome = mergeLedger(local, remote);

  // 两版冲突：p1 两边都改过
  check('冲突对数量=1（p1 两版）', outcome.pairs.length === 1 && outcome.pairs[0].localId === 'p1');
  const p1Local = outcome.points.find((p) => p.id === 'p1');
  const p1Remote = outcome.points.find((p) => p.id === 'p1__remote');
  check('本地版保留且标记 conflict', p1Local && p1Local.sync === 'conflict' && p1Local.latitude === 30.5821);
  check('站点版保留且标记 conflict', p1Remote && p1Remote.sync === 'conflict' && p1Remote.latitude === 30.584);

  // o1：站点改了地点 → 字段合并采用站点坐标，复核意见保留
  const o1 = outcome.observations.find((o) => o.id === 'o1');
  check('o1 坐标按站点更新', o1.latitude === 30.583 && o1.longitude === 103.2205);
  check('o1 站点复核意见保留', o1.reviewNote === '东坡足迹已核实，注意沿溪沟方向排查');
  check('o1 本地笔记未被覆盖', o1.note === '东坡发现新鲜足迹，沿溪谷方向移动');

  // 采用站点新记录 o4、s2
  check('采用站点新记录 o4/s2', outcome.adopted === 2 && outcome.observations.some((o) => o.id === 'o4') && outcome.samples.some((s) => s.id === 's2'));

  // 失效回退：o1 地点变了 → s1 核验退回待处理
  const s1 = outcome.samples.find((s) => s.id === 's1');
  check('s1 核验因 o1 地点变更退回待处理', s1.status === 'submitted' && s1.sync === 'queued');
  check('invalidated 记录包含 s1', outcome.invalidated.some((i) => i.sampleIds.includes('s1')));
  // s1 被站点改挂到 o4（样本挂到别的观察）
  check('s1 按站点记录改挂 o4', s1.observationId === 'o4');

  // o3 无变化，保持已入账
  check('o3 保持已入账', outcome.observations.find((o) => o.id === 'o3').sync === 'synced');

  // ---- 场景 2：幂等入账（重传只入账一次） ----
  const rec = { id: 'idem-1', deviceId: 'dev-local', rev: 1, sync: 'queued', latitude: 1, longitude: 2, at: 't', source: 'gps' };
  const first = await server.postOne(rec);
  const second = await server.postOne(rec);
  check('首次 POST inserted', first.status === 'inserted');
  check('重传 POST duplicate（只入账一次）', second.status === 'duplicate');

  // ---- 场景 3：弱网中断，抛出后可续作 ----
  server.armWeakNetworkFailure();
  let threw = false;
  try { await server.postOne({ ...rec, id: 'idem-2' }); } catch { threw = true; }
  check('弱网中断抛错', threw);
  // 中断后下一次恢复正常（游标续作由 store 层保证）
  const after = await server.postOne({ ...rec, id: 'idem-3' });
  check('中断后恢复可继续入账', after.status === 'inserted');

  // ---- 场景 4：store 级续作：中断 → 游标落库 → 续作 → 合并失效回退 ----
  global.window = {};
  const { store, runSync, armWeakNetworkFailure: armStore, resolvePair } = require('./src/store/index.ts');
  const snapshot = () => store.getState().patrol;

  // 首次同步：模拟弱网，应在第 1 条 POST（o2）后中断
  armStore();
  await store.dispatch(runSync());
  let s = snapshot();
  const o2AfterFail = s.observations.find((o) => o.id === 'o2');
  check('中断时 o2 未入账（游标未推进）', o2AfterFail.sync === 'queued' && o2AfterFail.lastAckedRev === undefined);
  check('同步状态标记失败可续作', s.syncing !== null && s.syncing.failed === true && s.syncing.posted === 0);
  check('中断后无冲突/合并结果', s.conflicts.length === 0);

  // 恢复网络续作：从断点继续，已入账的 o2 不重传
  await store.dispatch(runSync());
  s = snapshot();
  check('续作后无失败标记', s.syncing === null);
  check('p1 两版冲突已登记', s.conflicts.some((c) => c.localId === 'p1' && c.remoteId === 'p1__remote'));
  check('o1 站点坐标与复核意见已合并', s.observations.find((o) => o.id === 'o1').reviewNote === '东坡足迹已核实，注意沿溪沟方向排查');
  const s1Final = s.samples.find((sm) => sm.id === 's1');
  check('s1 核验退回待处理且已重新入账', s1Final.status === 'submitted' && s1Final.sync === 'synced' && s1Final.rev === 2);
  check('s1 改挂 o4', s1Final.observationId === 'o4');
  check('站点新记录 o4/s2 已采用', s.observations.some((o) => o.id === 'o4') && s.samples.some((sm) => sm.id === 's2'));
  check('同步汇总含去重与合并', s.lastSummary.duplicates >= 1 && s.lastSummary.mergedFields >= 1);
  check('持久化写入台账 key', !!taroStorage['yf57-patrol-ledger-v2']);

  // 冲突裁决：保留本地版 → 站点版移除，冲突对消失，保留版视为已入账
  store.dispatch(resolvePair({ pairId: 'cf-p1', choice: 'local' }));
  s = snapshot();
  const p1Kept = s.points.find((p) => p.id === 'p1');
  check('保留本地版后站点版移除', !s.points.some((p) => p.id === 'p1__remote') && !!p1Kept);
  check('保留版视为已入账', p1Kept.sync === 'synced' && p1Kept.lastAckedRev === p1Kept.rev);
  check('冲突对已清空', s.conflicts.length === 0);

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });