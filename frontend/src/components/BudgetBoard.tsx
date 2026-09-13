import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  message
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { api, ApiError } from '../api';
import BudgetAuthBar, { getToken } from './BudgetAuthBar';
import type { BudgetCategoryItem, BudgetCategoryKey, BudgetSummary, TripItem } from '../types';

/** 固定四个分类，顺序即展示顺序；key 与后端 constants/budget.ts 保持一致 */
const CATEGORY_ORDER: Array<{ key: BudgetCategoryKey; label: string }> = [
  { key: 'transport', label: '交通' },
  { key: 'lodging', label: '住宿' },
  { key: 'food', label: '餐饮' },
  { key: 'other', label: '其他' }
];

interface DraftRow {
  key: string;
  category: BudgetCategoryKey;
  categoryLabel: string;
  planned: number;
  spent: number;
}

function buildDrafts(summary: BudgetSummary | null): DraftRow[] {
  const saved = new Map<BudgetCategoryKey, BudgetCategoryItem>();
  summary?.categories.forEach(item => saved.set(item.category, item));
  return CATEGORY_ORDER.map(cat => {
    const item = saved.get(cat.key);
    return {
      key: cat.key,
      category: cat.key,
      categoryLabel: cat.label,
      planned: item?.planned ?? 0,
      spent: item?.spent ?? 0
    };
  });
}

export default function BudgetBoard() {
  const [trips, setTrips] = useState<TripItem[]>([]);
  const [tripIdInput, setTripIdInput] = useState<number | null>(1);
  const [selectedTripId, setSelectedTripId] = useState<number | null>(null);
  const [summary, setSummary] = useState<BudgetSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tripsError, setTripsError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [token, setToken] = useState<string | null>(() => getToken());
  const isLoggedIn = token !== null;
  // 未保存的本地输入，按分类暂存；保存成功或切换行程后清空
  const [overrides, setOverrides] = useState<Record<string, { planned?: number; spent?: number }>>({});

  // 拉取行程列表，用于选择预算所属行程
  useEffect(() => {
    api<TripItem[]>('/trips')
      .then(items => {
        setTrips(items);
        if (items.length > 0 && selectedTripId === null) {
          setTripIdInput(items[0].id);
          setSelectedTripId(items[0].id);
        }
      })
      .catch(err => {
        setTrips([]);
        setTripsError(err instanceof Error ? err.message : '行程列表加载失败');
      });
    // 仅在挂载时拉取一次行程列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadBudget = useCallback(() => {
    if (selectedTripId === null) return;
    setLoading(true);
    setLoadError(null);
    api<BudgetSummary>(`/trips/${selectedTripId}/budgets`)
      .then(setSummary)
      .catch(err => {
        setSummary(null);
        setLoadError(err instanceof Error ? err.message : '预算加载失败');
      })
      .finally(() => setLoading(false));
  }, [selectedTripId]);

  // 行程切换或手动刷新时加载该行程预算（不同行程数据隔离）
  useEffect(() => {
    loadBudget();
  }, [loadBudget, reloadTick]);

  // 数据重新加载后清空未保存输入
  useEffect(() => setOverrides({}), [summary]);

  const rows = useMemo(() => buildDrafts(summary), [summary]);
  const displayRows = useMemo(
    () => rows.map(row => ({ ...row, ...overrides[row.key] })),
    [rows, overrides]
  );

  const patchRow = (key: string, patch: Partial<DraftRow>) =>
    setOverrides(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  const saveRow = async (row: DraftRow) => {
    if (selectedTripId === null) return;
    if (!isLoggedIn) {
      message.warning('请先以行程发起者身份登录后再保存预算');
      return;
    }
    if (row.planned === undefined || row.spent === undefined || Number.isNaN(row.planned) || Number.isNaN(row.spent)) {
      message.warning('请填写有效的金额');
      return;
    }
    setSavingKey(row.key);
    try {
      const updated = await api<BudgetSummary>(`/trips/${selectedTripId}/budgets`, {
        method: 'POST',
        body: JSON.stringify({ category: row.category, planned: row.planned, spent: row.spent })
      });
      setSummary(updated);
      message.success(`已保存「${row.categoryLabel}」预算`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        message.error('登录已失效，请重新登录');
      } else if (err instanceof ApiError && err.status === 403) {
        message.error('只有该行程的发起者可以修改预算');
      } else {
        message.error(err instanceof Error ? err.message : '保存失败');
      }
    } finally {
      setSavingKey(null);
    }
  };

  const diffCell = (row: DraftRow) => {
    const diff = Math.round(((row.spent ?? 0) - (row.planned ?? 0)) * 100) / 100;
    if (diff > 0) return <span style={{ color: '#cf1322', fontWeight: 600 }}>超支 +{diff.toFixed(2)}</span>;
    if (diff < 0) return <span style={{ color: '#3f8600' }}>剩余 {Math.abs(diff).toFixed(2)}</span>;
    return <span>0.00</span>;
  };

  const columns: ColumnsType<DraftRow> = [
    { title: '分类', dataIndex: 'categoryLabel', width: 120 },
    {
      title: '计划金额（元）',
      dataIndex: 'planned',
      width: 200,
      render: (_, row) => (
        <InputNumber
          min={0}
          precision={2}
          value={row.planned}
          onChange={value => patchRow(row.key, { planned: value ?? 0 })}
          style={{ width: '100%' }}
        />
      )
    },
    {
      title: '实际支出（元）',
      dataIndex: 'spent',
      width: 200,
      render: (_, row) => (
        <InputNumber
          min={0}
          precision={2}
          value={row.spent}
          onChange={value => patchRow(row.key, { spent: value ?? 0 })}
          style={{ width: '100%' }}
        />
      )
    },
    { title: '差额', width: 160, render: (_, row) => diffCell(row) },
    {
      title: '操作',
      width: 100,
      render: (_, row) => (
        <Button
          type="link"
          disabled={!isLoggedIn}
          loading={savingKey === row.key}
          onClick={() => saveRow(row)}
        >
          保存
        </Button>
      )
    }
  ];

  const totalDiff = summary?.totalDiff ?? 0;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small">
        <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space wrap>
            <span>选择行程：</span>
            <Select
              style={{ width: 320 }}
              placeholder="选择行程"
              value={selectedTripId}
              onChange={id => setSelectedTripId(id)}
              options={trips.map(trip => ({
                value: trip.id,
                label: `${trip.destination}（#${trip.id}，${trip.departDate}）`
              }))}
            />
            <Input
              type="number"
              addonBefore="行程ID"
              style={{ width: 170 }}
              value={tripIdInput ?? undefined}
              onChange={e => {
                const id = e.target.value === '' ? null : Number(e.target.value);
                setTripIdInput(id);
                if (id && Number.isInteger(id) && id > 0) setSelectedTripId(id);
              }}
            />
            <Button onClick={() => setReloadTick(tick => tick + 1)}>刷新</Button>
          </Space>
          <BudgetAuthBar onAuthChange={() => setToken(getToken())} />
        </Space>
      </Card>

      {tripsError && (
        <Alert
          type="error"
          showIcon
          message={`行程列表加载失败：${tripsError}`}
          description="请确认后端服务与 /api 反向代理是否正常；也可直接在右侧输入有效的行程 ID 后回车。"
        />
      )}

      {loadError && (
        <Alert
          type="error"
          showIcon
          message={loadError.includes('404') ? '该行程不存在，请先在「发布行程」中创建' : `预算加载失败：${loadError}`}
        />
      )}

      <Spin spinning={loading}>
        <Card title="分类预算（交通 / 住宿 / 餐饮 / 其他）" extra={<span style={{ color: '#999' }}>金额不允许为负</span>}>
          <Table<DraftRow> rowKey="key" columns={columns} dataSource={displayRows} pagination={false} />
        </Card>

        <Card title="预算汇总" style={{ marginTop: 16 }}>
          <Row gutter={16}>
            <Col span={8}>
              <Statistic title="总计划（元）" value={summary?.totalPlanned ?? 0} precision={2} />
            </Col>
            <Col span={8}>
              <Statistic title="总支出（元）" value={summary?.totalSpent ?? 0} precision={2} />
            </Col>
            <Col span={8}>
              <Statistic
                title={summary?.overBudget ? '总差额（超支）' : '总差额（剩余）'}
                value={Math.abs(totalDiff)}
                precision={2}
                prefix={summary?.overBudget ? '+' : totalDiff < 0 ? '-' : ''}
                valueStyle={{ color: summary?.overBudget ? '#cf1322' : '#3f8600' }}
              />
            </Col>
          </Row>
        </Card>
      </Spin>
    </Space>
  );
}
