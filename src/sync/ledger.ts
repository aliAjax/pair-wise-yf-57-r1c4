/**
 * 合并账本体。
 *
 * DeviceLedger（设备/巡护员侧）：
 * - 保存即落信封：稳定编号 + deviceId + 单调修订号，改动记入 outbox。
 * - outbox 带幂等键，失败重试时整段重发，站点只入账一次。
 * - ack 水位线让重传"接在已完成部分后面"。
 *
 * StationLedger（站里侧）：
 * - 按幂等键去重；三向逐字段合并；观察/轨迹两边都改 -> 分叉两版。
 * - 站点复核/核验字段站点专属，永远不被设备覆盖；样本冲突本地优先。
 * - 观察地点变更 -> 复核结论与关联样本核验立即退回待处理（意见保留）。
 * - 回站重复路段/重复观察归并，样本改挂到幸存观察。
 */
import {
  ConflictEntry,
  KindedFields,
  LedgerEntry,
  OutboxOp,
  RecordEnvelope,
  RecordKind,
  SyncResult,
  STATION_OWNED_FIELDS
} from './types';
import {
  defaultFields,
  deepEqual,
  invalidateOnLocationChange,
  isDuplicatePair,
  isStationOwned,
  mergeField,
  reattachOnDedup,
  resolveObservationLink
} from './merge';

export interface KVStore {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
}

export interface Clock { now(): string; }

export const systemClock: Clock = { now: () => new Date().toISOString() };

export function memoryStore(initial: Record<string, unknown> = {}): KVStore {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get: <T,>(key: string) => (map.has(key) ? (map.get(key) as T) : null),
    set: (key, value) => { map.set(key, value); }
  };
}

interface ApplyFieldOutcome {
  field: string;
  kind: 'applied' | 'conflict';
  deviceValue: unknown;
  stationValue: unknown;
}

interface ApplyOutcome {
  duplicate: boolean;
  created: boolean;
  applied: ApplyFieldOutcome[];
  conflicts: ApplyFieldOutcome[];
  /** 应用后的站点记录；冲突时其冲突字段已为设备值（观察/轨迹会再分叉）。 */
  record?: RecordEnvelope;
  locationMoved?: { id: string; reason: string };
  dedup?: { survivorId: string; removedId: string };
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** 统一信封上的字段按松散键值访问，规避联合类型的索引签名限制。 */
function fieldBag(rec: RecordEnvelope): Record<string, unknown> {
  return rec.fields as unknown as Record<string, unknown>;
}
function asFields(value: Record<string, unknown>): KindedFields[RecordKind] {
  return value as unknown as KindedFields[RecordKind];
}

function pairIdFor(id: string, idemKey: string) {
  return `${id}::${idemKey}`;
}

function forkRecordId(id: string, pairId: string) {
  return `${id}::station-fork::${pairId}`;
}

/** 站点账：复核、核验、归并、冲突留版都发生在这里。 */
export class StationLedger {
  records: RecordEnvelope[] = [];
  conflicts: ConflictEntry[] = [];
  log: LedgerEntry[] = [];
  /** 已入账的幂等键：重传只入账一次。 */
  private appliedKeys = new Set<string>();
  /** 站点全局修订号：每次入账/复核/解决冲突自增，设备增量拉取的水位。 */
  revision = 0;

  constructor(private readonly deviceId: string, private readonly clock: Clock = systemClock) {}

  private bump(rec: RecordEnvelope) {
    this.revision += 1;
    rec.stationRev = this.revision;
    rec.updatedAt = this.clock.now();
  }

  private appendLog(entry: Omit<LedgerEntry, 'at' | 'deviceId'>) {
    this.log.push({ at: this.clock.now(), deviceId: this.deviceId, ...entry });
  }

  private find(id: string, activeOnly = false): RecordEnvelope | undefined {
    return this.records.find((r) => r.id === id && (!activeOnly || r.active));
  }

  /** 站点复核观察：结论 + 意见都留痕。 */
  reviewObservation(id: string, state: 'approved' | 'rejected', comment: string): boolean {
    const rec = this.find(id, true);
    if (!rec || rec.kind !== 'observation') return false;
    Object.assign(rec.fields, { reviewState: state, reviewComment: comment, reviewVoidReason: '' });
    rec.fieldRevs.reviewState = this.revision + 1;
    rec.fieldRevs.reviewComment = this.revision + 1;
    this.bump(rec);
    this.appendLog({ reason: 'saved', kind: 'observation', id, detail: `站点复核：${state}（${comment}）` });
    return true;
  }

  /** 站点核验样本。 */
  verifySample(id: string, state: 'verified' | 'rejected', comment: string): boolean {
    const rec = this.find(id, true);
    if (!rec || rec.kind !== 'sample') return false;
    Object.assign(rec.fields, { verifyState: state, verifyComment: comment, verifyVoidReason: '' });
    rec.fieldRevs.verifyState = this.revision + 1;
    rec.fieldRevs.verifyComment = this.revision + 1;
    this.bump(rec);
    this.appendLog({ reason: 'saved', kind: 'sample', id, detail: `站点核验：${state}（${comment}）` });
    return true;
  }

  /** 站端直接修正业务字段（另一台设备/站员纠错），用于与设备本地改动形成两边都改。 */
  amendFields(id: string, patch: Record<string, unknown>): boolean {
    const rec = this.find(id, true);
    if (!rec) return false;
    for (const [field, value] of Object.entries(patch)) {
      if (isStationOwned(rec.kind, field)) continue;
      fieldBag(rec)[field] = value;
    }
    this.bump(rec);
    this.appendLog({ reason: 'saved', kind: rec.kind, id, detail: `站端纠错字段：${Object.keys(patch).join(', ')}` });
    return true;
  }

  /**
   * 应用单条出站操作。幂等：同一 idemKey 第二次到达直接跳过。
   */
  applyOp(op: OutboxOp): ApplyOutcome {
    if (this.appliedKeys.has(op.idemKey)) {
      this.appendLog({ reason: 'duplicate-skipped', kind: op.kind, id: op.id, seq: op.seq, idemKey: op.idemKey });
      return { duplicate: true, created: false, applied: [], conflicts: [] };
    }

    const base = (op as OutboxOp & { baseFields?: Record<string, unknown> }).baseFields ?? {};
    let rec = this.find(op.id);
    const created = !rec;

    if (!rec) {
      const fields = defaultFields(op.kind) as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(op.fields)) {
        if (!isStationOwned(op.kind, k)) fields[k] = v;
      }
      rec = {
        id: op.id,
        kind: op.kind,
        deviceId: op.deviceId,
        rev: op.rev,
        fieldRevs: Object.fromEntries(op.changed.map((f) => [f, op.rev])),
        fields: asFields(fields),
        active: true,
        updatedAt: this.clock.now()
      };
      this.records.push(rec);
    }

    const before = clone(rec.fields);
    const beforeFieldRevs = { ...rec.fieldRevs };
    const applied: ApplyFieldOutcome[] = [];
    const conflicts: ApplyFieldOutcome[] = [];

    for (const field of op.changed) {
      if (isStationOwned(op.kind, field)) continue; // 站点字段永不被设备覆盖
      const outcome = mergeField(
        op.kind,
        field,
        base[field],
        op.fields[field],
        fieldBag(rec)[field]
      );
      if (outcome.type === 'applied') {
        fieldBag(rec)[field] = outcome.value;
        applied.push({ field, kind: 'applied', deviceValue: outcome.value, stationValue: outcome.value });
      } else if (outcome.type === 'conflict') {
        conflicts.push({ field, kind: 'conflict', deviceValue: outcome.deviceValue, stationValue: outcome.stationValue });
      }
    }

    rec.rev = Math.max(rec.rev, op.rev);
    for (const a of applied) rec.fieldRevs[a.field] = this.revision + 1;

    // 样本挂接的观察可能已被重复路段归并：跟随 mergedInto 链改挂，地点变了就失效。
    if (rec.kind === 'sample') {
      const relink = resolveObservationLink(rec, this.records);
      if (relink) {
        this.appendLog({ reason: 'dedup-merged', kind: 'sample', id: rec.id, seq: op.seq, detail: `样本改挂到归并后的观察 ${relink.survivorId}` });
        if (relink.voided) {
          this.appendLog({ reason: 'verify-invalidated', kind: 'sample', id: rec.id, seq: op.seq, detail: '改挂后地点变化，核验退回待处理' });
        }
      }
    }

    let locationMoved: ApplyOutcome['locationMoved'];
    if (!created && rec.kind === 'observation' && applied.some((a) => a.field === 'latitude' || a.field === 'longitude')) {
      const beforeObs = before as KindedFields['observation'];
      const afterObs = rec.fields as KindedFields['observation'];
      if (beforeObs.latitude !== afterObs.latitude || beforeObs.longitude !== afterObs.longitude) {
        const reason = `观察地点由 (${beforeObs.latitude}, ${beforeObs.longitude}) 变为 (${afterObs.latitude}, ${afterObs.longitude})，复核结论与样本核验退回待处理`;
        const movedSamples = invalidateOnLocationChange(rec.id, afterObs, reason, this.records);
        this.appendLog({ reason: 'review-invalidated', kind: 'observation', id: rec.id, seq: op.seq, detail: reason });
        for (const sid of movedSamples) {
          this.appendLog({ reason: 'verify-invalidated', kind: 'sample', id: sid, seq: op.seq, detail: `关联观察 ${rec.id} 地点变更` });
        }
        locationMoved = { id: rec.id, reason };
      }
    }

    const pairId = pairIdFor(op.id, op.idemKey);

    if (conflicts.length > 0 && (rec.kind === 'observation' || rec.kind === 'track')) {
      // 观察/轨迹两边都改过：站点原值整版留存（fork），规范记录放设备版，不静默覆盖。
      // 快照取「本次应用前」的字段与字段修订，自动合并进来的设备字段不能污染站点版。
      const stationCopy: RecordEnvelope = {
        ...clone(rec),
        id: forkRecordId(op.id, pairId),
        fields: before,
        fieldRevs: beforeFieldRevs,
        stationRev: undefined,
        active: true,
        fork: { pairId, side: 'station' },
        mergedInto: undefined
      };
      this.records.push(stationCopy);
      for (const c of conflicts) {
        fieldBag(rec)[c.field] = c.deviceValue;
        rec.fieldRevs[c.field] = this.revision + 1;
        const entry: ConflictEntry = {
          pairId,
          kind: rec.kind,
          id: rec.id,
          field: c.field,
          localValue: c.deviceValue,
          stationValue: c.stationValue,
          status: 'pending',
          createdAt: this.clock.now()
        };
        this.conflicts.push(entry);
        this.appendLog({ reason: 'conflict-forked', kind: rec.kind, id: rec.id, seq: op.seq, detail: `字段 ${c.field} 两边都改，已留两版` });
      }
      rec.fork = { pairId, side: 'local' };
      this.bump(stationCopy);
    } else if (conflicts.length > 0 && rec.kind === 'sample') {
      // 样本不复制第二版记录：本地新写优先，站点原值在冲突条目中留档。
      for (const c of conflicts) {
        fieldBag(rec)[c.field] = c.deviceValue;
        rec.fieldRevs[c.field] = this.revision + 1;
        this.conflicts.push({
          pairId,
          kind: 'sample',
          id: rec.id,
          field: c.field,
          localValue: c.deviceValue,
          stationValue: c.stationValue,
          status: 'pending',
          stationFieldsSnapshot: { [c.field]: c.stationValue },
          createdAt: this.clock.now()
        });
        this.appendLog({ reason: 'conflict-local-wins', kind: 'sample', id: rec.id, seq: op.seq, detail: `字段 ${c.field} 两边都改，本地值优先入账，站点值留档` });
      }
    }

    if (applied.length > 0) {
      this.appendLog({ reason: 'applied', kind: op.kind, id: op.id, seq: op.seq, detail: `字段 ${applied.map((a) => a.field).join(', ')} 自动合并` });
      for (const a of applied) {
        this.appendLog({ reason: 'field-auto-merged', kind: op.kind, id: rec.id, seq: op.seq, detail: a.field });
      }
    }

    this.appliedKeys.add(op.idemKey);
    this.bump(rec);

    // 回站归并：与既有规范记录重复（距离/时间阈值）-> 合到幸存记录，样本改挂。
    let dedup: ApplyOutcome['dedup'];
    if ((rec.kind === 'observation' || rec.kind === 'track') && !rec.fork) {
      const other = this.records.find((r) =>
        r.active && !r.fork && r.id !== rec.id && r.kind === rec.kind && isDuplicatePair(rec.kind, r, rec)
      );
      if (other) {
        const moved = reattachOnDedup(other, rec, this.records);
        rec.active = false;
        rec.mergedInto = other.id;
        rec.updatedAt = this.clock.now();
        dedup = { survivorId: other.id, removedId: rec.id };
        this.bump(other);
        this.appendLog({ reason: 'dedup-merged', kind: rec.kind, id: rec.id, seq: op.seq, detail: `重复${rec.kind === 'track' ? '路段' : '观察'}归并到 ${other.id}；${moved.length} 个样本改挂` });
        for (const sid of moved) this.appendLog({ reason: 'verify-invalidated', kind: 'sample', id: sid, seq: op.seq, detail: '改挂观察地点变化，核验退回待处理' });
      }
    }

    return { duplicate: false, created, applied, conflicts, record: rec, locationMoved, dedup };
  }

  /**
   * 顺序处理一批操作；注入 failAtSeq 可模拟中途断网：
   * 已提交的部分保留在站点账上，重传时靠幂等键跳过。
   */
  runBatch(ops: OutboxOp[], failAtSeq?: number): { outcomes: ApplyOutcome[]; failedAtSeq?: number } {
    const outcomes: ApplyOutcome[] = [];
    for (const op of ops) {
      if (failAtSeq !== undefined && op.seq >= failAtSeq) {
        this.appendLog({ reason: 'sync-failed', seq: op.seq, idemKey: op.idemKey, detail: `同步在 seq=${op.seq} 中断，已完成部分保留，等待续传` });
        return { outcomes, failedAtSeq: op.seq };
      }
      outcomes.push(this.applyOp(op));
    }
    return { outcomes };
  }

  /** 解决冲突：观察/轨迹在两版之间择一；样本可改取站点留档值。 */
  resolveConflict(pairId: string, resolution: 'local' | 'station'): boolean {
    const entries = this.conflicts.filter((c) => c.pairId === pairId);
    if (entries.length === 0) return false;
    const kind = entries[0].kind;
    const id = entries[0].id;

    if (kind === 'observation' || kind === 'track') {
      const canonical = this.find(id, true);
      const stationFork = this.find(forkRecordId(id, pairId), true);
      if (canonical && stationFork) {
        if (resolution === 'station') {
          for (const e of entries) {
            fieldBag(canonical)[e.field] = fieldBag(stationFork)[e.field];
            canonical.fieldRevs[e.field] = this.revision + 1;
          }
        }
        canonical.fork = undefined;
        stationFork.active = false;
        stationFork.mergedInto = canonical.id;
        this.bump(canonical);
      }
    } else {
      const rec = this.find(id, true);
      if (rec && resolution === 'station') {
        for (const e of entries) {
          const snap = e.stationFieldsSnapshot ?? {};
          if (e.field in snap) {
            fieldBag(rec)[e.field] = snap[e.field];
            rec.fieldRevs[e.field] = this.revision + 1;
          }
        }
      }
      if (rec) this.bump(rec);
    }

    for (const e of entries) {
      e.status = 'resolved';
      e.resolution = resolution;
    }
    this.appendLog({ reason: 'conflict-resolved', kind, id, detail: `冲突对 ${pairId} 采用${resolution === 'local' ? '本地版' : '站点版'}` });
    return true;
  }

  /** 增量拉取：游标之后变动的记录（含失效、归并、分叉、解决冲突的结果）+ 全部冲突条目。 */
  buildPull(cursor: number, ackIds: string[]): { revision: number; records: RecordEnvelope[]; conflicts: ConflictEntry[] } {
    const picked = new Map<string, RecordEnvelope>();
    for (const r of this.records) {
      if ((r.stationRev ?? 0) > cursor) picked.set(r.id, r);
    }
    // 本会话刚入账的记录无论游标都带上，保证设备出箱清空后立刻对齐最终值。
    for (const id of ackIds) {
      for (const r of this.records) {
        if (r.id === id || r.id.startsWith(`${id}::station-fork::`)) picked.set(r.id, r);
      }
    }
    return { revision: this.revision, records: [...picked.values()].map(clone), conflicts: clone(this.conflicts) };
  }
}

/** 设备账：离线保存、断点续传、拉取对齐。 */
export class DeviceLedger {
  records: RecordEnvelope[] = [];
  outbox: OutboxOp[] = [];
  conflicts: ConflictEntry[] = [];
  log: LedgerEntry[] = [];
  private seq = 0;
  private pullCursor = 0;
  /** 已确认连续入账的 outbox 水位（持久化，重启后续传）。 */
  ackedSeq = 0;

  constructor(
    readonly deviceId: string,
    private readonly store: KVStore | null = null,
    private readonly clock: Clock = systemClock,
    storageKey = `yf57-device-ledger:${deviceId}`
  ) {
    this.storageKey = storageKey;
    this.restore();
  }

  private storageKey: string;

  private persist() {
    if (!this.store) return;
    this.store.set(this.storageKey, {
      records: this.records,
      outbox: this.outbox,
      conflicts: this.conflicts,
      log: this.log.slice(-500),
      seq: this.seq,
      pullCursor: this.pullCursor,
      ackedSeq: this.ackedSeq
    });
  }

  private restore() {
    if (!this.store) return;
    const saved = this.store.get<{
      records: RecordEnvelope[]; outbox: OutboxOp[]; conflicts: ConflictEntry[]; log: LedgerEntry[];
      seq: number; pullCursor: number; ackedSeq: number;
    }>(this.storageKey);
    if (!saved) return;
    this.records = saved.records;
    this.outbox = saved.outbox;
    this.conflicts = saved.conflicts;
    this.log = saved.log ?? [];
    this.seq = saved.seq;
    this.pullCursor = saved.pullCursor;
    this.ackedSeq = saved.ackedSeq ?? 0;
  }

  private appendLog(entry: Omit<LedgerEntry, 'at' | 'deviceId'>) {
    this.log.push({ at: this.clock.now(), deviceId: this.deviceId, ...entry });
    this.persist();
  }

  /** 稳定编号：设备标识 + 本地单调计数 + 随机后缀，断网生成、全局稳定。 */
  private newId(kind: RecordKind): string {
    this.seq += 1;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${kind[0]}-${this.deviceId}-${this.seq.toString(36)}-${rand}`;
  }

  /**
   * 保存（新建或改记）。保存即带设备与修订号，改动字段进入 outbox。
   * 观察地点在本地一变，关联样本核验与复核结论立即退回待处理（意见保留）。
   */
  save<K extends RecordKind>(kind: K, patch: Partial<KindedFields[K]>, id?: string): RecordEnvelope<K> {
    let rec = id ? this.records.find((r) => r.id === id) as RecordEnvelope<K> | undefined : undefined;
    if (rec && !rec.active) {
      throw new Error(`记录 ${id} 已被重复归并（mergedInto=${rec.mergedInto}），不能继续在原编号上保存，请在幸存记录上修改`);
    }
    const created = !rec;

    if (!rec) {
      const newId = id ?? this.newId(kind);
      rec = {
        id: newId,
        kind,
        deviceId: this.deviceId,
        rev: 0,
        fieldRevs: {},
        fields: clone(defaultFields(kind)) as KindedFields[K],
        active: true,
        updatedAt: this.clock.now()
      };
      this.records.unshift(rec);
    }

    const changed: string[] = [];
    for (const [field, value] of Object.entries(patch)) {
      if (isStationOwned(kind, field)) continue; // 设备不写站点字段
      const current = fieldBag(rec)[field];
      if (!deepEqual(current, value)) {
        fieldBag(rec)[field] = value;
        changed.push(field);
      }
    }
    if (changed.length === 0 && !created) return rec;

    rec.rev += 1;
    for (const f of changed) rec.fieldRevs[f] = rec.rev;
    rec.updatedAt = this.clock.now();

    // 地点一变，本地立即失效（站点应用时还会权威地再失效一次，结论一致）。
    if (!created && kind === 'observation' && (changed.includes('latitude') || changed.includes('longitude'))) {
      const obs = rec.fields as KindedFields['observation'];
      const reason = `观察地点本地变更，复核结论与样本核验立即退回待处理`;
      const moved = invalidateOnLocationChange(rec.id, obs, reason, this.records);
      if (obs.reviewState !== 'pending' || moved.length) {
        this.appendLog({ reason: 'review-invalidated', kind: 'observation', id: rec.id, detail: reason });
        moved.forEach((sid) => this.appendLog({ reason: 'verify-invalidated', kind: 'sample', id: sid, detail: '关联观察地点本地变更' }));
      }
    }

    // 新建时即使字段为空也入账（占位记录）；否则仅在有实际改动时入 outbox。
    if (created || changed.length > 0) {
      this.seq += 1;
      const op: OutboxOp = {
        seq: this.seq,
        idemKey: `${this.deviceId}:${rec.id}:${rec.rev}`,
        deviceId: this.deviceId,
        kind,
        id: rec.id,
        rev: rec.rev,
        changed: created ? Object.keys(rec.fields).filter((f) => !isStationOwned(kind, f)) : changed,
        baseStationRev: rec.stationRev ?? 0,
        fields: clone(rec.fields) as unknown as Record<string, unknown>,
        createdAt: this.clock.now()
      };
      (op as OutboxOp & { baseFields?: Record<string, unknown> }).baseFields = clone(rec.baseFields ?? {});
      this.outbox.push(op);
      this.appendLog({ reason: 'saved', kind, id: rec.id, seq: this.seq, detail: created ? '新建入账' : `本地修改字段：${changed.join(', ')}` });
    }

    this.persist();
    return rec;
  }

  /** 设备端手工补记轨迹点（来源 manual）。 */
  saveTrack(patch: Partial<KindedFields['track']>, id?: string) {
    return this.save('track', patch, id);
  }
  saveObservation(patch: Partial<KindedFields['observation']>, id?: string) {
    return this.save('observation', patch, id);
  }
  saveSample(patch: Partial<KindedFields['sample']>, id?: string) {
    return this.save('sample', patch, id);
  }

  /**
   * 与站点同步。失败可重入：重传整段未确认 outbox，站点幂等去重，
   * 已完成部分不重复入账，未完成部分从断点之后继续。
   */
  sync(station: StationLedger, opts: { failAtSeq?: number } = {}): SyncResult {
    const result: SyncResult = {
      acknowledgedSeq: this.ackedSeq,
      appliedCount: 0,
      duplicateCount: 0,
      autoMerged: [],
      conflicts: [],
      invalidations: [],
      dedupMerges: [],
      pulledRevision: this.pullCursor
    };

    const pending = [...this.outbox].sort((a, b) => a.seq - b.seq);
    if (pending.length === 0 && opts.failAtSeq === undefined) {
      this.pull(station, []);
      result.pulledRevision = this.pullCursor;
      return result;
    }

    const { outcomes, failedAtSeq } = station.runBatch(pending, opts.failAtSeq);

    // outcomes 与 pending 按下标对齐：站点处理到失败点为止，重传时前面的靠幂等键跳过。
    for (let i = 0; i < outcomes.length; i += 1) {
      const op = pending[i];
      const o = outcomes[i];
      if (o.duplicate) {
        result.duplicateCount += 1;
      } else {
        result.appliedCount += 1;
        for (const a of o.applied) result.autoMerged.push({ kind: op.kind, id: op.id, field: a.field });
        for (const c of o.conflicts) {
          result.conflicts.push({
            pairId: pairIdFor(op.id, op.idemKey),
            kind: op.kind,
            id: op.id,
            field: c.field,
            localValue: c.deviceValue,
            stationValue: c.stationValue,
            status: 'pending',
            createdAt: this.clock.now()
          });
        }
        if (o.locationMoved) result.invalidations.push({ kind: 'observation', id: o.locationMoved.id, reason: o.locationMoved.reason });
        if (o.dedup) result.dedupMerges.push({ kind: op.kind, survivorId: o.dedup.survivorId, removedId: o.dedup.removedId });
      }
    }

    if (failedAtSeq !== undefined) result.failedAtSeq = failedAtSeq;

    // 水位只推进到「站点确实处理完」的最后一个序号；失败点及其后留在 outbox。
    const lastProcessedSeq = outcomes.length > 0 ? pending[outcomes.length - 1].seq : this.ackedSeq;
    const ackThrough = failedAtSeq !== undefined
      ? failedAtSeq - 1
      : (pending.length > 0 ? pending[pending.length - 1].seq : this.ackedSeq);
    if (ackThrough > this.ackedSeq) this.ackedSeq = ackThrough;
    const ackIds = pending.filter((op) => op.seq <= this.ackedSeq).map((op) => op.id);
    this.outbox = this.outbox.filter((op) => op.seq > this.ackedSeq);

    this.pull(station, ackIds);
    result.pulledRevision = this.pullCursor;
    result.acknowledgedSeq = this.ackedSeq;
    if (failedAtSeq !== undefined) {
      this.appendLog({ reason: 'sync-failed', seq: failedAtSeq, detail: `同步中断，已完成部分（seq≤${lastProcessedSeq}）保留，续传从 seq=${failedAtSeq} 开始` });
    }
    this.persist();
    return result;
  }

  /** 拉取站点增量并对齐：站点复核/核验字段总取站点；有未同步改动的业务字段保留本地，其余取站点值。 */
  private pull(station: StationLedger, ackIds: string[]) {
    const payload = station.buildPull(this.pullCursor, ackIds);

    for (const incoming of payload.records) {
      const local = this.records.find((r) => r.id === incoming.id);
      const rootId = incoming.fork?.side === 'station' ? incoming.id.split('::station-fork::')[0] : incoming.id;
      const keepLocalBusiness = this.outbox.some((op) => op.id === rootId);

      if (!local) {
        // 站点分叉版、站点复核过的记录等：直接入账并把站点快照作为对齐基准。
        const inserted = clone(incoming);
        inserted.baseFields = clone(incoming.fields);
        inserted.baseFieldRevs = clone(incoming.fieldRevs);
        inserted.baseRev = incoming.stationRev;
        this.records.unshift(inserted);
        continue;
      }

      local.active = incoming.active;
      local.mergedInto = incoming.mergedInto;
      // 站点没有分叉角色（已解决）时清除本地遗留标记；有则以站点为准。
      if (incoming.fork) local.fork = incoming.fork;
      else if (!local.fork?.side || local.fork.side === 'station') local.fork = undefined;
      local.stationRev = incoming.stationRev;
      local.updatedAt = incoming.updatedAt;

      for (const [field, value] of Object.entries(incoming.fields) as [string, unknown][]) {
        if (isStationOwned(incoming.kind, field) || !keepLocalBusiness) {
          fieldBag(local)[field] = value;
        }
      }
      if (!keepLocalBusiness) {
        // 已无待发改动：本地完全对齐站点，基准 = 站点现值（下次三向合并的 base）。
        local.rev = incoming.rev;
        local.fieldRevs = clone(incoming.fieldRevs);
        local.baseFields = clone(incoming.fields);
        local.baseFieldRevs = clone(incoming.fieldRevs);
        local.baseRev = incoming.stationRev;
      } else {
        // 有待发改动：基准只吸收站点字段（复核意见），业务字段基准保持不动，
        // outbox 里已冻结的 baseFields 才是本次设备改动的合并基准。
        const base: Record<string, unknown> = { ...(local.baseFields ?? {}) };
        for (const [field, value] of Object.entries(incoming.fields) as [string, unknown][]) {
          if (isStationOwned(incoming.kind, field)) base[field] = value;
        }
        local.baseFields = base;
      }
    }

    this.conflicts = payload.conflicts;
    this.pullCursor = payload.revision;
  }
}

/** 设备 + 模拟站点一对账，持久化到同一 KV（页面/Redux 用）。 */
export class LedgerPair {
  readonly device: DeviceLedger;
  readonly station: StationLedger;

  constructor(deviceId: string, store: KVStore | null, clock: Clock = systemClock) {
    this.device = new DeviceLedger(deviceId, store, clock);
    const savedStation = store?.get<{
      records: RecordEnvelope[]; conflicts: ConflictEntry[]; log: LedgerEntry[]; revision: number; keys: string[];
    }>(`yf57-station-ledger:${deviceId}`);
    this.station = new StationLedger(deviceId, clock);
    if (savedStation) {
      this.station.records = savedStation.records;
      this.station.conflicts = savedStation.conflicts;
      this.station.log = savedStation.log;
      this.station.revision = savedStation.revision;
      // Set 的可持久化重建：
      for (const k of savedStation.keys) (this.station as unknown as { appliedKeys: Set<string> }).appliedKeys.add(k);
    }
  }

  persistStation(store: KVStore) {
    const keys = [...(this.station as unknown as { appliedKeys: Set<string> }).appliedKeys];
    store.set(`yf57-station-ledger:${this.device.deviceId}`, {
      records: this.station.records,
      conflicts: this.station.conflicts,
      log: this.station.log.slice(-500),
      revision: this.station.revision,
      keys
    });
  }
}

export { STATION_OWNED_FIELDS };
