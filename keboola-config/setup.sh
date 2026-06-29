#!/bin/bash
set -Eeuo pipefail
cd /app
npm install
# Runtime dirs + Agent SDK deps for the spawned entrypoint child.
mkdir -p /opt/kai-agent /home/user/workspace/tool-results 2>/dev/null || true
cd /opt/kai-agent
npm init -y >/dev/null
npm install @anthropic-ai/claude-agent-sdk@0.3.159 @anthropic-ai/sdk@0.100.1 \
  @modelcontextprotocol/sdk@1.29.0 zod@4 \
  @opentelemetry/api @opentelemetry/api-logs @opentelemetry/context-async-hooks \
  @opentelemetry/exporter-logs-otlp-proto @opentelemetry/exporter-metrics-otlp-proto \
  @opentelemetry/exporter-trace-otlp-proto @opentelemetry/sdk-logs \
  @opentelemetry/sdk-metrics @opentelemetry/sdk-trace-base langsmith@0.5.18
