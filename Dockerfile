# Reel 容器镜像：手机端 + 管理后台 + 接口服务，一个容器一个端口。
#
#   docker compose up -d --build        # 用同目录的 docker-compose.yml（推荐）
#
# 数据都在两个卷里：/data（数据库 reel.db）、/media（视频、封面等素材），重建镜像不会丢。

# ---- 第一阶段：打包前端（只有这一步需要 npm 依赖） ----
FROM node:24-alpine AS build
WORKDIR /src
# 国内网络慢时可以换源：docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN npm ci --registry="$NPM_REGISTRY" --no-audit --no-fund
COPY index.html admin.html vite.config.js ./
COPY public ./public
COPY src ./src
# 线上只用真实接口：接口连不上时页面报错重试，永远不悄悄换成演示数据
# （.dockerignore 不带 .env.* 文件进镜像，所以在这里设；和仓库里的 .env.production 一致）
ENV VITE_API_MODE=http
RUN npm run build

# ---- 第二阶段：运行（接口服务零依赖，只要 Node 本身） ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/reel.db \
    MEDIA_DIR=/media \
    TZ=Asia/Shanghai \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY server ./server
COPY --from=build /src/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/reel-entrypoint
# 拷进来的文件会带上构建目录的权限（NAS 上常见 ACL 收紧到别人不可读），统一放开读权限，免得普通用户读不到代码
RUN chmod -R a+rX /app \
 && chmod 755 /usr/local/bin/reel-entrypoint \
 && mkdir -p /data /media \
 && chown node:node /data /media
# 以普通用户（uid 1000）运行；挂载的宿主机目录要让 uid 1000 可写
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["reel-entrypoint"]
