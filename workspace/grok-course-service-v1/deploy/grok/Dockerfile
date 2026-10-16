FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

RUN npx prisma generate

ENV CMOOC_SERVICE_HOST=127.0.0.1
ENV CMOOC_SERVICE_PORT=3050
ENV CMOOC_SERVICE_DATA_DIR=/data/cmooc-service-data
ENV DATABASE_URL=file:/data/cmooc-service-data/course.db
ENV CMOOC_PORTABLE_SERVICE=1
ENV LLM_MODE=mock

VOLUME ["/data/cmooc-service-data"]
CMD ["sh", "-c", "npm run service:setup && exec npm run service:start"]
