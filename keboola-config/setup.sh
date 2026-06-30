#!/bin/bash
# Runs once before the app starts (python-js /app contract). Installs app deps AND the Kai
# Agent SDK runtime deps the spawned entrypoint needs, and creates the entrypoint's hardcoded
# runtime dirs. AI-3434 spike.
set -Eeuo pipefail

echo "[setup.sh] whoami=$(whoami) uid=$(id -u) gid=$(id -g) pwd=$(pwd)"

cd /app
npm install

# R8: the Kai entrypoint hardcodes SANDBOX_RUNTIME_DIR=/opt/kai-agent and
# WORKSPACE_DIR=/home/user/workspace (from @keboola/kai-agent-sandbox/config). These must exist
# and be writable by whatever user the app process runs as. /opt is root-owned on a stock image,
# so creating it requires setup.sh to run privileged. Fail LOUD (no `|| true`) so a permission
# failure shows up as a clear deploy error instead of a silent mystery.
if ! mkdir -p /opt/kai-agent /home/user/workspace/tool-results; then
  echo "[setup.sh] FATAL (R8): cannot create /opt/kai-agent or /home/user/workspace as $(whoami)." >&2
  echo "[setup.sh] -> setup.sh is not privileged on this base image; runtime dirs need a config.ts path change or bootstrap hook." >&2
  exit 1
fi
# chmod broadly so the app process (possibly a different uid than setup.sh) can write at runtime.
chmod -R 777 /opt/kai-agent /home/user/workspace || echo "[setup.sh] WARN: chmod failed (continuing)"

cd /opt/kai-agent
npm init -y >/dev/null
npm install \
  @anthropic-ai/claude-agent-sdk@0.3.159 @anthropic-ai/sdk@0.100.1 \
  @modelcontextprotocol/sdk@1.29.0 zod@4 \
  @opentelemetry/api @opentelemetry/api-logs @opentelemetry/context-async-hooks \
  @opentelemetry/exporter-logs-otlp-proto @opentelemetry/exporter-metrics-otlp-proto \
  @opentelemetry/exporter-trace-otlp-proto @opentelemetry/sdk-logs \
  @opentelemetry/sdk-metrics @opentelemetry/sdk-trace-base langsmith@0.5.18

echo "[setup.sh] done"
