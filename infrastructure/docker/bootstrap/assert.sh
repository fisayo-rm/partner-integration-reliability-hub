#!/bin/sh
set -eu
ddb() { aws dynamodb --endpoint-url "$DYNAMODB_ENDPOINT" "$@"; }
sqs() { aws sqs --endpoint-url "$ELASTICMQ_ENDPOINT" "$@"; }
tables=$(ddb list-tables --query 'length(TableNames)' --output text)
queues=$(sqs list-queues --query 'length(QueueUrls)' --output text)
[ "$tables" = "2" ] && [ "$queues" = "4" ]
core_ttl=$(ddb describe-time-to-live --table-name "$CORE_TABLE_NAME" --query 'TimeToLiveDescription.AttributeName' --output text 2>/dev/null || true)
audit_ttl=$(ddb describe-time-to-live --table-name "$AUDIT_TABLE_NAME" --query 'TimeToLiveDescription.AttributeName' --output text 2>/dev/null || true)
[ "$core_ttl" = "expiresAt" ] && [ "$audit_ttl" = "expiresAt" ]
echo "Bootstrap resources stable: $tables tables, $queues queues."
