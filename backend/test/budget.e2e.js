/**
 * 预算功能端到端集成测试（不依赖外部 MySQL）：
 * 使用 TypeORM sqljs 驱动在内存中建表，加载真实的 Module/Controller/Service，
 * 通过 HTTP 验证：录入/修改/汇总/超支差额/非负校验/跨行程隔离，以及旧接口不受影响。
 *
 * 运行：先 `npm run build`，再 `node test/budget.e2e.js`（sql.js 通过 --no-save 安装）。
 */
const assert = require('assert');
const { Test } = require('@nestjs/testing');
const { TypeOrmModule } = require('@nestjs/typeorm');
const { HttpExceptionFilter } = require('../dist/common/filters/http-exception.filter');
const { UserModule } = require('../dist/modules/user/user.module');
const { TripModule } = require('../dist/modules/trip/trip.module');
const { CompanionModule } = require('../dist/modules/companion/companion.module');
const { DiaryModule } = require('../dist/modules/diary/diary.module');
const { BudgetModule } = require('../dist/modules/budget/budget.module');
const { UserEntity } = require('../dist/modules/user/user.entity');
const { TripEntity } = require('../dist/modules/trip/trip.entity');
const { BudgetEntity } = require('../dist/modules/budget/budget.entity');

let app;
let http;
const failures = [];

async function start() {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'sqljs',
        autoSave: false,
        synchronize: true,
        entities: [UserEntity, TripEntity, BudgetEntity],
        logging: false
      }),
      UserModule,
      TripModule,
      CompanionModule,
      DiaryModule,
      BudgetModule
    ]
  }).compile();

  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(0);
  const server = app.getHttpServer();
  const port = server.address().port;
  http = {
    get: (path) => request(port, 'GET', path),
    post: (path, body) => request(port, 'POST', path, body),
    patch: (path, body) => request(port, 'PATCH', path, body)
  };
}

function request(port, method, path, body) {
  return new Promise(resolve => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = require('http').request(
      { port, path: `/api${path}`, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} },
      res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      }
    );
    if (payload) req.write(payload);
    req.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

async function createTrip(destination) {
  const res = await http.post('/trips', {
    ownerId: 1,
    destination,
    departDate: '2026-10-01',
    days: 5,
    budgetMin: 1000,
    budgetMax: 5000,
    transport: '公共交通',
    companionCount: 3
  });
  assert.strictEqual(res.status, 201, `createTrip status ${res.status}`);
  return res.body.id;
}

async function run() {
  await start();

  console.log('— 前置：旧流程（行程）—');
  const tripA = await createTrip('大理');
  const tripB = await createTrip('青海湖');
  assert.ok(tripA && tripB, '两个行程创建成功');
  await test('GET /trips 旧列表接口正常返回', async () => {
    const res = await http.get('/trips');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 2);
  });
  await test('POST /companions/score 旧匹配接口正常', async () => {
    const res = await http.post('/companions/score', {
      candidate: { destination: '大理', budgetMax: 5000 },
      target: { destination: '大理', budgetMax: 5000 }
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.score, 100);
  });
  await test('GET /diaries/:tripId 旧日记接口正常', async () => {
    const res = await http.get('/diaries/1');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  console.log('— 新流程：预算录入与汇总 —');
  await test('空行程预算初始汇总为 0', async () => {
    const res = await http.get(`/trips/${tripA}/budgets`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
      { p: res.body.totalPlanned, s: res.body.totalSpent, d: res.body.totalDiff, over: res.body.overBudget },
      { p: 0, s: 0, d: 0, over: false }
    );
  });

  await test('录入交通分类计划/实际金额，返回分类金额与差额', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'transport', planned: 1000, spent: 800 });
    assert.strictEqual(res.status, 201);
    const row = res.body.categories.find(c => c.category === 'transport');
    assert.strictEqual(row.categoryLabel, '交通');
    assert.strictEqual(row.planned, 1000);
    assert.strictEqual(row.spent, 800);
    assert.strictEqual(row.diff, -200);
    assert.strictEqual(row.overBudget, false);
    assert.strictEqual(res.body.totalPlanned, 1000);
    assert.strictEqual(res.body.totalSpent, 800);
  });

  await test('超支时分类与总差额标记 overBudget', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'food', planned: 500, spent: 720.5 });
    assert.strictEqual(res.status, 201);
    const food = res.body.categories.find(c => c.category === 'food');
    assert.strictEqual(food.diff, 220.5);
    assert.strictEqual(food.overBudget, true);
    assert.strictEqual(res.body.totalPlanned, 1500);
    assert.strictEqual(res.body.totalSpent, 1520.5);
    assert.strictEqual(res.body.totalDiff, 20.5);
    assert.strictEqual(res.body.overBudget, true);
  });

  await test('重复 POST 同分类为覆盖更新（upsert），不产生重复行', async () => {
    await http.post(`/trips/${tripA}/budgets`, { category: 'lodging', planned: 600, spent: 0 });
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'lodging', planned: 650, spent: 300 });
    assert.strictEqual(res.status, 201);
    const lodging = res.body.categories.filter(c => c.category === 'lodging');
    assert.strictEqual(lodging.length, 1);
    assert.strictEqual(lodging[0].planned, 650);
    assert.strictEqual(lodging[0].spent, 300);
  });

  await test('PATCH 记录 id 修改成功（行程内成员可修改）', async () => {
    const list = await http.get(`/trips/${tripA}/budgets`);
    const transportId = list.body.categories.find(c => c.category === 'transport').id;
    const res = await http.patch(`/trips/${tripA}/budgets/${transportId}`, { spent: 1300 });
    assert.strictEqual(res.status, 200);
    const transport = res.body.categories.find(c => c.category === 'transport');
    assert.strictEqual(transport.spent, 1300);
    assert.strictEqual(transport.diff, 300);
    assert.strictEqual(transport.overBudget, true);
  });

  console.log('— 数据安全：非负 / 分类 / 隔离 —');
  await test('计划金额为负被拒绝（NEGATIVE_AMOUNT）', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'other', planned: -1, spent: 0 });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'NEGATIVE_AMOUNT');
  });

  await test('实际支出为负被拒绝', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'other', planned: 10, spent: -0.01 });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'NEGATIVE_AMOUNT');
  });

  await test('PATCH 负数被拒绝，且原值不被改动', async () => {
    const list = await http.get(`/trips/${tripA}/budgets`);
    const transportId = list.body.categories.find(c => c.category === 'transport').id;
    const res = await http.patch(`/trips/${tripA}/budgets/${transportId}`, { planned: -5 });
    assert.strictEqual(res.status, 400);
    const after = await http.get(`/trips/${tripA}/budgets`);
    assert.strictEqual(after.body.categories.find(c => c.category === 'transport').planned, 1000);
  });

  await test('非法分类被拒绝（VALIDATION_FAILED）', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'shopping', planned: 10, spent: 0 });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'VALIDATION_FAILED');
  });

  await test('非数字金额被拒绝', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'other', planned: 'abc', spent: 0 });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'VALIDATION_FAILED');
  });

  await test('跨行程：用行程 B 的路径改行程 A 的记录 id 被拒绝（BUDGET_NOT_FOUND，数据不串改）', async () => {
    const listA = await http.get(`/trips/${tripA}/budgets`);
    const transportId = listA.body.categories.find(c => c.category === 'transport').id;
    // 行程 B 存在，但其预算中没有该 id
    const res = await http.patch(`/trips/${tripB}/budgets/${transportId}`, { spent: 1 });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'BUDGET_NOT_FOUND');
    // A 的数据确实没被动过
    const afterA = await http.get(`/trips/${tripA}/budgets`);
    assert.strictEqual(afterA.body.categories.find(c => c.category === 'transport').spent, 1300);
  });

  await test('跨行程：行程 B 看不到行程 A 的预算数据', async () => {
    const res = await http.get(`/trips/${tripB}/budgets`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.categories.length, 0);
    assert.strictEqual(res.body.totalSpent, 0);
  });

  await test('不存在的行程返回 TRIP_NOT_FOUND', async () => {
    const res = await http.get('/trips/99999/budgets');
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'TRIP_NOT_FOUND');
  });

  await test('不存在的预算记录返回 404', async () => {
    const res = await http.patch(`/trips/${tripA}/budgets/99999`, { spent: 1 });
    assert.strictEqual(res.status, 404);
  });

  await app.close();

  console.log('');
  if (failures.length) {
    console.error(`✗ ${failures.length} 个用例失败：${failures.join('、')}`);
    process.exit(1);
  }
  console.log('全部预算集成测试通过 ✓');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
