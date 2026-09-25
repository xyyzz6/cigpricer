FROM node:20-alpine

WORKDIR /app

# 同步后台（零依赖，纯 Node 内置模块，不需要 npm install）
COPY server/server.js /app/server.js

# 网页版前端（由 tools/build_app.py 生成的 ASCII 名副本）
COPY build/index.html /app/public/index.html

EXPOSE 8080

ENV PORT=8080
ENV DATA_DIR=/data
ENV SYNC_KEY=

VOLUME ["/data"]

CMD ["node", "server.js"]
