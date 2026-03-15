FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y \
    python3 make g++ libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --include=optional
COPY src/ ./src/
COPY cli.js repl.js ./
COPY lib/ ./lib/

FROM node:20.19.1-bookworm-slim

RUN apt-get update && apt-get install -y \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m appuser
WORKDIR /app
RUN mkdir -p /data && chown appuser /data

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/cli.js ./
COPY --from=builder /app/repl.js ./
COPY --from=builder /app/lib ./lib

RUN chown -R appuser /app
USER appuser

ENV NODE_ENV=production
ENV SWARMFS_DATA_DIR=/data

ENTRYPOINT ["node", "cli.js"]
CMD ["--help"]