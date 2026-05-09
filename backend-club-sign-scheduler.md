# 后端定时签到/签退任务学习总结

本文总结一个后端定时任务系统如何从“用户保存时间”走到“后端到点执行并记录结果”。内容以当前项目的 `server` 目录为例，重点讲清楚每一步负责什么、为什么这样设计、代码在哪里。

> 说明：本文用于学习后端定时任务、数据库持久化、任务日志、token 加密、接口转发等工程知识。真实账号的无人值守考勤提交涉及现实记录，生产使用时应遵守学校、平台和项目规则。

## 1. 总体流程

后端定时任务不是简单写一个 `setTimeout`。完整流程通常是：

```text
用户保存定时配置
  ↓
配置存到后端数据库
  ↓
后端 scheduler / cron 常驻运行
  ↓
到点后后端任务执行
  ↓
后端调用签到/签退逻辑或转发请求
  ↓
记录执行结果
```

在当前项目中，对应文件如下：

| 步骤 | 当前项目文件 |
| --- | --- |
| 启动后端服务和定时器 | `server/index.js` |
| 初始化 SQLite 数据库 | `server/db/initDb.js` |
| 保存、查询、删除定时配置 | `server/routes/clubSchedules.js` |
| 每分钟扫描任务 | `server/scheduler/clubSignCron.js` |
| 调用社团签到相关接口 | `server/lib/clubApi.js` |
| 加密保存用户 token | `server/lib/tokenVault.js` |

## 2. 前端定时和后端定时的区别

前端定时器运行在浏览器里：

```text
页面打开
  ↓
前端读取 localStorage
  ↓
window.setTimeout 到点触发
  ↓
前端调用签到接口
```

特点：

- 页面关闭后不会执行。
- 浏览器休眠、电脑睡眠、账号过期都会影响执行。
- 配置通常存在 `localStorage`，换浏览器或清缓存会丢。
- 适合提醒、倒计时、用户在场确认。

后端定时器运行在服务器里：

```text
后端服务启动
  ↓
定时配置存在数据库
  ↓
cron 每分钟扫描数据库
  ↓
到点后后端执行任务
  ↓
任务结果写入日志表
```

特点：

- 浏览器关闭后仍然可以运行。
- 配置不依赖用户当前页面。
- 可以记录执行日志。
- 可以用数据库约束防止重复执行。
- 更接近真正的“后端任务系统”。

## 3. 第一步：用户保存定时配置

用户在页面上设置：

```text
签到时间：08:58
签退时间：09:26
时区：Asia/Shanghai
是否启用：true
```

前端应该把配置发送到后端，而不是只保存在浏览器：

```http
POST /api/club-schedules
token: 用户登录 token
Content-Type: application/json

{
  "signInTime": "08:58",
  "signOutTime": "09:26",
  "timezone": "Asia/Shanghai",
  "enabled": true
}
```

当前项目中，保存配置的路由在 `server/routes/clubSchedules.js`：

```js
router.post('/', async (req, res) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ ok: false, message: '缺少 token 请求头' });

  const studentId = await fetchStudentIdFromToken(token);
  const signInTime = normalizeHHMM(req.body?.signInTime ?? req.body?.sign_in_time);
  const signOutTime = normalizeHHMM(req.body?.signOutTime ?? req.body?.sign_out_time);
  const timezone = String(req.body?.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';

  // 写入数据库
});
```

这里有几个关键点：

- 后端从请求头提取 `token`。
- 后端用 `token` 查询当前用户的 `studentId`。
- 不直接相信前端传来的 `studentId`。
- 对时间做标准化，保证格式是 `HH:mm`。

不要直接相信前端传来的 `studentId`，因为前端参数可以被篡改。更稳妥的方式是：前端只提交 token，后端根据 token 确认这个请求属于哪个用户。

## 4. 第二步：确认用户身份

当前项目通过 `fetchStudentIdFromToken(token)` 获取当前用户身份，代码在 `server/lib/clubApi.js`：

```js
async function fetchStudentIdFromToken(token) {
  const { data } = await apiRequest('GET', '/auth/query/token', { token });
  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || 'token 无效或已过期');
  }

  const sid = data.response?.studentId ?? data.response?.student_id;
  const n = Number(sid);
  if (!Number.isFinite(n) || n <= 0) throw new Error('query/token 未返回 studentId');
  return n;
}
```

这个函数做了三件事：

1. 调用 `/auth/query/token` 校验 token。
2. 从返回结果中取出 `studentId`。
3. 如果 token 失效或没有返回学生 ID，就拒绝保存配置。

这样可以避免用户伪造其他人的 `studentId`。

## 5. 第三步：配置存入数据库

后端任务必须有持久化存储。不能只把定时任务存在内存里，因为服务重启后内存会丢失。

当前项目使用 SQLite 文件持久化，通过 `sql.js`（纯 JavaScript，无需 Windows 下编译原生模块）加载/保存；数据库初始化在 `server/db/initDb.js`。亦可自行换成 `better-sqlite3` 等原生驱动。

### 5.1 定时配置表

```sql
CREATE TABLE IF NOT EXISTS club_sign_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL UNIQUE,
  token_enc TEXT NOT NULL,
  sign_in_time TEXT NOT NULL,
  sign_out_time TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `id` | 数据库内部主键 |
| `student_id` | 用户学生 ID |
| `token_enc` | 加密后的用户 token |
| `sign_in_time` | 签到时间，格式 `HH:mm` |
| `sign_out_time` | 签退时间，格式 `HH:mm` |
| `timezone` | 时区，默认 `Asia/Shanghai` |
| `enabled` | 是否启用，`1` 启用，`0` 停用 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

`student_id INTEGER NOT NULL UNIQUE` 表示一个学生只保留一条配置。重复保存时更新原来的配置。

### 5.2 执行日志表

```sql
CREATE TABLE IF NOT EXISTS club_sign_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  run_date TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  api_code INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (schedule_id) REFERENCES club_sign_schedules(id) ON DELETE CASCADE,
  UNIQUE (schedule_id, run_date, action)
);
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `schedule_id` | 对应哪条定时配置 |
| `run_date` | 执行日期，例如 `2026-05-08` |
| `action` | `sign_in` 或 `sign_out` |
| `status` | `running`、`ok`、`error` |
| `message` | 成功信息或错误原因 |
| `api_code` | 业务接口返回 code |
| `created_at` | 日志创建时间 |

最关键的是：

```sql
UNIQUE (schedule_id, run_date, action)
```

它保证同一个任务、同一天、同一个动作只能记录一次。这个约束可以用来防止重复执行。

## 6. 第四步：加密保存 token

后端要到点调用接口，就需要用户 token。token 不能明文存数据库里。

当前项目在 `server/lib/tokenVault.js` 中使用 AES-256-GCM 加密 token：

```js
function encryptToken(plainText) {
  const key = getKeyBuffer();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
```

解密时：

```js
function decryptToken(payloadB64) {
  const key = getKeyBuffer();
  const buf = Buffer.from(String(payloadB64), 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const enc = buf.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}
```

生产环境应该设置以下环境变量之一：

```text
SCHEDULER_ENCRYPTION_KEY
SCHEDULER_MASTER_PASSWORD
```

不要依赖开发环境内置弱密钥。内置弱密钥只适合本地学习。

## 7. 第五步：后端 cron 常驻运行

当前项目使用 `node-cron`。启动入口在 `server/index.js`：

```js
app.listen(port, () => {
  logger.info(`Server is running on http://localhost:${port}`);
  try {
    startClubSignCron(db, logger);
  } catch (e) {
    logger.error(`Scheduler failed to start: ${e.message}`);
  }
});
```

`startClubSignCron()` 在 `server/scheduler/clubSignCron.js`：

```js
const job = cron.schedule('* * * * *', () => {
  void (async () => {
    const schedules = db.prepare('SELECT * FROM club_sign_schedules WHERE enabled = 1').all();

    for (const row of schedules) {
      const tz = row.timezone || 'Asia/Shanghai';
      const now = DateTime.now().setZone(tz);
      const hm = now.toFormat('HH:mm');
      const today = now.toFormat('yyyy-MM-dd');

      const signInHm = normalizeHHMM(row.sign_in_time);
      const signOutHm = normalizeHHMM(row.sign_out_time);

      // 到点判断
    }
  })();
});
```

`* * * * *` 表示每分钟执行一次。

每分钟扫描数据库的好处：

- 服务重启后不用恢复大量内存定时器。
- 新增、修改、暂停任务后，下分钟自动生效。
- 所有配置都以数据库为准。
- 逻辑比为每个用户创建一个 `setTimeout` 更稳定。

## 8. 第六步：到点判断

到点判断逻辑：

```js
if (hm === signInHm) {
  await runOnce(db, logger, row, today, 'sign_in', '1', token);
}

if (hm === signOutHm) {
  await runOnce(db, logger, row, today, 'sign_out', '2', token);
}
```

这里的对应关系：

| 任务动作 | `action` | `signType` |
| --- | --- | --- |
| 签到 | `sign_in` | `'1'` |
| 签退 | `sign_out` | `'2'` |

注意：cron 是每分钟扫描，所以时间精度是分钟级。如果配置为 `08:58`，只会在当前时区时间等于 `08:58` 时触发。

## 9. 第七步：防止重复执行

当前项目用 `INSERT OR IGNORE` 加数据库唯一约束实现幂等。

代码在 `runOnce()`：

```js
const insert = db.prepare(
  `INSERT OR IGNORE INTO club_sign_runs (schedule_id, run_date, action, status, message, api_code)
   VALUES (?, ?, ?, 'running', '', NULL)`,
);

const info = insert.run(scheduleRow.id, runDate, action);
if (!info.changes) {
  return;
}
```

这段代码的含义：

1. 先尝试插入一条 `running` 日志。
2. 如果插入成功，说明今天这个动作还没执行过。
3. 如果插入失败或被忽略，说明已经有同一天同动作的记录，直接退出。

这比单纯用 JavaScript 变量判断更可靠，因为数据库约束在服务重启后仍然有效。

## 10. 第八步：执行前重新查询当前任务

后端执行签到/签退前，不能只依赖保存时的数据。活动 ID、坐标、签到状态都可能变化。

当前项目在 `server/lib/clubApi.js` 中先查询当前可用任务：

```js
async function fetchSignTask(token, studentId) {
  const params = { studentId };
  const { data } = await apiRequest('GET', '/clubactivity/getSignInTf', { token, params });

  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || '获取签到任务失败');
  }

  const r = data.response;
  if (!r || typeof r !== 'object') return null;

  const activityId = Number(r.activityId);
  if (!Number.isFinite(activityId) || activityId <= 0) return null;

  return {
    activityId,
    latitude: String(r.latitude || ''),
    longitude: String(r.longitude || ''),
    signInStatus: r.signInStatus ?? null,
    signBackStatus: r.signBackStatus ?? null,
  };
}
```

这样做的原因：

- 每天的活动可能不同。
- 活动坐标可能变化。
- 用户可能已经手动签到或签退。
- 到点时需要用最新状态判断能不能执行。

## 11. 第九步：调用签到/签退接口

当前项目的执行函数是 `signInOrSignBack(token, studentId, signType)`：

```js
async function signInOrSignBack(token, studentId, signType) {
  const task = await fetchSignTask(token, studentId);
  if (!task) {
    throw new Error('当前没有可用的签到任务');
  }
  if (!task.latitude || !task.longitude) {
    throw new Error('任务缺少经纬度，无法签到/签退');
  }

  // 状态校验

  const body = {
    activityId: task.activityId,
    latitude: task.latitude,
    longitude: task.longitude,
    signType: String(signType),
    studentId: Number(studentId),
  };

  const { data } = await apiRequest('POST', '/clubactivity/signInOrSignBack', { token, body });
  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || `接口返回失败 code=${data?.code}`);
  }
  return data;
}
```

执行前还会检查状态：

```js
if (signType === '1') {
  if (isSignedStatus(task.signInStatus) && isSignedStatus(task.signBackStatus)) {
    throw new Error('已完成签到与签退，跳过');
  }
  if (isSignedStatus(task.signInStatus)) {
    throw new Error('已签到，跳过重复签到');
  }
}

if (signType === '2') {
  if (!isSignedStatus(task.signInStatus)) {
    throw new Error('尚未签到，无法签退');
  }
  if (isSignedStatus(task.signBackStatus)) {
    throw new Error('已签退，跳过重复签退');
  }
}
```

这些校验用于避免：

- 重复签到。
- 尚未签到就签退。
- 已经签退后再次签退。
- 没有可用活动时仍然提交请求。

## 12. 第十步：记录执行结果

后端任务不能只执行，不记录。因为用户不一定看着页面，任务执行结果必须可追踪。

成功时：

```js
const data = await signInOrSignBack(token, scheduleRow.student_id, signType);
const msg = (data && (data.response?.message || data.msg || data.message)) || 'ok';

update.run(
  'ok',
  String(msg).slice(0, 500),
  Number(data?.code) || 10000,
  scheduleRow.id,
  runDate,
  action,
);
```

失败时：

```js
const msg = e.message || String(e);

update.run(
  'error',
  msg.slice(0, 500),
  null,
  scheduleRow.id,
  runDate,
  action,
);
```

日志表最终可以记录类似信息：

| schedule_id | run_date | action | status | message |
| --- | --- | --- | --- | --- |
| 1 | 2026-05-08 | sign_in | ok | 签到成功 |
| 1 | 2026-05-08 | sign_out | error | 尚未签到，无法签退 |

没有日志时，只能猜任务有没有跑。  
有日志时，可以明确知道：

- 到点是否触发。
- 任务是否开始执行。
- 接口是否成功。
- 失败原因是什么。
- 是否被防重复逻辑跳过。

## 13. 查询执行日志

当前项目提供了一个管理接口查询今日执行记录：

```http
GET /api/club-schedules/runs/today
X-Scheduler-Admin: 管理密钥
```

代码在 `server/routes/clubSchedules.js`：

```js
router.get('/runs/today', (req, res) => {
  const secret = process.env.SCHEDULER_ADMIN_SECRET;
  if (!secret || req.headers['x-scheduler-admin'] !== secret) {
    return res.status(403).json({ ok: false, message: 'Forbidden' });
  }

  const tz = String(req.query.tz || 'Asia/Shanghai');
  const today = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');

  // 查询 club_sign_runs
});
```

这个接口需要管理员密钥，因为执行日志可能包含用户相关信息，不应该公开。

也可以直接在项目根目录运行本地审计脚本读取 SQLite：

```powershell
node scripts\club-sign-log.mjs
node scripts\club-sign-log.mjs --date 2026-05-09
node scripts\club-sign-log.mjs --date 2026-05-09 --student-id 3640977
node scripts\club-sign-log.mjs --date 2026-05-09 --json
```

脚本会把每天的签到、签退分别归类：

| 来源 | 含义 |
| --- | --- |
| 后端自动完成 | `club_sign_runs.status = ok`，说明后端 cron 调用签到/签退接口成功 |
| 可能手动/外部已完成 | 后端 cron 到点触发过，但接口返回“已签到、重复提交”等信息，通常表示用户手动或其他入口已经完成 |
| 后端执行失败 | 后端 cron 触发过，但接口返回真正错误 |
| 未记录 | 后端没有写入该动作日志，通常表示服务当时未运行、配置未保存、错过触发窗口、或数据库不是同一份 |

## 14. 后端任务系统的关键设计点

### 14.1 数据库是事实来源

任务配置应保存在数据库里，而不是只保存在内存变量里。

原因：

- 服务重启后配置还在。
- 多个接口都能读取同一份配置。
- 可以查询、修改、暂停任务。
- 可以审计配置变化。

### 14.2 定时器只负责扫描和触发

cron 不应该保存复杂业务状态。它应该做：

```text
查数据库
  ↓
判断是否到点
  ↓
调用执行函数
```

业务校验、接口调用、日志更新应该拆到单独函数里。

### 14.3 用数据库约束做幂等

不要只相信“这个函数应该只执行一次”。实际系统里可能出现：

- cron 重复触发。
- 服务重启。
- 多个服务实例同时运行。
- 网络请求重试。
- 用户手动触发和定时触发重叠。

所以要用数据库唯一约束：

```sql
UNIQUE (schedule_id, run_date, action)
```

配合：

```sql
INSERT OR IGNORE
```

实现防重复执行。

### 14.4 先写 running，再调用外部接口

执行前先插入日志：

```text
insert running
  ↓
调用接口
  ↓
更新 ok / error
```

好处：

- 即使接口调用过程中服务崩溃，也能看到任务曾经开始执行。
- 可以区分“没触发”和“触发后卡住”。
- 方便后续做超时清理和重试策略。

### 14.5 token 必须加密保存

token 是敏感凭证。数据库泄露时，如果 token 明文保存，风险很高。

当前项目用 AES-256-GCM 加密，这是正确方向。生产环境必须设置独立密钥，不要使用代码里的开发默认值。

### 14.6 执行前重新查询业务状态

定时配置只保存“几点执行”。执行时需要重新查询：

- 当前活动 ID。
- 当前活动坐标。
- 当前签到状态。
- 当前签退状态。

这样可以减少过期数据造成的错误。

### 14.7 日志是后端任务的眼睛

后端任务执行时没有用户盯着页面，所以日志必须完整。

最少应记录：

- 哪个任务。
- 哪一天。
- 哪个动作。
- 执行状态。
- 接口返回 code。
- 错误信息。
- 创建时间。

## 15. 当前项目已有能力和不足

已有能力：

- 有 Express 后端服务。
- 有 SQLite 数据库。
- 有定时配置表。
- 有执行日志表。
- 有保存、查询、删除配置的路由。
- 有 token 加密保存。
- 有每分钟扫描的 cron。
- 有防重复执行机制。
- 有调用签到/签退接口的后端封装。
- 有今日执行日志查询接口。

主要不足：

- 当前任务系统依赖单个 Node 进程常驻运行。
- 如果部署到无常驻进程的平台，cron 可能不会可靠运行。
- token 过期后的刷新策略不完整。
- 没有重试队列。
- 没有任务失败通知。
- 没有可视化执行日志页面。
- 多实例部署时还需要更严格的分布式锁或数据库事务设计。
- 执行策略是否合规，需要按实际使用场景确认。

## 16. 本地学习时可以怎么验证

学习验证可以按以下顺序做：

1. 启动后端服务。
2. 调用 `POST /api/club-schedules` 保存一条测试配置。
3. 查看 SQLite 数据库里 `club_sign_schedules` 是否有记录。
4. 把签到或签退时间设置成当前时间下一分钟。
5. 观察后端日志是否触发 cron。
6. 查看 `club_sign_runs` 是否写入执行记录。
7. 用管理接口查询今日执行日志。

本地启动命令通常是：

```powershell
cd E:\byerun\server
npm install
node index.js
```

环境变量示例见 `server/.env.example`。前端开发可将定时配置同步到本机 server：`VITE_CLUB_SCHEDULER_BASE=http://127.0.0.1:8787`（默认端口以 `server/index.js` 为准），或启用 `VITE_CLUB_SCHEDULER_USE_DEV_PROXY=true` 并保证 Vite 已代理 `/api/club-schedules` 到该 server（见 `app/vite.config.js`）。

生产或长期运行时，不应该只靠手动打开终端。应使用进程管理器或部署平台保证后端服务常驻，例如：

- PM2
- systemd
- Docker Compose
- Windows 服务
- 支持常驻进程的服务器平台

## 17. 一句话总结

后端定时任务系统的核心不是“到点调用一个函数”，而是：

```text
配置持久化
+ 身份校验
+ token 安全
+ 定时扫描
+ 到点判断
+ 防重复执行
+ 业务调用
+ 执行日志
```

当前项目的 `server` 目录已经具备这套结构的主要骨架。理解这些模块之间的关系，比只记住某一段 `cron.schedule()` 代码更重要。
