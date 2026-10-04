import { useMemo, useState } from 'react';
import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  recordFieldEntry,
  resolveConflict,
  saveObservation,
  saveSample,
  saveTrack,
  stationEdit,
  stationReview,
  stationVerify,
  sync,
  type RootState
} from '../../store';
import type { ObservationFields, SampleFields, TrackFields } from '../../sync';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

const riskText: Record<ObservationFields['risk'], string> = { low: '低', medium: '中', high: '高' };
const reviewText: Record<ObservationFields['reviewState'], string> = { pending: '待复核', approved: '复核通过', rejected: '复核驳回' };
const verifyText: Record<SampleFields['verifyState'], string> = { pending: '待核验', verified: '核验通过', rejected: '核验驳回' };

const FALLBACK = { latitude: 30.5, longitude: 103.2 };

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { note: '', risk: 'low', species: '', count: '1' }
  });
  const [coords, setCoords] = useState(FALLBACK);
  const [reviewComment, setReviewComment] = useState('证据充分，同意通过');

  const refreshGps = async () => {
    try {
      const r = await Taro.getLocation({ type: 'gcj02' });
      setCoords({ latitude: r.latitude, longitude: r.longitude });
    } catch {
      setCoords((c) => ({ latitude: c.latitude + 0.001, longitude: c.longitude + 0.001 }));
    }
  };

  const recordPoint = async () => {
    let p = coords;
    try {
      const r = await Taro.getLocation({ type: 'gcj02' });
      p = { latitude: r.latitude, longitude: r.longitude };
    } catch {
      p = { latitude: coords.latitude + 0.0008, longitude: coords.longitude + 0.0006 };
      setCoords(p);
    }
    dispatch(saveTrack({ latitude: Number(p.latitude.toFixed(6)), longitude: Number(p.longitude.toFixed(6)), source: 'gps' }));
  };

  const submit = (values: FormValues) => {
    // 保存即带设备号与修订号；有样本名称时样本在同一事务里挂到这条新观察上
    dispatch(recordFieldEntry({
      note: values.note,
      risk: values.risk,
      latitude: coords.latitude,
      longitude: coords.longitude,
      sample: values.species.trim() ? { species: values.species.trim(), count: Number(values.count) || 1 } : undefined
    }));
    reset();
  };

  const observations = useMemo(
    () => state.records.filter((r) => r.kind === 'observation').sort((a, b) => Number(b.active) - Number(a.active)),
    [state.records]
  );
  const tracks = state.records.filter((r) => r.kind === 'track');
  const samples = state.records.filter((r) => r.kind === 'sample');
  const pendingConflicts = state.conflicts.filter((c) => c.status === 'pending');

  const obs = (r: { fields: unknown }) => r.fields as ObservationFields;
  const trk = (r: { fields: unknown }) => r.fields as TrackFields;
  const smp = (r: { fields: unknown }) => r.fields as SampleFields;

  return <View className="page">
    <View className="hero">
      <Text className="eyebrow">FIELD PATROL / 可续作合并账</Text>
      <Text className="title">{t.title}</Text>
      <Text className="sub">设备 {state.deviceId} · 出箱水位 seq={state.ackedSeq} · 待发 {state.outboxCount} 条 · 站点修订 #{state.stationRevision}</Text>
    </View>

    <View className="metrics">
      <View><Text>观察</Text><Text className="metric">{observations.filter((r) => r.active).length}</Text></View>
      <View><Text>待发 / 冲突</Text><Text className="metric warn">{state.outboxCount} / {pendingConflicts.length}</Text></View>
      <View><Text>样本 / 轨迹</Text><Text className="metric">{samples.length} / {tracks.filter((r) => r.active).length}</Text></View>
    </View>

    <View className="card">
      <View className="card-title">现场记录（断网保存，带设备与修订号）</View>
      <form onSubmit={handleSubmit(submit)}>
        <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} />
        <View className="two">
          <Input className="input" placeholder="样本名称（可选）" {...register('species')} />
          <Input className="input" type="number" placeholder="数量" {...register('count')} />
        </View>
        <View className="risk">
          <Text>风险等级</Text>
          <select {...register('risk')}>
            <option value="low">低</option><option value="medium">中</option><option value="high">高</option>
          </select>
        </View>
        <Text className="muted">观察地点：{coords.latitude.toFixed(5)}, {coords.longitude.toFixed(5)}（保存时随信封入账）</Text>
        <View className="row-actions">
          <Button size="mini" onClick={refreshGps}>刷新 GPS</Button>
        </View>
        <Button className="primary" formType="submit">{t.save}</Button>
        <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
      </form>
    </View>

    <View className="card">
      <View className="card-title">回站同步<Text className="count">{state.outboxCount} 条待发</Text></View>
      <View className="row-actions">
        <Button size="mini" type="primary" onClick={() => dispatch(sync())}>网络恢复，同步并逐字段合并</Button>
        <Button size="mini" disabled={state.outboxCount === 0} onClick={() => dispatch(sync({ failAtSeq: -1 }))}>
          模拟传到一半断网
        </Button>
      </View>
      {state.lastSync && <View className="sync-summary">
        <Text className="hint">
          上次同步：新入账 {state.lastSync.applied}，重传去重 {state.lastSync.duplicates}，
          字段冲突 {state.lastSync.conflicts}，失效 {state.lastSync.invalidations}，重复归并 {state.lastSync.dedup}
          {state.lastSync.failedAtSeq ? `，断点 seq=${state.lastSync.failedAtSeq}（重试自动接在已完成部分之后）` : '，全部完成'}
        </Text>
      </View>}
      <Text className="hint">重传按设备+稳定编号+修订号幂等，同一条只入账一次；站点复核/核验字段永不被设备覆盖。</Text>
    </View>

    {pendingConflicts.length > 0 && <View className="card conflict-card">
      <View className="card-title">两边都改过：已留两版 / 本地优先<Text className="count">{pendingConflicts.length} 项</Text></View>
      <ScrollView scrollY className="list">
        {pendingConflicts.map((c) => <View className="conflict-row" key={c.pairId + c.field}>
          <View>
            <Text className="obs-title">{c.kind === 'observation' ? '观察' : c.kind === 'track' ? '轨迹点' : '样本'} {c.id.slice(0, 16)}… · 字段 {c.field}</Text>
            <Text className="muted">
              本地版：{String(c.localValue)}　｜　站点版：{String(c.stationValue)}
              {c.kind === 'sample' && '（样本已按本地优先入账，站点值留档）'}
              {(c.kind === 'observation' || c.kind === 'track') && '（站点原值已整版留存，未静默覆盖）'}
            </Text>
          </View>
          <View className="alert-actions">
            <Button size="mini" onClick={() => dispatch(resolveConflict({ pairId: c.pairId, resolution: 'local' }))}>采用本地</Button>
            <Button size="mini" onClick={() => dispatch(resolveConflict({ pairId: c.pairId, resolution: 'station' }))}>采用站点</Button>
          </View>
        </View>)}
      </ScrollView>
    </View>}

    <View className="card">
      <View className="card-title">观察记录与站点复核</View>
      <ScrollView scrollY className="list">
        {observations.map((item) => {
          const f = obs(item);
          return <View className={`observation ${item.fork ? `fork fork-${item.fork.side}` : ''} ${item.active ? '' : 'inactive'}`} key={item.id}>
            <View className="grow">
              <Text className="obs-title">
                {f.risk === 'high' ? '高风险 · ' : ''}{f.note || '（无备注）'}
                {item.fork && <Text className={`badge badge-${item.fork.side}`}>{item.fork.side === 'local' ? '本地版' : '站点留版'}</Text>}
                {!item.active && <Text className="badge badge-merged">已归并→{item.mergedInto?.slice(0, 14)}…</Text>}
              </Text>
              <Text className="muted">
                {f.observedAt} · {riskText[f.risk]} · ({f.latitude.toFixed(4)}, {f.longitude.toFixed(4)})
              </Text>
              <Text className="muted">
                rev {item.rev}{item.stationRev ? ` · 站#${item.stationRev}` : ''} · {reviewText[f.reviewState]}
                {f.reviewComment ? `：${f.reviewComment}` : ''}
              </Text>
              {f.reviewVoidReason && <Text className="void-reason">⚠ {f.reviewVoidReason}</Text>}
              {item.active && !item.fork && <View className="row-actions wrap">
                <Button size="mini" onClick={() => dispatch(saveObservation({ id: item.id, note: `${f.note}（现场补充 ${new Date().toLocaleTimeString()}）` }))}>本地补备注</Button>
                <Button size="mini" onClick={() => dispatch(saveObservation({ id: item.id, latitude: f.latitude + 0.012, longitude: f.longitude + 0.009 }))}>本地挪位置（触发失效）</Button>
                <Button size="mini" onClick={() => dispatch(stationEdit({ id: item.id, patch: { note: `${f.note}（站端纠错）` } }))}>站端纠错备注</Button>
                <Button size="mini" onClick={() => dispatch(stationReview({ id: item.id, state: 'approved', comment: reviewComment || '通过' }))}>站里复核通过</Button>
                <Button size="mini" onClick={() => dispatch(stationReview({ id: item.id, state: 'rejected', comment: reviewComment || '请补证据' }))}>站里驳回</Button>
              </View>}
            </View>
          </View>;
        })}
      </ScrollView>
      <View className="station-input">
        <Text className="muted">复核意见：</Text>
        <Input className="input" value={reviewComment} onInput={(e) => setReviewComment(e.detail.value)} />
      </View>
    </View>

    <View className="card">
      <View className="card-title">轨迹点（重复路段回站自动归并）</View>
      {tracks.slice(-8).map((item) => {
        const f = trk(item);
        return <View className={`sample ${item.active ? '' : 'inactive'}`} key={item.id}>
          <Text>
            {f.latitude.toFixed(5)}, {f.longitude.toFixed(5)} · {f.at} · {f.source}
            {item.fork && <Text className={`badge badge-${item.fork.side}`}> {item.fork.side === 'local' ? '本地版' : '站点留版'}</Text>}
            {!item.active && <Text className="badge badge-merged"> 重复路段已归并</Text>}
          </Text>
        </View>;
      })}
    </View>

    <View className="card">
      <View className="card-title">样本、挂接与站点核验</View>
      {samples.map((item) => {
        const f = smp(item);
        return <View className="sample" key={item.id}>
          <View className="grow">
            <Text className="obs-title">{f.code} · {f.species} × {f.count}</Text>
            <Text className="muted">
              挂观察：{f.observationId ? f.observationId.slice(0, 16) + '…' : '未挂'} · {verifyText[f.verifyState]}
              {f.verifyComment ? `：${f.verifyComment}` : ''}
            </Text>
            {f.verifyVoidReason && <Text className="void-reason">⚠ {f.verifyVoidReason}</Text>}
            {item.active && <View className="row-actions">
              <Button size="mini" onClick={() => dispatch(stationVerify({ id: item.id, state: 'verified', comment: reviewComment || '核验通过' }))}>核验通过</Button>
              <Button size="mini" onClick={() => dispatch(stationVerify({ id: item.id, state: 'rejected', comment: reviewComment || '证据不足' }))}>核验驳回</Button>
              <Button size="mini" onClick={() => dispatch(saveSample({ id: item.id, count: f.count + 1 }))}>本地改数量</Button>
              <Button size="mini" onClick={() => dispatch(stationEdit({ id: item.id, patch: { count: f.count + 5 } }))}>站端改数量</Button>
            </View>}
          </View>
        </View>;
      })}
    </View>

    <View className="card">
      <View className="card-title">合并账流水（设备侧，最近 15 条）</View>
      {state.deviceLog.slice(-15).reverse().map((l, i) => (
        <Text className="log-line" key={`${l.at}-${i}`}>[{l.at.slice(11, 19)}] {reasonText(l.reason)} {l.kind ?? ''} {l.id ? l.id.slice(0, 14) + '… ' : ''}{l.detail ?? ''}{l.seq ? `（seq=${l.seq}）` : ''}</Text>
      ))}
    </View>
  </View>;
}

function reasonText(reason: string): string {
  const map: Record<string, string> = {
    saved: '保存',
    applied: '自动合并入账',
    'duplicate-skipped': '重传去重',
    'field-auto-merged': '字段合并',
    'conflict-forked': '冲突留两版',
    'conflict-local-wins': '冲突本地优先',
    'review-invalidated': '复核失效',
    'verify-invalidated': '核验失效',
    'dedup-merged': '重复归并',
    'conflict-resolved': '冲突已解决',
    'sync-failed': '同步中断'
  };
  return map[reason] ?? reason;
}
