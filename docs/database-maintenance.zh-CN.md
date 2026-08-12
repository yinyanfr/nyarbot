# 数据库迁移与备份维护

生产环境使用单个 SQLite 数据库，默认是 `data/nyarbot.sqlite`。`src/services/database.ts` 负责连接和 schema，`src/services/persistence.ts` 负责持久化操作。生产环境既不初始化 `firebase-admin`，也不挂载 Firebase 凭据。

## 一次性 Firestore 切换

本流程用于已经实现的 Firestore 到统一 SQLite 切换，不是日常启动步骤。独立工具读取 Firestore 和旧词云 SQLite，先生成 staging 数据库，完成校验后才发布到指定输出路径。

### 准备

1. 确认待切换部署仍使用 Firestore 和 `data/wordcloud.sqlite`，并分别创建服务端/原生备份。
2. 将仅供维护使用的 Firebase 服务账号放在 `src/services/serviceAccountKey.json`。不要把它加入生产镜像、Compose 挂载或版本控制。
3. 迁移前停止所有 bot 实例，确保最终导出期间 Firestore 和旧词云数据库都没有新写入。
4. 确认以下目标不存在：`data/nyarbot.sqlite`、`data/nyarbot.sqlite.migration-report.json` 和 `data/nyarbot.sqlite.unknown-collections/`。工具会主动拒绝覆盖。

### 执行

从仓库根目录执行以下精确命令：

```bash
cd tools/firestore-to-sqlite
npm ci
npm run migrate -- \
  --service-account ../../src/services/serviceAccountKey.json \
  --wordcloud-db ../../data/wordcloud.sqlite \
  --output ../../data/nyarbot.sqlite \
  --timezone Asia/Shanghai
```

路径从 `tools/firestore-to-sqlite` 解析，Firestore 项目由服务账号的 project ID 选择，四个参数都必填。

### 校验与预发布

1. 要求退出码为 0，且 `data/nyarbot.sqlite.migration-report.json` 中的 `status` 为 `"success"`。
2. 检查报告中的每一项。工具会验证源/目标行数、Firestore ID 与 canonical JSON 的 SHA-256、`PRAGMA integrity_check`、`PRAGMA foreign_key_check`、schema version、ID、JSON、日期、时间戳/cursor 顺序和布尔值域。
3. 如果存在 `data/nyarbot.sqlite.unknown-collections/`，逐项审核。以 `_backup` 结尾的集合会被有意忽略，其他未知顶层集合会归档为 JSON。
4. 保持生产停止，将 `DATABASE_PATH` 指向 `data/nyarbot.sqlite` 的副本做 staging smoke test。验证启动、`/status`、代表性用户记忆、日记历史、runtime 上下文和 `/wordcloud` 预览；不要让 staging 与生产同时轮询同一个 bot token。
5. 设置生产 `DATABASE_PATH=data/nyarbot.sqlite`，并配置至少 20 字符的唯一 `DATABASE_BACKUP_PASSPHRASE`，然后部署/启动 SQLite 版本。生产不需要 Firebase 凭据挂载。
6. 验证启动日志、`/status`、普通消息持久化和下一次计划备份。在回滚窗口结束前保留 Firestore 项目、旧数据库、迁移报告和未知集合归档。

### 失败与回滚

发布前迁移失败时，工具会删除随机 staging 数据库，不会留下 `data/nyarbot.sqlite`。检查失败报告，将报告/归档移走，修正源数据或配置后重跑。绝不能让生产使用失败或未审核完整的输出。

如果切换后的检查失败，立即停止 SQLite 部署，保留失败候选库和日志，并让未修改的旧版本重新连接 Firestore 与 `data/wordcloud.sqlite`。不要同时运行新旧版本。查明原因后，保持停止写入，并使用新的目标路径完整重做迁移再切换。

验收完成后，撤销/删除迁移服务账号密钥并移除本地 JSON。Firebase 只保留为历史数据源，不再是生产依赖。

## 每日加密备份

Bot 默认每天在 `APP_TIMEZONE` 的 `DATABASE_BACKUP_SCHEDULE=03:30` 创建在线 SQLite 快照，使用 `DATABASE_BACKUP_PASSPHRASE` 压缩加密，保存到 `DATABASE_BACKUP_PATH=data/backups`，并作为 Telegram 文件发送给 `TG_ADMIN_UID`。归档名为 `nyarbot-<UTC timestamp>.sqlite.gz.enc`，本地保留最新七份。口令必须与本地和 Telegram 归档分开保管。

如果快照、加密、大小检查或 Telegram 发送失败，本次不会标记完成；系统会尽可能向管理员私聊报告，并在 15 分钟后重试。Telegram 文件上限为 50 MB。

## 恢复

替换数据库前停止所有 bot 实例。先恢复到 staging 路径；以下命令会解密归档，并检查 SQLite 完整性、外键、schema version、表定义和必需表：

```bash
npm run backup:restore -- \
  data/backups/nyarbot-YYYYMMDDTHHMMSSZ.sqlite.gz.enc \
  data/nyarbot.restore.sqlite \
  --require-table users
```

命令从 `.env` 读取 `DATABASE_BACKUP_PASSPHRASE`，默认拒绝覆盖输出；只有显式添加 `--force` 才会覆盖。成功后：

1. 将当前 `data/nyarbot.sqlite` 另存为独立的事故备份文件。
2. 在 bot 仍停止时，将 `data/nyarbot.restore.sqlite` 移到 `data/nyarbot.sqlite`。
3. 启动 bot，验证启动、`/status`、代表性记录和新写入。
4. 如果校验或 smoke check 失败，停止 bot，并将恢复前保留的数据库放回原位。
