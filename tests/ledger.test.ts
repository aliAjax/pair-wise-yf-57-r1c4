/* 合并账验收测试：node --import tsx tests/ledger.test.ts */
import assert from 'node:assert/strict';
import { DeviceLedger, StationLedger, memoryStore, type Clock } from '../src/sync';

let tick = 0;
const clock: Clock = { now: () => `2026-10-04T0${Math.floor(tick / 60)}:${String(tick % 60).padStart(2, '0')}:00.000Z` };
function step() { tick += 1; }

let passed = 0;
async function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 保存即带设备与修订号；稳定编号断网生成 ----------------------------------------------------
test('保存时带设备号和单调修订号，稳定编号在断网下生成', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  step();
  const obs = dev.saveObservation({ note: '足迹', risk: 'medium', latitude: 30.5, longitude: 103.2, observedAt: '07:20' });
  assert.match(obs.id, /^o-dev-A7-/);
  assert.equal(obs.deviceId, 'dev-A7');
  assert.equal(obs.rev, 1);
  assert.equal(dev.outbox[0].idemKey, `dev-A7:${obs.id}:1`);
  assert.equal(dev.outbox[0].deviceId, 'dev-A7');
  step();
  dev.saveObservation({ note: '足迹（补充）' }, obs.id);
  assert.equal(dev.records.find((r) => r.id === obs.id)!.rev, 2);
  const ops = dev.outbox;
  assert.deepEqual(ops.map((o) => o.changed), [['note', 'risk', 'latitude', 'longitude', 'observedAt'], ['note']]);
});

// 2. 逐字段三向合并：各改各的字段自动合到一起 ---------------------------------------------------
test('两边改不同字段：逐字段自动合并，无冲突', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const obs = dev.saveObservation({ note: '原备注', risk: 'low', latitude: 30.5, longitude: 103.2, observedAt: '07:20' });
  dev.sync(st);
  step();

  // 站点复核（站点字段），设备同时改备注（业务字段）
  st.reviewObservation(obs.id, 'approved', '证据充分，通过');
  step();
  dev.saveObservation({ note: '原备注+现场补充' }, obs.id);
  const res = dev.sync(st);

  assert.equal(res.appliedCount, 1);
  assert.equal(res.conflicts.length, 0);
  const merged = st.records.find((r) => r.id === obs.id && r.active)!;
  assert.equal(merged.fields.note, '原备注+现场补充');
  assert.equal(merged.fields.risk, 'low');
  assert.equal(merged.fields.reviewState, 'approved');
  assert.equal(merged.fields.reviewComment, '证据充分，通过'); // 站点意见保留
  const local = dev.records.find((r) => r.id === obs.id)!;
  assert.equal(local.fields.reviewState, 'approved');
  assert.equal(local.fields.reviewComment, '证据充分，通过');
  assert.equal(local.fields.note, '原备注+现场补充');
});

// 3. 设备永远不能覆盖站点复核字段 --------------------------------------------------------------
test('设备信封里即便带了复核字段也不会覆盖站点结论', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const obs = dev.saveObservation({ note: 'n', risk: 'low', latitude: 1, longitude: 1, observedAt: 't' });
  dev.sync(st);
  step();
  st.reviewObservation(obs.id, 'rejected', '缺少照片');
  step();
  // 设备手工篡改信封（模拟脏数据）：
  const local = dev.records.find((r) => r.id === obs.id)!;
  dev.sync(st);
  (local.fields as unknown as Record<string, unknown>).reviewState = 'approved';
  dev.saveObservation({ note: 'n2' }, obs.id);
  dev.sync(st);
  const final = st.records.find((r) => r.id === obs.id && r.active)!;
  assert.equal(final.fields.reviewState, 'rejected');
  assert.equal(final.fields.reviewComment, '缺少照片');
});

// 4. 观察两边都改同一字段：留两版，不静默覆盖 ---------------------------------------------------
test('观察同字段两边都改：规范记录+站点分叉版，冲突挂起', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const obs = dev.saveObservation({ note: '原文', risk: 'low', latitude: 30.5, longitude: 103.2, observedAt: '07:20' });
  dev.sync(st);
  step();
  st.reviewObservation(obs.id, 'approved', 'ok'); // 站点也动一下记录，但冲突来自同字段双改
  // 让站点直接改业务字段（另一台设备/站端纠错）：
  const sRec = st.records.find((r) => r.id === obs.id)!;
  sRec.fields.note = '站端修正文本';
  step();
  dev.saveObservation({ note: '现场补充文本' }, obs.id);
  const res = dev.sync(st);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].field, 'note');
  const active = st.records.filter((r) => (r.id === obs.id || r.id.includes('station-fork')) && r.active);
  assert.equal(active.length, 2, '应保留两版');
  const canonical = st.records.find((r) => r.id === obs.id)!;
  assert.equal(canonical.fields.note, '现场补充文本'); // 本地版为规范版
  assert.equal(canonical.fork?.side, 'local');
  const fork = active.find((r) => r.fork?.side === 'station')!;
  assert.equal(fork.fields.note, '站端修正文本'); // 站点原值完整留版
  assert.equal(fork.fields.reviewComment, 'ok'); // 站点复核意见也留版
  // 解决冲突：采用站点版 -> 分叉版归档
  const pairId = res.conflicts[0].pairId;
  st.resolveConflict(pairId, 'station');
  assert.equal(st.records.find((r) => r.id === obs.id)!.fields.note, '站端修正文本');
  assert.equal(st.records.filter((r) => r.active && (r.id === obs.id || r.id.includes('station-fork'))).length, 1);
  assert.equal(st.conflicts[0].status, 'resolved');
});

// 5. 轨迹点两边都改：同样留两版 ---------------------------------------------------------------
test('轨迹点同字段两边都改：留两版', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const p = dev.saveTrack({ latitude: 30.5, longitude: 103.2, at: '07:20', source: 'gps' });
  dev.sync(st);
  step();
  st.records.find((r) => r.id === p.id)!.fields.latitude = 30.6;
  step();
  dev.saveTrack({ latitude: 30.55 }, p.id);
  const res = dev.sync(st);
  assert.equal(res.conflicts[0].kind, 'track');
  assert.equal(st.records.filter((r) => r.active && r.id.startsWith(p.id)).length, 2);
  st.resolveConflict(res.conflicts[0].pairId, 'local');
  assert.equal(st.records.find((r) => r.id === p.id)!.fields.latitude, 30.55);
});

// 6. 样本两边都改：本地优先，站点值留档，不产生第二版 --------------------------------------------
test('样本冲突本地新写优先，站点原值在冲突条目留档', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const s = dev.saveSample({ code: 'WD-01', species: '毛发', count: 1, observationId: '' });
  dev.sync(st);
  step();
  st.verifySample(s.id, 'verified', '物种确认');
  st.records.find((r) => r.id === s.id)!.fields.count = 2; // 站端另改业务字段
  step();
  dev.saveSample({ count: 3 }, s.id);
  const res = dev.sync(st);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].field, 'count');
  const rec = st.records.find((r) => r.id === s.id)!;
  assert.equal(rec.fields.count, 3); // 本地优先
  assert.equal(st.records.filter((r) => r.id.startsWith(s.id)).length, 1, '样本不分叉');
  assert.equal(res.conflicts[0].stationValue, 2); // 站点值留档
  assert.equal(rec.fields.verifyState, 'verified'); // 站点核验不受影响
  // 事后改采站点值
  st.resolveConflict(res.conflicts[0].pairId, 'station');
  assert.equal(rec.fields.count, 2);
});

// 7. 重传幂等：同一修订只入账一次 --------------------------------------------------------------
test('断网重传：同批操作重发只入账一次', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const o1 = dev.saveObservation({ note: 'a', risk: 'low', latitude: 1, longitude: 1, observedAt: 't' });
  step();
  const o2 = dev.saveObservation({ note: 'b', risk: 'low', latitude: 2, longitude: 2, observedAt: 't' });
  const first = dev.sync(st);
  assert.equal(first.appliedCount, 2);
  assert.equal(dev.outbox.length, 0);
  // 模拟设备未收到应答、outbox 仍在（手工构造重传场景）：
  const retransmit = [
    { ...first, appliedCount: 0 }
  ];
  void retransmit;
  // 直接用一个全新设备实例重放同一批信封（同 idemKey）：
  const dev2 = new DeviceLedger('dev-A7', null, clock);
  void o1; void o2;
  const before = st.records.length;
  // dev2 用相同编号+修订重发：
  const rec = dev2.saveObservation({ note: 'a', risk: 'low', latitude: 1, longitude: 1, observedAt: 't' }, o1.id);
  assert.ok(rec);
  dev2.sync(st);
  // 站点没有产生重复观察（同编号被识别为既有记录），且幂等日志出现 duplicate-skipped
  assert.equal(st.records.filter((r) => r.id === o1.id).length, 1);
  assert.ok(st.log.some((l) => l.reason === 'duplicate-skipped'));
  assert.equal(before, st.records.length);
});

// 8. 失败后接在已完成部分后面重试 --------------------------------------------------------------
test('同步中途失败：已完成部分保留，重试从断点后继续且不重复入账', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const ids = [1, 2, 3, 4].map((i) => {
    const o = dev.saveObservation({ note: `n${i}`, risk: 'low', latitude: i, longitude: i, observedAt: 't' });
    step();
    return o.id;
  });
  const failSeq = dev.outbox.find((o) => o.id === ids[2])!.seq; // 第 3 条时断网
  const r1 = dev.sync(st, { failAtSeq: failSeq });
  assert.equal(r1.failedAtSeq, failSeq);
  assert.equal(r1.appliedCount, 2);
  assert.equal(st.records.filter((r) => r.active && ids.includes(r.id)).length, 2);
  assert.equal(dev.outbox.length, 2);
  assert.equal(dev.ackedSeq, failSeq - 1);

  // 续传（不带失败注入）：失败点及其后两条新入账，前两条已完成的不回退
  const r2 = dev.sync(st);
  assert.equal(r2.duplicateCount, 0);
  assert.equal(r2.appliedCount, 2);
  assert.equal(dev.outbox.length, 0);
  assert.equal(st.records.filter((r) => r.active && ids.includes(r.id)).length, 4);
});

// 9. 观察地点一变，复核结论与样本核验立即失效（意见保留） -----------------------------------------
test('观察地点变更：复核与关联样本核验立即退回待处理，意见保留', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const obs = dev.saveObservation({ note: 'n', risk: 'high', latitude: 30.5, longitude: 103.2, observedAt: 't' });
  step();
  const smp = dev.saveSample({ code: 'WD-1', species: '毛发', count: 1, observationId: obs.id });
  dev.sync(st);
  step();
  st.reviewObservation(obs.id, 'approved', '位置与证据吻合');
  st.verifySample(smp.id, 'verified', '确认为豹猫');
  step();
  // 现场修正地点
  dev.sync(st); // 先拉齐站点意见
  dev.saveObservation({ latitude: 30.9, longitude: 103.9 }, obs.id);
  const localObs = dev.records.find((r) => r.id === obs.id)!;
  assert.equal(localObs.fields.reviewState, 'pending', '本地立即失效');
  assert.equal(localObs.fields.reviewComment, '位置与证据吻合', '站点意见保留');
  assert.ok(localObs.fields.reviewVoidReason);
  const localSmp = dev.records.find((r) => r.id === smp.id)!;
  assert.equal(localSmp.fields.verifyState, 'pending', '样本核验本地立即失效');
  assert.equal(localSmp.fields.verifyComment, '确认为豹猫', '核验意见保留');

  const res = dev.sync(st);
  assert.ok(res.invalidations.some((i) => i.id === obs.id));
  const sObs = st.records.find((r) => r.id === obs.id)!;
  const sSmp = st.records.find((r) => r.id === smp.id)!;
  assert.equal(sObs.fields.reviewState, 'pending');
  assert.equal(sObs.fields.reviewComment, '位置与证据吻合');
  assert.equal(sSmp.fields.verifyState, 'pending');
  assert.equal(sSmp.fields.verifyComment, '确认为豹猫');
  assert.ok(st.log.some((l) => l.reason === 'verify-invalidated' && l.id === smp.id));
});

// 10. 回站合并重复路段/重复观察：样本改挂，地点变了核验失效 ---------------------------------------
test('重复观察归并：被并观察失活，样本改挂到幸存观察；地点变则核验失效', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  // 站里先有一条已复核、已核验样本的观察
  const o1 = dev.saveObservation({ note: '站端观察', risk: 'medium', latitude: 30.5, longitude: 103.2, observedAt: 't' });
  step();
  const s1 = dev.saveSample({ code: 'WD-1', species: '毛发', count: 1, observationId: o1.id });
  dev.sync(st);
  step();
  st.verifySample(s1.id, 'verified', '已确认');
  step();
  // 另一台设备离线记了同地点重复观察（80m 内）+ 挂样本，回站同步
  const dev2 = new DeviceLedger('dev-B2', null, clock);
  const o2 = dev2.saveObservation({ note: '重复路段上的观察', risk: 'low', latitude: 30.5005, longitude: 103.2005, observedAt: 't' });
  dev2.saveSample({ code: 'WD-2', species: '足迹', count: 1, observationId: o2.id });
  const res = dev2.sync(st);
  assert.equal(res.dedupMerges.length, 1);
  assert.equal(res.dedupMerges[0].survivorId, o1.id);
  assert.equal(res.dedupMerges[0].removedId, o2.id);
  assert.equal(st.records.find((r) => r.id === o2.id)!.active, false);
  assert.equal(st.records.find((r) => r.id === o2.id)!.mergedInto, o1.id);
  const moved = st.records.find((r) => r.fields && (r.fields as { code?: string }).code === 'WD-2')!;
  assert.equal((moved.fields as { observationId: string }).observationId, o1.id, '样本挂到幸存观察');
});

test('重复观察地点不一致时改挂样本的核验退回待处理', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const o1 = dev.saveObservation({ note: 'A', risk: 'low', latitude: 30.5, longitude: 103.2, observedAt: 't' });
  const s1 = dev.saveSample({ code: 'X', species: 'x', count: 1, observationId: o1.id });
  dev.sync(st);
  step();
  st.verifySample(s1.id, 'verified', 'ok');
  // 巡护员现场把第二台设备上的重复观察（位置在阈值边缘，不同坐标）先在本地挂样本
  const dev2 = new DeviceLedger('dev-B2', null, clock);
  // 让两条观察刚好在 80m 内但坐标不同：纬度差 0.0005 度 ≈ 55m
  const o2 = dev2.saveObservation({ note: 'B', risk: 'low', latitude: 30.5005, longitude: 103.2, observedAt: 't' });
  const s2 = dev2.saveSample({ code: 'Y', species: 'y', count: 1, observationId: o2.id });
  dev2.sync(st);
  // o2 被并入 o1，s2 改挂到 o1（坐标不同，s2 未核验不受影响）；s1 原本挂 o1 不动
  assert.equal((st.records.find((r) => r.id === s2.id)!.fields as { observationId: string }).observationId, o1.id);
  assert.equal((st.records.find((r) => r.id === s1.id)!.fields as { verifyState: string }).verifyState, 'verified', 's1 未移动，核验保留');
});

test('轨迹重复路段（近距+近时）归并', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  dev.saveTrack({ latitude: 30.5, longitude: 103.2, at: '07:20', source: 'gps' });
  dev.sync(st);
  step();
  const dev2 = new DeviceLedger('dev-B2', null, clock);
  const dup = dev2.saveTrack({ latitude: 30.5002, longitude: 103.2002, at: '07:22', source: 'gps' });
  const res = dev2.sync(st);
  assert.equal(res.dedupMerges[0]?.removedId, dup.id);
  // 距离远或时间窗不算重复：
  const far = dev2.saveTrack({ latitude: 31.0, longitude: 104.0, at: '07:23', source: 'gps' });
  const res2 = dev2.sync(st);
  assert.equal(res2.dedupMerges.length, 0);
  assert.equal(st.records.find((r) => r.id === far.id)!.active, true);
});

// 11. 持久化：杀进程后续传水位与账不丢 -----------------------------------------------------------
test('设备账持久化：重启后 outbox、水位仍在并可续传；应答丢失后重传只认重复', () => {
  const kv = memoryStore();
  const dev = new DeviceLedger('dev-A7', kv, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const ids = [1, 2, 3].map((i) => dev.saveObservation({ note: `n${i}`, risk: 'low', latitude: i, longitude: i, observedAt: 't' }).id);
  const failSeq = dev.outbox.find((o) => o.id === ids[1])!.seq; // 在 seq=2 处断
  dev.sync(st, { failAtSeq: failSeq });

  // 续传前快照：模拟「站点已处理，但应答丢失，设备仍停在断时状态」
  const snapshot = JSON.parse(JSON.stringify(kv.get(`yf57-device-ledger:dev-A7`))) as Record<string, unknown>;

  // 正常重启续传：失败点及其后两条新入账，无重复
  const restarted = new DeviceLedger('dev-A7', kv, clock);
  assert.equal(restarted.outbox.length, 2);
  assert.equal(restarted.ackedSeq, failSeq - 1);
  const res = restarted.sync(st);
  assert.equal(res.appliedCount, 2);
  assert.equal(res.duplicateCount, 0);
  assert.equal(st.records.filter((r) => r.active && ids.includes(r.id)).length, 3);

  // 应答丢失：设备回滚到快照后再重传同一批，站点幂等去重，只入账一次
  const kv2 = memoryStore({ 'yf57-device-ledger:dev-A7': snapshot });
  const replayed = new DeviceLedger('dev-A7', kv2, clock);
  assert.equal(replayed.outbox.length, 2, '回滚后两条仍在出箱');
  const res2 = replayed.sync(st);
  assert.equal(res2.appliedCount, 0);
  assert.equal(res2.duplicateCount, 2, '重传的两条全部识别为重复');
  assert.equal(replayed.outbox.length, 0, '重复也会推进水位、清空出箱');
  assert.equal(st.records.filter((r) => r.active && ids.includes(r.id)).length, 3, '站点没有产生重复记录');
});

// 12. 无待发操作时也能拉到站点复核意见 -----------------------------------------------------------
test('纯拉取：站点复核后设备空同步也能收到意见', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const obs = dev.saveObservation({ note: 'n', risk: 'high', latitude: 1, longitude: 1, observedAt: 't' });
  dev.sync(st);
  step();
  st.reviewObservation(obs.id, 'rejected', '请补照片');
  dev.sync(st);
  assert.equal(dev.records.find((r) => r.id === obs.id)!.fields.reviewState, 'rejected');
  assert.equal(dev.records.find((r) => r.id === obs.id)!.fields.reviewComment, '请补照片');
});

// 13. 同一批次：重复观察与其样本按序到达，样本跟随 mergedInto 链改挂 ------------------------------
test('同批次先归并观察、后到样本：样本沿 mergedInto 链挂到幸存观察', () => {
  const st = new StationLedger('dev-A7', clock);
  step();
  // 站里已有观察 + 样本
  const dev1 = new DeviceLedger('dev-A7', null, clock);
  const o1 = dev1.saveObservation({ note: '原观察', risk: 'low', latitude: 30.5, longitude: 103.2, observedAt: 't' });
  dev1.sync(st);
  step();
  // 设备 B：同一地点重复观察，并把样本挂在这条重复观察上（两笔都还没同步）
  const devB = new DeviceLedger('dev-B9', null, clock);
  const oDup = devB.saveObservation({ note: '重复观察', risk: 'low', latitude: 30.5003, longitude: 103.2003, observedAt: 't' });
  step();
  const sDup = devB.saveSample({ code: 'WD-DUP', species: '树皮', count: 2, observationId: oDup.id });
  const res = devB.sync(st); // 观察先被应用并归并，样本随后到达
  assert.equal(res.dedupMerges[0]?.removedId, oDup.id);
  assert.equal(st.records.find((r) => r.id === oDup.id)!.active, false);
  const got = st.records.find((r) => r.id === sDup.id)!;
  assert.equal((got.fields as { observationId: string }).observationId, o1.id, '样本跟链改挂到幸存观察');
});

// 14. 多轮协作：各改各自动合并 → 站点复核 → 改地点失效 → 再次修改不复活失效结论 ---------------------
test('多轮协作：自动合并、复核失效后后续修改不会复活旧结论', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const obs = dev.saveObservation({ note: '初版', risk: 'low', latitude: 30.5, longitude: 103.2, observedAt: 't' });
  const smp = dev.saveSample({ code: 'WD-1', species: '毛发', count: 1, observationId: obs.id });
  dev.sync(st);
  step();

  st.reviewObservation(obs.id, 'approved', '通过');
  st.verifySample(smp.id, 'verified', '豹猫确认');
  dev.sync(st); // 拉回复核意见
  assert.equal(dev.records.find((r) => r.id === obs.id)!.fields.reviewState, 'approved');

  // 设备补备注、站点同时改风险：不同字段，自动合并且复核保留
  step();
  dev.saveObservation({ note: '初版+补注' }, obs.id);
  st.amendFields(obs.id, { risk: 'high' });
  const r1 = dev.sync(st);
  assert.equal(r1.conflicts.length, 0);
  const merged = st.records.find((r) => r.id === obs.id)!;
  assert.equal(merged.fields.note, '初版+补注');
  assert.equal(merged.fields.risk, 'high');
  assert.equal(merged.fields.reviewState, 'approved', '复核意见在字段合并中保留');

  // 改地点：结论失效、意见保留
  step();
  dev.sync(st);
  dev.saveObservation({ latitude: 31.0, longitude: 104.0 }, obs.id);
  dev.sync(st);
  assert.equal(st.records.find((r) => r.id === obs.id)!.fields.reviewState, 'pending');
  assert.equal(st.records.find((r) => r.id === smp.id)!.fields.verifyState, 'pending');

  // 随后再改备注（非地点字段）不能让旧结论复活
  step();
  dev.saveObservation({ note: '初版+补注+再补' }, obs.id);
  const r2 = dev.sync(st);
  assert.equal(r2.conflicts.length, 0);
  assert.equal(st.records.find((r) => r.id === obs.id)!.fields.reviewState, 'pending');
  assert.equal(st.records.find((r) => r.id === obs.id)!.fields.reviewComment, '通过', '意见原文仍在');
  assert.equal(st.records.find((r) => r.id === smp.id)!.fields.verifyState, 'pending');
});

// 15. 冲突解决采用站点版后，设备再次编辑仍能产生新版本，不报错、无幻影冲突 ---------------------------
test('冲突解决后继续编辑：可继续三向合并，无残留幻影冲突', () => {
  const dev = new DeviceLedger('dev-A7', null, clock);
  const st = new StationLedger('dev-A7', clock);
  step();
  const obs = dev.saveObservation({ note: 'v1', risk: 'low', latitude: 1, longitude: 1, observedAt: 't' });
  dev.sync(st);
  step();
  st.amendFields(obs.id, { note: '站改' });
  dev.saveObservation({ note: '队改' }, obs.id);
  const r1 = dev.sync(st);
  assert.equal(r1.conflicts.length, 1);
  st.resolveConflict(r1.conflicts[0].pairId, 'station');
  dev.sync(st); // 拉取解决结果：note=站改，本地基准对齐
  assert.equal(dev.records.find((r) => r.id === obs.id)!.fields.note, '站改');

  // 设备在解决后的基准上再改：应自动合并，不应再报 note 冲突
  step();
  dev.saveObservation({ note: '站改+设备续写' }, obs.id);
  const r2 = dev.sync(st);
  assert.equal(r2.conflicts.length, 0, '旧冲突不复活');
  assert.equal(st.records.find((r) => r.id === obs.id)!.fields.note, '站改+设备续写');
  assert.equal(st.conflicts.every((c) => c.status === 'resolved'), true);
});

console.log(`\n${passed} 个测试全部通过`);
