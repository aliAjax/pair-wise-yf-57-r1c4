/**
 * 可续作合并账 —— 领域类型
 *
 * 三类业务记录：观察 observation / 轨迹点 track / 样本 sample。
 * 每条记录都装在统一信封里：稳定编号 id、产生设备 deviceId、修订号 rev，
 * 以及每个业务字段各自的字段修订号 fieldRevs，供联网后做三向逐字段合并。
 */

export type RecordKind = 'observation' | 'track' | 'sample';

/** 站点复核状态：未处理 / 通过 / 驳回；失效后退回 pending。 */
export type ReviewState = 'pending' | 'approved' | 'rejected';
/** 样本核验状态。 */
export type VerifyState = 'pending' | 'verified' | 'rejected';

/** 观察的可变业务字段。review* 是站点字段，设备端永远无权覆盖。 */
export interface ObservationFields {
  note: string;
  risk: 'low' | 'medium' | 'high';
  /** 观察地点：纬度。地点一旦变化，样本核验与复核结论立即失效。 */
  latitude: number;
  longitude: number;
  observedAt: string;
  /** 站点复核结论（站点字段）。 */
  reviewState: ReviewState;
  /** 站点复核意见（站点字段，合并时必须保留）。 */
  reviewComment: string;
  /** 复核失效原因，例如地点变更后结论退回待处理时保留痕迹。 */
  reviewVoidReason: string;
}

/** 轨迹点的可变业务字段。 */
export interface TrackFields {
  latitude: number;
  longitude: number;
  at: string;
  source: 'gps' | 'manual';
}

/** 样本的可变业务字段。verify* 是站点字段。 */
export interface SampleFields {
  code: string;
  species: string;
  count: number;
  /** 样本挂在哪条观察上；观察地点变化时随观察一起失效。 */
  observationId: string;
  /** 站点核验结论（站点字段）。 */
  verifyState: VerifyState;
  /** 站点核验意见（站点字段，合并时必须保留）。 */
  verifyComment: string;
  /** 核验失效原因。 */
  verifyVoidReason: string;
}

export interface KindedFields {
  observation: ObservationFields;
  track: TrackFields;
  sample: SampleFields;
}

/** 站点专属（设备无权写入）的字段集合，合并时站点值始终保留。 */
export const STATION_OWNED_FIELDS: Record<RecordKind, ReadonlySet<string>> = {
  observation: new Set(['reviewState', 'reviewComment', 'reviewVoidReason']),
  track: new Set([]),
  sample: new Set(['verifyState', 'verifyComment', 'verifyVoidReason'])
};

/**
 * 记录信封。设备端与站点端使用同一形状：
 * - rev：该记录在持有方的单调修订号（保存一次 +1）。
 * - fieldRevs：每个字段最后一次被改动时所在的修订号，三向合并的依据。
 * - baseRev / baseFields / baseFieldRevs：上一次与站点对齐时的快照（设备端）。
 * - fork：同一条观察/轨迹两边都改且不一致时，留下两版，不静默覆盖。
 */
export interface RecordEnvelope<K extends RecordKind = RecordKind> {
  id: string;
  kind: K;
  deviceId: string;
  rev: number;
  fieldRevs: Record<string, number>;
  /** 站点修订号（站点端产生）；设备端在拉齐后写入，作为下次合并的基准。 */
  stationRev?: number;
  baseRev?: number;
  baseFields?: Partial<KindedFields[K]>;
  baseFieldRevs?: Record<string, number>;
  fields: KindedFields[K];
  /** 活跃版本；冲突分叉出的副本或被重复路段合并掉的版本置 false。 */
  active: boolean;
  /** 非空时表示该记录是由某条冲突记录分叉出来的版本，值为冲突对 id。 */
  fork?: ConflictForkRole;
  /** 被哪条记录取代（重复路段合并后挂到幸存记录上）。 */
  mergedInto?: string;
  updatedAt: string;
}

export type ConflictForkRole = { pairId: string; side: 'local' | 'station' };

/** 一条待解决的冲突：观察/轨迹保留两版；样本按本地优先入账并登记。 */
export interface ConflictEntry {
  pairId: string;
  kind: RecordKind;
  id: string;
  field: string;
  localValue: unknown;
  stationValue: unknown;
  status: 'pending' | 'resolved';
  resolution?: 'local' | 'station';
  /** 样本类冲突不产生第二版记录，但站点原值在此留档。 */
  stationFieldsSnapshot?: Record<string, unknown>;
  createdAt: string;
}

/** 出站操作：保存即带设备和修订号。seq 单调递增，是重传去重的幂等键。 */
export interface OutboxOp {
  seq: number;
  /** 幂等键：设备 + 稳定编号 + 修订号，同一条重传只会入账一次。 */
  idemKey: string;
  deviceId: string;
  kind: RecordKind;
  id: string;
  rev: number;
  /** 本次保存改动的字段。 */
  changed: string[];
  /** 保存时设备所依据的站点修订号（新记录为 0）。 */
  baseStationRev: number;
  fields: Record<string, unknown>;
  createdAt: string;
}

export type LogReason =
  | 'saved'
  | 'applied'
  | 'duplicate-skipped'
  | 'field-auto-merged'
  | 'conflict-forked'
  | 'conflict-local-wins'
  | 'review-invalidated'
  | 'verify-invalidated'
  | 'dedup-merged'
  | 'conflict-resolved'
  | 'sync-failed';

/** 合并账流水：只追加，记录每一次入账/合并/失效，可续作、可审计。 */
export interface LedgerEntry {
  at: string;
  deviceId: string;
  kind?: RecordKind;
  id?: string;
  reason: LogReason;
  detail?: string;
  /** 关联出站操作，用于断点续传时判断是否已处理。 */
  seq?: number;
  idemKey?: string;
}

export interface SyncResult {
  /** 本次会话确认入账（或此前已入账）的出站操作序号，断点续传的水位。 */
  acknowledgedSeq: number;
  /** 本次新应用的操作数（重复重传不计）。 */
  appliedCount: number;
  /** 跳过的重复操作数。 */
  duplicateCount: number;
  /** 本次同步新发现的字段自动合并。 */
  autoMerged: Array<{ kind: RecordKind; id: string; field: string }>;
  /** 本次同步新产生的冲突。 */
  conflicts: ConflictEntry[];
  /** 本次同步触发的失效（地点变更）。 */
  invalidations: Array<{ kind: RecordKind; id: string; reason: string }>;
  /** 本次同步触发的重复路段/重复观察归并。 */
  dedupMerges: Array<{ kind: RecordKind; survivorId: string; removedId: string }>;
  /** 失败时在哪个 seq 中断；已完成的部分保留，重试从其后继续。 */
  failedAtSeq?: number;
  pulledRevision: number;
}
