/**
 * 预算功能端到端集成测试（不依赖外部 MySQL）：
 * 使用 TypeORM sqljs 驱动在内存中建表，加载真实的 Module/Controller/Service/Guard，
 * 通过 HTTP 验证：登录鉴权（401）、发起者归属（403）、录入/修改/汇总/超支差额、
 * 非负校验、跨行程隔离，以及旧接口不受影响。
 *
 * 运行：先 `npm run build`，再 `node test/budget.e2e.js`（sql.js / @nestjs/testing 通过 --no-save 安装）。
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
  const port = app.getHttpServer().address().port;
  http = {
    get: (path, token) => request(port, 'GET', path, undefined, token),
    post: (path, body, token) => request(port, 'POST', path, body, token),
    patch: (path, body, token) => request(port, 'PATCH', path, body, token)
  };
}

function request(port, method, path, body, token) {
  return new Promise(resolve => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = require('http').request({ port, path: `/api${path}`, method, headers }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
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

async function run() {
  await start();

  console.log('— 准备：两个用户（各为不同行程的发起者）—');
  // 注册即得到用户 id，再登录拿 JWT
  const ownerA = await http.post('/users/register', { email: 'a@trip.com', nickname: '阿甲', password: 'pass1234' });
  const ownerB = await http.post('/users/register', { email: 'b@trip.com', nickname: '阿乙', password: 'pass1234' });
  const tokenA = (await http.post('/users/login', { email: 'a@trip.com', password: 'pass1234' })).body.token;
  const tokenB = (await http.post('/users/login', { email: 'b@trip.com', password: 'pass1234' })).body.token;
  assert.ok(tokenA && tokenB, '两位用户登录获取 token');

  const tripA = (await http.post('/trips', {
    ownerId: ownerA.body.id, destination: '大理', departDate: '2026-10-01', days: 5,
    budgetMin: 1000, budgetMax: 5000, transport: '公共交通', companionCount: 3
  })).body.id;
  const tripB = (await http.post('/trips', {
    ownerId: ownerB.body.id, destination: '青海湖', departDate: '2026-10-05', days: 7,
    budgetMin: 2000, budgetMax: 6800, transport: '自驾', companionCount: 2
  })).body.id;

  console.log('— 身份校验：未登录 / 非发起者 —');
  await test('未登录 POST 录入预算被拒绝（401 AUTH_REQUIRED）', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'transport', planned: 1, spent: 0 });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
  });
  await test('未登录 PATCH 修改预算被拒绝（401）', async () => {
    const res = await http.patch(`/trips/${tripA}/budgets/1`, { spent: 1 });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
  });
  await test('伪造/失效 token 被拒绝（401，不返回 500）', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'food', planned: 1, spent: 0 }, 'not-a-real-jwt');
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.code, 'AUTH_REQUIRED');
  });
  await test('已登录但非行程发起者写入被拒绝（403 NOT_TRIP_OWNER）', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'transport', planned: 1000, spent: 800 }, tokenB);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'NOT_TRIP_OWNER');
  });
  await test('非发起者 PATCH 被拒绝（403）', async () => {
    const res = await http.patch(`/trips/${tripA}/budgets/1`, { spent: 1 }, tokenB);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'NOT_TRIP_OWNER');
  });
  await test('非发起者访问不存在的行程返回 404（不泄漏归属信息）', async () => {
    const res = await http.post('/trips/99999/budgets', { category: 'food', planned: 1, spent: 0 }, tokenB);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'TRIP_NOT_FOUND');
  });

  console.log('— 发起者正常写入：录入 / 汇总 / 超支 —');
  await test('GET 预算无需登录即可查看', async () => {
    const res = await http.get(`/trips/${tripA}/budgets`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.categories.length, 0);
  });
  await test('发起者录入交通金额，返回分类与差额', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'transport', planned: 1000, spent: 800 }, tokenA);
    assert.strictEqual(res.status, 201);
    const row = res.body.categories.find(c => c.category === 'transport');
    assert.strictEqual(row.categoryLabel, '交通');
    assert.strictEqual(row.planned, 1000);
    assert.strictEqual(row.spent, 800);
    assert.strictEqual(row.diff, -200);
    assert.strictEqual(res.body.totalPlanned, 1000);
    assert.strictEqual(res.body.totalSpent, 800);
  });
  await test('发起者录入超支餐饮，overBudget 标记正确', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'food', planned: 500, spent: 720.5 }, tokenA);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.categories.find(c => c.category === 'food').overBudget, true);
    assert.strictEqual(res.body.totalSpent, 1520.5);
    assert.strictEqual(res.body.overBudget, true);
  });
  await test('重复 POST 同分类为覆盖更新，不产生重复行', async () => {
    await http.post(`/trips/${tripA}/budgets`, { category: 'lodging', planned: 600, spent: 0 }, tokenA);
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'lodging', planned: 650, spent: 300 }, tokenA);
    const lodging = res.body.categories.filter(c => c.category === 'lodging');
    assert.strictEqual(lodging.length, 1);
    assert.strictEqual(lodging[0].planned, 650);
    assert.strictEqual(lodging[0].spent, 300);
  });
  await test('发起者 PATCH 修改金额成功', async () => {
    const list = await http.get(`/trips/${tripA}/budgets`);
    const id = list.body.categories.find(c => c.category === 'transport').id;
    const res = await http.patch(`/trips/${tripA}/budgets/${id}`, { spent: 1300 }, tokenA);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.categories.find(c => c.category === 'transport').spent, 1300);
  });

  console.log('— 原有校验与隔离在鉴权接入后仍生效 —');
  await test('发起者写入负数仍被拒绝（NEGATIVE_AMOUNT）', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'other', planned: -1, spent: 0 }, tokenA);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'NEGATIVE_AMOUNT');
  });
  await test('发起者 PATCH 负数被拒绝且原值不变', async () => {
    const list = await http.get(`/trips/${tripA}/budgets`);
    const id = list.body.categories.find(c => c.category === 'transport').id;
    const res = await http.patch(`/trips/${tripA}/budgets/${id}`, { planned: -5 }, tokenA);
    assert.strictEqual(res.status, 400);
    const after = await http.get(`/trips/${tripA}/budgets`);
    assert.strictEqual(after.body.categories.find(c => c.category === 'transport').planned, 1000);
  });
  await test('非法分类仍被拒绝（VALIDATION_FAILED）', async () => {
    const res = await http.post(`/trips/${tripA}/budgets`, { category: 'shopping', planned: 10, spent: 0 }, tokenA);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'VALIDATION_FAILED');
  });
  await test('跨行程：B 的发起者走 B 路径改 A 的记录 id → 404（记录不属于 B，数据不串改）', async () => {
    const listA = await http.get(`/trips/${tripA}/budgets`);
    const id = listA.body.categories.find(c => c.category === 'transport').id;
    // tokenB 通过 B 的归属校验，但该 id 属于 A → BUDGET_NOT_FOUND
    const res = await http.patch(`/trips/${tripB}/budgets/${id}`, { spent: 1 }, tokenB);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.code, 'BUDGET_NOT_FOUND');
    const afterA = await http.get(`/trips/${tripA}/budgets`);
    assert.strictEqual(afterA.body.categories.find(c => c.category === 'transport').spent, 1300);
  });
  await test('跨身份：B 的发起者走 A 路径改 A 的记录 → 403（非 A 发起者）', async () => {
    const listA = await http.get(`/trips/${tripA}/budgets`);
    const id = listA.body.categories.find(c => c.category === 'transport').id;
    const res = await http.patch(`/trips/${tripA}/budgets/${id}`, { spent: 1 }, tokenB);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'NOT_TRIP_OWNER');
    const afterA = await http.get(`/trips/${tripA}/budgets`);
    assert.strictEqual(afterA.body.categories.find(c => c.category === 'transport').spent, 1300);
  });
  await test('行程 B 看不到行程 A 的预算数据', async () => {
    const res = await http.get(`/trips/${tripB}/budgets`);
    assert.strictEqual(res.body.categories.length, 0);
  });
  await test('行程 B 发起者可正常写自己的行程（各自行程互不影响）', async () => {
    const res = await http.post(`/trips/${tripB}/budgets`, { category: 'transport', planned: 2000, spent: 1900 }, tokenB);
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.totalPlanned, 2000);
  });

  console.log('— 旧功能回归 —');
  await test('GET /trips 旧列表接口正常（无需登录）', async () => {
    const res = await http.get('/trips');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 2);
  });
  await test('POST /companions/score 旧匹配接口正常', async () => {
    const res = await http.post('/companions/score', {
      candidate: { destination: '大理', budgetMax: 5000 },
      target: { destination: '大理', budgetMax: 5000 }
    });
    assert.strictEqual(res.body.score, 100);
  });
  await test('GET /diaries/:tripId 旧日记接口正常', async () => {
    const res = await http.get('/diaries/1');
    assert.ok(Array.isArray(res.body));
  });
  await test('用户注册/登录旧接口正常签发 token', async () => {
    const res = await http.post('/users/login', { email: 'a@trip.com', password: 'pass1234' });
    assert.ok(res.body.token);
    assert.strictEqual(res.body.user.nickname, '阿甲');
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
