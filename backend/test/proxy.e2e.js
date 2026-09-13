/**
 * 复现并验证 nginx 反向代理对 /api 前缀的处理：
 *  - 旧规则 proxy_pass http://backend:3000/;  → nginx 用 "/" 替换 "/api/" 前缀（剥前缀）→ 后端 404
 *  - 新规则 proxy_pass http://backend:3000;   → 透传完整原始路径（含 /api）           → 正常
 *
 * 这里用 Node http 代理精确模拟上述两种 URI 改写语义，后端是加载真实模块/路由的 Nest 应用，
 * 从而在没有 nginx 二进制的环境中验证预算页经代理加载、保存、校验与跨行程隔离。
 *
 * 运行：先 npm run build，再 node test/proxy.e2e.js
 */
const http = require('http');
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

/** 模拟 nginx：stripPrefix=true 复刻旧的带斜杠 proxy_pass，false 复刻新的不带 URI proxy_pass */
function startProxy(targetPort, stripPrefix) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const pathname = stripPrefix ? url.pathname.replace(/^\/api\//, '/') : url.pathname;
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const proxyReq = http.request(
          {
            port: targetPort,
            path: pathname + url.search,
            method: req.method,
            headers: { ...req.headers, host: 'backend:3000', 'content-length': body.length }
          },
          proxyRes => {
            const data = [];
            proxyRes.on('data', c => data.push(c));
            proxyRes.on('end', () => {
              res.writeHead(proxyRes.statusCode, proxyRes.headers);
              res.end(Buffer.concat(data));
            });
          }
        );
        proxyReq.end(body);
      });
    });
    server.listen(0, () => resolve(server));
  });
}

function call(port, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      {
        port,
        path,
        method,
        headers
      },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({ type: 'sqljs', autoSave: false, synchronize: true, entities: [UserEntity, TripEntity, BudgetEntity] }),
      UserModule, TripModule, CompanionModule, DiaryModule, BudgetModule
    ]
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(0);
  const backendPort = app.getHttpServer().address().port;

  const oldProxy = await startProxy(backendPort, true);  // 复刻修复前 nginx
  const newProxy = await startProxy(backendPort, false); // 复刻修复后 nginx
  const oldPort = oldProxy.address().port;
  const newPort = newProxy.address().port;

  // 准备两位用户（各为一个行程的发起者）与 token
  const ownerA = (await call(backendPort, 'POST', '/api/users/register', { email: 'a@trip.com', nickname: '阿甲', password: 'pass1234' })).body.id;
  const ownerB = (await call(backendPort, 'POST', '/api/users/register', { email: 'b@trip.com', nickname: '阿乙', password: 'pass1234' })).body.id;
  const tokenA = (await call(backendPort, 'POST', '/api/users/login', { email: 'a@trip.com', password: 'pass1234' })).body.token;
  const tokenB = (await call(backendPort, 'POST', '/api/users/login', { email: 'b@trip.com', password: 'pass1234' })).body.token;
  const tripA = (await call(backendPort, 'POST', '/api/trips', { ownerId: ownerA, destination: '大理', departDate: '2026-10-01', days: 5, transport: '公共交通', companionCount: 3 })).body.id;
  const tripB = (await call(backendPort, 'POST', '/api/trips', { ownerId: ownerB, destination: '青海湖', departDate: '2026-10-05', days: 7, transport: '自驾', companionCount: 2 })).body.id;
  // 种子数据直接打后端，带发起者 token
  await call(backendPort, 'POST', `/api/trips/${tripA}/budgets`, { category: 'transport', planned: 1000, spent: 800 }, tokenA);

  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`  ✔ ${name}`); }
    catch (e) { failures++; console.error(`  ✗ ${name}\n    ${e.message}`); }
  };

  console.log('— 复现缺陷：旧 nginx 规则（剥 /api 前缀）—');
  await check('旧规则 GET /api/trips（行程下拉）→ 404，页面看不到行程', async () => {
    const r = await call(oldPort, 'GET', '/api/trips');
    assert.strictEqual(r.status, 404);
  });
  await check('旧规则 GET /api/trips/:id/budgets（已有数据）→ 404', async () => {
    const r = await call(oldPort, 'GET', `/api/trips/${tripA}/budgets`);
    assert.strictEqual(r.status, 404);
  });
  await check('旧规则 POST 保存分类金额 → 404（保存失败）', async () => {
    const r = await call(oldPort, 'POST', `/api/trips/${tripA}/budgets`, { category: 'food', planned: 500, spent: 400 });
    assert.strictEqual(r.status, 404);
  });

  console.log('— 验证修复：新 nginx 规则（透传 /api）—');
  await check('新规则 GET /api/trips 返回行程列表', async () => {
    const r = await call(newPort, 'GET', '/api/trips');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.length, 2);
    assert.strictEqual(r.body[0].destination, '大理');
  });
  await check('新规则加载预算：能看到已录入的交通 1000/800 与汇总', async () => {
    const r = await call(newPort, 'GET', `/api/trips/${tripA}/budgets`);
    assert.strictEqual(r.status, 200);
    const row = r.body.categories.find(c => c.category === 'transport');
    assert.ok(row, '应包含已保存的交通分类');
    assert.strictEqual(row.planned, 1000);
    assert.strictEqual(row.spent, 800);
    assert.strictEqual(r.body.totalPlanned, 1000);
    assert.strictEqual(r.body.totalSpent, 800);
  });
  await check('新规则保存餐饮分类，返回更新后的分类与汇总', async () => {
    const r = await call(newPort, 'POST', `/api/trips/${tripA}/budgets`, { category: 'food', planned: 500, spent: 720.5 }, tokenA);
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.categories.find(c => c.category === 'food').overBudget, true);
    assert.strictEqual(r.body.totalSpent, 1520.5);
    assert.strictEqual(r.body.overBudget, true);
  });
  await check('新规则 PATCH 修改金额成功', async () => {
    const list = await call(newPort, 'GET', `/api/trips/${tripA}/budgets`);
    const id = list.body.categories.find(c => c.category === 'transport').id;
    const r = await call(newPort, 'PATCH', `/api/trips/${tripA}/budgets/${id}`, { spent: 1300 }, tokenA);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.categories.find(c => c.category === 'transport').spent, 1300);
  });

  console.log('— 经代理后的身份校验 —');
  await check('未登录写预算经代理被拒绝（401）', async () => {
    const r = await call(newPort, 'POST', `/api/trips/${tripA}/budgets`, { category: 'other', planned: 1, spent: 0 });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.code, 'AUTH_REQUIRED');
  });
  await check('非行程发起者写预算经代理被拒绝（403），且数据不变', async () => {
    const r = await call(newPort, 'POST', `/api/trips/${tripA}/budgets`, { category: 'other', planned: 1, spent: 0 }, tokenB);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'NOT_TRIP_OWNER');
    const after = await call(newPort, 'GET', `/api/trips/${tripA}/budgets`);
    assert.strictEqual(after.body.categories.find(c => c.category === 'other'), undefined);
  });

  console.log('— 经代理后原有校验仍生效 —');
  await check('发起者写入负数金额经代理仍被拒绝', async () => {
    const r = await call(newPort, 'POST', `/api/trips/${tripA}/budgets`, { category: 'other', planned: -1, spent: 0 }, tokenA);
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.code, 'NEGATIVE_AMOUNT');
  });

  console.log('— 经代理后不同行程隔离仍生效 —');
  await check('行程 B 看不到行程 A 的预算', async () => {
    const r = await call(newPort, 'GET', `/api/trips/${tripB}/budgets`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.categories.length, 0);
  });
  await check('行程 B 发起者无法改行程 A 的记录（404，数据不串改）', async () => {
    const listA = await call(newPort, 'GET', `/api/trips/${tripA}/budgets`);
    const id = listA.body.categories.find(c => c.category === 'transport').id;
    const r = await call(newPort, 'PATCH', `/api/trips/${tripB}/budgets/${id}`, { spent: 1 }, tokenB);
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.code, 'BUDGET_NOT_FOUND');
    const afterA = await call(newPort, 'GET', `/api/trips/${tripA}/budgets`);
    assert.strictEqual(afterA.body.categories.find(c => c.category === 'transport').spent, 1300);
  });
  await check('非 A 发起者走 A 路径改 A 记录被拒（403）', async () => {
    const listA = await call(newPort, 'GET', `/api/trips/${tripA}/budgets`);
    const id = listA.body.categories.find(c => c.category === 'transport').id;
    const r = await call(newPort, 'PATCH', `/api/trips/${tripA}/budgets/${id}`, { spent: 1 }, tokenB);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, 'NOT_TRIP_OWNER');
  });

  oldProxy.close();
  newProxy.close();
  await app.close();

  console.log('');
  if (failures) { console.error(`✗ ${failures} 项失败`); process.exit(1); }
  console.log('代理层验证全部通过 ✓（旧规则确认为 404 根因，新规则加载/保存/校验/隔离正常）');
}

main().catch(e => { console.error(e); process.exit(1); });
