FROM node:20-bookworm

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# The full application uses Chromium for the approved cMOOC automation flow.
RUN npx playwright install --with-deps chromium

# Prisma is needed at build time, but the database itself is created on the
# mounted /data volume when the container starts.
RUN npx prisma generate
ENV DATABASE_URL=file:/tmp/cmooc-build.db
RUN npm run build

RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
