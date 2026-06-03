'use strict';
// 後端 API 整合測試（node:test，無外部相依）
// 使用本地 SQLite 檔當測試 DB；以隨機埠啟動 app，跑完即清除。
const test = require('node:test');
const assert = require('node:assert');
// ── 測試環境設定（必須在 require server 之前）──
// 用記憶體資料庫，每次執行皆為全新狀態，避免檔案殘留污染
process.env.NODE_ENV = 'test';
process.env.TURSO_DATABASE_URL = ':memory:';
process.env.TURSO_AUTH_TOKEN = '';

const { app, initData } = require('../server');

let base = '';
let server = null;
let adminToken = '';

async function api(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch (_) { data = txt; }
  return { status: res.status, data };
}
const login = async (u, p) => (await api('POST', '/api/login', { body: { username: u, password: p } })).data.token;
const reportNames = async (token) => new Set(((await api('GET', '/api/reports?limit=0', { token })).data.data || []).map(r => r.display_name));

// 共用測試資料
let A, B; // 公司 id

test.before(async () => {
  await initData();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
  adminToken = await login('admin', 'admin123');
  assert.ok(adminToken, 'admin 應能登入');
});

test.after(() => {
  if (server) server.close();
});

test('健康檢查回 ok', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
});

test('未登入存取受保護端點 → 401', async () => {
  assert.equal((await api('GET', '/api/reports')).status, 401);
  assert.equal((await api('GET', '/api/users')).status, 401);
});

test('錯誤密碼無法登入', async () => {
  const r = await api('POST', '/api/login', { body: { username: 'admin', password: 'wrong' } });
  assert.notEqual(r.status, 200);
});

test('公司 CRUD 與防呆', async () => {
  assert.equal((await api('POST', '/api/companies', { token: adminToken, body: { name: 'TCompA' } })).status, 200);
  assert.equal((await api('POST', '/api/companies', { token: adminToken, body: { name: 'TCompB' } })).status, 200);
  assert.equal((await api('POST', '/api/companies', { token: adminToken, body: { name: 'TCompA' } })).status, 400, '重複名稱應 400');
  assert.equal((await api('POST', '/api/companies', { token: adminToken, body: { name: '   ' } })).status, 400, '空白名稱應 400');
  const comps = (await api('GET', '/api/companies', { token: adminToken })).data;
  A = comps.find(c => c.name === 'TCompA').id;
  B = comps.find(c => c.name === 'TCompB').id;
  assert.ok(A && B);
});

test('群組必須歸屬公司', async () => {
  assert.equal((await api('POST', '/api/groups', { token: adminToken, body: { name: 'GNoCompany' } })).status, 400, '未給公司應 400');
  assert.equal((await api('POST', '/api/groups', { token: adminToken, body: { name: 'GA', companyId: A } })).status, 200);
});

test('建立人員並指派公司/角色', async () => {
  for (const [u, n] of [['t_empA', '稽A'], ['t_empB', '稽B'], ['t_supA', '主A'], ['t_supB', '主B']]) {
    await api('POST', '/api/register', { body: { username: u, password: 'test1234', displayName: n } });
  }
  // 稽查員：所屬公司
  await api('PUT', '/api/users/t_empA/group', { token: adminToken, body: { companyId: A, isSupervisor: 0, supervisorCompanyIds: [] } });
  await api('PUT', '/api/users/t_empB/group', { token: adminToken, body: { companyId: B, isSupervisor: 0, supervisorCompanyIds: [] } });
  // 主管：管轄公司
  await api('PUT', '/api/users/t_supA/group', { token: adminToken, body: { companyId: A, isSupervisor: 1, supervisorCompanyIds: [A] } });
  await api('PUT', '/api/users/t_supB/group', { token: adminToken, body: { companyId: B, isSupervisor: 1, supervisorCompanyIds: [B] } });

  const users = (await api('GET', '/api/users', { token: adminToken })).data;
  const empA = users.find(u => u.user_id === 't_empA');
  assert.equal(empA.company_name, 'TCompA');
  const supA = users.find(u => u.user_id === 't_supA');
  assert.equal(supA.is_supervisor, 1);
  assert.ok((supA.supervisor_company_ids || []).includes(A));
});

test('提交回報', async () => {
  const tA = await login('t_empA', 'test1234');
  const tB = await login('t_empB', 'test1234');
  assert.equal((await api('POST', '/api/submit-report', { token: tA, body: { taskType: '到達', location: '台北A', task: '測試A', latitude: 25.03, longitude: 121.56 } })).status, 200);
  assert.equal((await api('POST', '/api/submit-report', { token: tB, body: { taskType: '到達', location: '高雄B', task: '測試B', latitude: 22.6, longitude: 120.3 } })).status, 200);
});

test('資料隔離：管理員看全部', async () => {
  const names = await reportNames(adminToken);
  assert.ok(names.has('稽A') && names.has('稽B'));
});

test('資料隔離：主管只看自己管轄公司', async () => {
  const nA = await reportNames(await login('t_supA', 'test1234'));
  assert.ok(nA.has('稽A'), '主A 應看到稽A');
  assert.ok(!nA.has('稽B'), '主A 不應看到稽B（跨公司隔離）');
  const nB = await reportNames(await login('t_supB', 'test1234'));
  assert.ok(nB.has('稽B') && !nB.has('稽A'));
});

test('資料隔離：稽查員只看自己', async () => {
  const n = await reportNames(await login('t_empA', 'test1234'));
  assert.ok(n.has('稽A') && !n.has('稽B'));
});

test('稽查員無法存取狀態板（403）', async () => {
  const t = await login('t_empA', 'test1234');
  assert.equal((await api('GET', '/api/status-board', { token: t })).status, 403);
});

test('回報篩選：未來日期區間回 0 筆；類型篩選有效', async () => {
  const future = (await api('GET', '/api/reports?startDate=2099-01-01&endDate=2099-12-31&limit=0', { token: adminToken })).data;
  assert.equal(future.total, 0);
  const arrive = (await api('GET', '/api/reports?taskType=' + encodeURIComponent('到達') + '&limit=0', { token: adminToken })).data;
  assert.ok((arrive.data || []).every(r => r.task_type === '到達'));
  assert.ok(Array.isArray(arrive.typeCounts) && Array.isArray(arrive.companyCounts), '應回傳小計');
});

test('刪除仍有人員的公司 → 400', async () => {
  assert.equal((await api('DELETE', '/api/companies/' + A, { token: adminToken })).status, 400);
});
