import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addObservation,
  addPoint,
  addSample,
  armWeakNetworkFailure,
  dismissNotice,
  needsPost,
  resolvePair,
  reviewObservation,
  runSync,
  verifySample,
  type AppDispatch,
  type RootState,
} from '../../store';
import type { ConflictPair, PatrolObservation, Sample, SyncState, TrackPoint } from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

const SYNC_LABEL: Record<SyncState, string> = { local: '本地', queued: '待入账', synced: '已入账', conflict: '冲突·两版' };
const SAMPLE_LABEL: Record<Sample['status'], string> = { draft: '草稿', submitted: '待核验', verified: '已核验' };
const KIND_LABEL: Record<ConflictPair['kind'], string> = { observation: '观察', point: '轨迹点', sample: '样本' };

function shortDevice(deviceId: string): string {
  return deviceId.replace(/^dev-/, '').slice(-6);
}

function revMeta(rec: { rev: number; deviceId: string; sync: SyncState }): string {
  return `r${rec.rev} · 设备 …${shortDevice(rec.deviceId)} · ${SYNC_LABEL[rec.sync]}`;
}

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { note: '', risk: 'low', species: '', count: '1' } });

  const pending =
    state.observations.filter((o) => needsPost(o)).length +
    state.points.filter((p) => needsPost(p)).length +
    state.samples.filter((s) => needsPost(s)).length;
  const syncing = state.syncing?.active ?? false;
  const failed = state.syncing?.failed ?? false;
  const pairOf = (id: string) => state.conflicts.find((c) => c.localId === id || c.remoteId === id);

  const recordPoint = async () => {
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude }));
    } catch {
      dispatch(addPoint({ latitude: 30.5, longitude: 103.2 }));
    }
  };

  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) dispatch(addSample({ code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 }));
    reset();
  };

  const startSync = () => dispatch(runSync());
  const armAndSync = () => {
    armWeakNetworkFailure();
    dispatch(runSync());
  };

  return (
    <View className="page">
      <View className="hero">
        <Text className="eyebrow">FIELD PATROL / PORT 62022</Text>
        <Text className="title">{t.title}</Text>
        <Text className="sub">弱网也能记录，联网后按稳定编号逐字段合并；站点复核意见保留，两边都改就留两版。</Text>
      </View>

      <View className="metrics">
        <View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View>
        <View><Text>待入账</Text><Text className="metric warn">{pending}</Text></View>
        <View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View>
      </View>

      <View className="card">
        <View className="card-title">现场记录</View>
        <form onSubmit={handleSubmit(submit)}>
          <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} />
          <View className="two">
            <Input className="input" placeholder="物种或样本名称" {...register('species')} />
            <Input className="input" type="number" placeholder="数量" {...register('count')} />
          </View>
          <View className="risk">
            <Text>风险等级</Text>
            <select {...register('risk')}>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </View>
          <Button className="primary" formType="submit" disabled={syncing}>{t.save}</Button>
          <Button className="secondary" onClick={recordPoint} disabled={syncing}>记录当前轨迹点</Button>
        </form>
      </View>

      {state.notice && (
        <View className="alert notice">
          <Text>{state.notice}</Text>
          <Text className="hint">地点变更的观察已退回待处理：复核需重做，样本核验需重新核验。</Text>
          <View className="alert-actions"><Button size="mini" onClick={() => dispatch(dismissNotice())}>知道了</Button></View>
        </View>
      )}

      {state.conflicts.length > 0 && (
        <View className="alert conflict">
          <Text>合并账中有 {state.conflicts.length} 对记录两边都改过，已保留两版，不会静默覆盖：</Text>
          {state.conflicts.map((pair) => (
            <View key={pair.id} className="pair">
              <Text className="muted">{KIND_LABEL[pair.kind]} {pair.localId} ↔ {pair.remoteId}</Text>
              <View className="alert-actions">
                <Button size="mini" onClick={() => dispatch(resolvePair({ pairId: pair.id, choice: 'local' }))}>保留本地版</Button>
                <Button size="mini" onClick={() => dispatch(resolvePair({ pairId: pair.id, choice: 'remote' }))}>保留站点版</Button>
              </View>
            </View>
          ))}
        </View>
      )}

      <View className="card">
        <View className="card-title">{t.sync}<Text className="count">{pending} 条待入账</Text></View>
        <Button className="secondary" onClick={startSync} disabled={syncing}>
          {syncing ? '同步中…' : '恢复联网并同步'}
        </Button>
        <Button className="secondary" onClick={armAndSync} disabled={syncing}>模拟弱网中断后续作</Button>
        {syncing && <Text className="hint">正在逐笔记账：已入账 {state.syncing?.posted ?? 0} 条，重传按稳定编号去重，只入账一次。</Text>}
        {failed && !syncing && (
          <View className="alert conflict">
            <Text>弱网中断：已完成的 {state.syncing?.posted ?? 0} 条已入账并落游标，可从断点继续。</Text>
            <View className="alert-actions"><Button size="mini" onClick={startSync}>继续同步</Button></View>
          </View>
        )}
        {state.lastSummary && !syncing && !failed && (
          <Text className="hint">
            上次同步：入账 {state.lastSummary.posted} 条、去重 {state.lastSummary.duplicates} 条、采用站点 {state.lastSummary.adopted} 条、合并 {state.lastSummary.mergedFields} 处
            {state.lastSummary.conflicts > 0 ? `、两版冲突 ${state.lastSummary.conflicts} 对` : ''}。
          </Text>
        )}
        <Text className="hint">保存即带设备号与修订号；站点复核意见合并时保留，本地新写的字段优先。</Text>
      </View>

      <View className="card">
        <View className="card-title">观察记录</View>
        <ScrollView scrollY className="list">
          {state.observations.map((item: PatrolObservation) => {
            const pair = pairOf(item.id);
            const side = pair ? (pair.localId === item.id ? '本地版' : '站点版') : null;
            return (
              <View className="observation" key={item.id}>
                <View>
                  <Text className="obs-title">
                    {item.risk === 'high' ? '高风险 · ' : ''}{item.note}
                    {side ? <Text className="side-tag">{side}</Text> : null}
                  </Text>
                  {item.latitude !== undefined && item.longitude !== undefined && (
                    <Text className="muted">地点 {item.latitude.toFixed(4)}, {item.longitude.toFixed(4)} · </Text>
                  )}
                  <Text className="muted">{item.time} · {revMeta(item)}</Text>
                  {item.reviewNote ? <Text className="review-note">复核意见：{item.reviewNote}</Text> : null}
                </View>
                <Button size="mini" disabled={item.reviewed || item.risk === 'low' || syncing} onClick={() => dispatch(reviewObservation(item.id))}>
                  {item.reviewed ? '已复核' : '复核'}
                </Button>
              </View>
            );
          })}
        </ScrollView>
      </View>

      <View className="card">
        <View className="card-title">轨迹与样本</View>
        {state.points.slice(-3).map((point: TrackPoint) => (
          <NutCell
            key={point.id}
            title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`}
            description={`${point.at} · ${point.source} · ${revMeta(point)}`}
          />
        ))}
        {state.samples.map((sample: Sample) => (
          <View className="sample" key={sample.id}>
            <View>
              <Text>{sample.code} · {sample.species} × {sample.count}</Text>
              <Text className="muted">
                {SAMPLE_LABEL[sample.status]} · {revMeta(sample)}
                {sample.observationId ? ` · 挂 ${sample.observationId}` : ''}
              </Text>
            </View>
            <Button size="mini" disabled={sample.status === 'verified' || syncing} onClick={() => dispatch(verifySample(sample.id))}>
              {sample.status === 'verified' ? '已核验' : '核验'}
            </Button>
          </View>
        ))}
      </View>
    </View>
  );
}
