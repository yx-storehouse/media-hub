#!/usr/bin/env bash
# 把当前代码部署到服务器上的 Docker：上传代码 → 备份数据库 → 重建并启动容器 → 等健康检查通过。
#
#   DEPLOY_HOST=root@服务器 DEPLOY_DIR=/服务器上的/reel 目录 bash scripts/deploy.sh
#
# 需要能用 SSH 密钥免密登录服务器，服务器上装好 Docker + Compose。
# 只上传纳入版本管理的文件（.gitignore 忽略的不传），不会碰服务器上的 data/ 和 media/。
set -euo pipefail

: "${DEPLOY_HOST:?请设置 DEPLOY_HOST，例如 root@192.168.1.10}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/reel}"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"
cd "$(dirname "$0")/.."

echo "→ 上传代码到 $DEPLOY_HOST:$DEPLOY_DIR"
ssh -o BatchMode=yes "$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR'"
git ls-files -co --exclude-standard -z | tar --null -T - -cf - | ssh -o BatchMode=yes "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && tar -xf -"

echo "→ 备份数据库、重建容器"
ssh -o BatchMode=yes "$DEPLOY_HOST" "cd '$DEPLOY_DIR' && sh -s" <<EOF
set -e
# 容器在跑就先备份（新版本启动时可能会迁移表结构）。
# 备份脚本用刚上传的这份喂给正在运行的容器执行，旧镜像里没有这个脚本也能备份
if [ -n "\$(docker ps -q -f name=^reel\$)" ]; then
  docker exec -i reel node --input-type=module - /data/backups $KEEP_BACKUPS < server/backup-db.mjs || { echo '备份失败，停止部署'; exit 1; }
fi
docker compose up -d --build
# 最多等 90 秒，直到健康检查通过
i=0
while [ \$i -lt 45 ]; do
  s=\$(docker inspect -f '{{.State.Health.Status}}' reel 2>/dev/null || echo none)
  [ "\$s" = healthy ] && { echo '容器状态：healthy'; docker logs --tail 4 reel; exit 0; }
  i=\$((i + 1)); sleep 2
done
echo "容器没有变成 healthy（当前：\$s），最近日志："
docker logs --tail 30 reel
exit 1
EOF
echo "✓ 部署完成"
