#!/bin/sh
set -eu
ddb() { aws dynamodb --endpoint-url "$DYNAMODB_ENDPOINT" "$@"; }
sqs() { aws sqs --endpoint-url "$ELASTICMQ_ENDPOINT" "$@"; }
ddb describe-table --table-name "$CORE_TABLE_NAME" >/dev/null
ddb describe-table --table-name "$AUDIT_TABLE_NAME" >/dev/null
sqs get-queue-url --queue-name "$ROUTING_QUEUE_NAME" >/dev/null
sqs get-queue-url --queue-name "$ROUTING_DLQ_NAME" >/dev/null
sqs get-queue-url --queue-name "$DELIVERY_QUEUE_NAME" >/dev/null
sqs get-queue-url --queue-name "$DELIVERY_DLQ_NAME" >/dev/null
core_ttl=$(ddb describe-time-to-live --table-name "$CORE_TABLE_NAME" --query 'TimeToLiveDescription.AttributeName' --output text 2>/dev/null || true)
audit_ttl=$(ddb describe-time-to-live --table-name "$AUDIT_TABLE_NAME" --query 'TimeToLiveDescription.AttributeName' --output text 2>/dev/null || true)
[ "$core_ttl" = "expiresAt" ] && [ "$audit_ttl" = "expiresAt" ]
echo "Bootstrap resources stable for $CORE_TABLE_NAME and $AUDIT_TABLE_NAME."
