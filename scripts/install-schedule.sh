#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TASKS_FILE="$PROJECT_DIR/data/scheduled-tasks.json"
NODE_BIN="$(which node)"
CRON_TAG="feishu-coding-agent-scheduler"

if [ ! -f "$TASKS_FILE" ]; then
  echo "错误: 未找到 $TASKS_FILE"
  echo "请先复制 data/scheduled-tasks.example.json 为 data/scheduled-tasks.json 并配置任务。"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "错误: 需要 jq 来解析 JSON，请先安装: brew install jq"
  exit 1
fi

ENABLED_TASKS=$(jq -r '.tasks[] | select(.enabled == true) | @json' "$TASKS_FILE")

if [ -z "$ENABLED_TASKS" ]; then
  echo "没有已启用的任务，跳过安装。"
  exit 0
fi

NEW_ENTRIES=""
while IFS= read -r task_json; do
  TASK_ID=$(echo "$task_json" | jq -r '.id')
  SCHEDULE=$(echo "$task_json" | jq -r '.schedule')
  DESC=$(echo "$task_json" | jq -r '.description // "无描述"')

  ENTRY="$SCHEDULE cd $PROJECT_DIR && $NODE_BIN src/scheduler.js --task $TASK_ID >> data/scheduler.log 2>&1"
  NEW_ENTRIES+="# [$CRON_TAG] $DESC\n$ENTRY\n"
done <<< "$ENABLED_TASKS"

EXISTING_CRON=$(crontab -l 2>/dev/null || true)
CLEANED_CRON=$(echo "$EXISTING_CRON" | grep -v "$CRON_TAG" | grep -v "src/scheduler.js" || true)

if [ "${1:-}" = "--uninstall" ]; then
  echo "$CLEANED_CRON" | crontab -
  echo "已移除所有 $CRON_TAG 相关的 cron 条目。"
  exit 0
fi

FINAL_CRON="$CLEANED_CRON"
if [ -n "$FINAL_CRON" ]; then
  FINAL_CRON+="\n"
fi
FINAL_CRON+="# --- $CRON_TAG begin ---\n"
FINAL_CRON+="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin\n"
FINAL_CRON+="$NEW_ENTRIES"
FINAL_CRON+="# --- $CRON_TAG end ---"

echo -e "$FINAL_CRON" | crontab -

echo "已安装以下 cron 任务:"
echo ""
echo "$ENABLED_TASKS" | while IFS= read -r task_json; do
  TASK_ID=$(echo "$task_json" | jq -r '.id')
  SCHEDULE=$(echo "$task_json" | jq -r '.schedule')
  DESC=$(echo "$task_json" | jq -r '.description // "无描述"')
  echo "  [$TASK_ID] $SCHEDULE  $DESC"
done
echo ""
echo "查看当前 crontab: crontab -l"
echo "卸载: bash $0 --uninstall"
