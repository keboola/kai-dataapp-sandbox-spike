#!/bin/bash
# Runs once before the app starts (python-js /app contract). Installs app deps AND the Kai
# Agent SDK runtime deps the spawned entrypoint needs. AI-3434 spike.
set -Eeuo pipefail

echo "[setup.sh] whoami=$(whoami) uid=$(id -u) gid=$(id -g) pwd=$(pwd)"

cd /app
npm install

# R8 (confirmed on canary): the base image runs setup.sh + the app as non-root `app` (uid 1000),
# and /opt + /home/user are root-owned and unwritable. The Kai entrypoint hardcodes its runtime
# dirs in @keboola/kai-agent-sandbox/config (SANDBOX_RUNTIME_DIR=/opt/kai-agent,
# WORKSPACE_DIR=/home/user/workspace), so a stock data app cannot use them as-is. For the spike we
# relocate to writable /tmp paths; the driver patches the uploaded config.js to match. The real
# follow-up is to make those dirs env-configurable in config.ts.
RUNTIME_DIR=/tmp/kai-agent
WORKSPACE_DIR=/tmp/kai-workspace
HOME_DIR=/tmp/kai-home
mkdir -p "$RUNTIME_DIR" "$WORKSPACE_DIR/tool-results" "$HOME_DIR"

cd "$RUNTIME_DIR"
npm init -y >/dev/null
npm install \
  @anthropic-ai/claude-agent-sdk@0.3.159 @anthropic-ai/sdk@0.100.1 \
  @modelcontextprotocol/sdk@1.29.0 zod@4 \
  @opentelemetry/api @opentelemetry/api-logs @opentelemetry/context-async-hooks \
  @opentelemetry/exporter-logs-otlp-proto @opentelemetry/exporter-metrics-otlp-proto \
  @opentelemetry/exporter-trace-otlp-proto @opentelemetry/sdk-logs \
  @opentelemetry/sdk-metrics @opentelemetry/sdk-trace-base langsmith@0.5.18

echo "[setup.sh] done (runtime deps in $RUNTIME_DIR)"
