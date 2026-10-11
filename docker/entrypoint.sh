#!/bin/sh
# 容器启动脚本：数据卷里还没有数据库时先建库（含示例数据），然后启动接口服务。
set -e

if [ ! -f "$DB_PATH" ]; then
  echo "首次启动：初始化数据库 $DB_PATH"
  node server/db/seed.mjs
  echo "还没有管理员账号，可以运行：docker compose exec reel node server/create-admin.mjs <登录名> <密码>"
fi

exec node server/index.mjs
