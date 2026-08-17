#!/bin/sh
set -eu

ddb() { aws dynamodb --endpoint-url "$DYNAMODB_ENDPOINT" "$@"; }
sqs() { aws sqs --endpoint-url "$ELASTICMQ_ENDPOINT" "$@"; }
table_exists() { ddb describe-table --table-name "$1" >/dev/null 2>&1; }
queue_exists() { sqs get-queue-url --queue-name "$1" >/dev/null 2>&1; }
ttl_status() { ddb describe-time-to-live --table-name "$1" --query 'TimeToLiveDescription.TimeToLiveStatus' --output text 2>/dev/null || true; }
enable_ttl() {
  status=$(ttl_status "$1")
  if [ "$status" = "DISABLED" ] || [ "$status" = "None" ] || [ -z "$status" ]; then
    ddb update-time-to-live --table-name "$1" --time-to-live-specification 'Enabled=true,AttributeName=expiresAt' >/dev/null || true
  fi
}

if ! table_exists "$CORE_TABLE_NAME"; then
  ddb create-table --table-name "$CORE_TABLE_NAME" \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S AttributeName=GSI1PK,AttributeType=S AttributeName=GSI1SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --global-secondary-indexes '[{"IndexName":"GSI1","KeySchema":[{"AttributeName":"GSI1PK","KeyType":"HASH"},{"AttributeName":"GSI1SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"},"ProvisionedThroughput":{"ReadCapacityUnits":1,"WriteCapacityUnits":1}}]' \
    --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 >/dev/null
fi
enable_ttl "$CORE_TABLE_NAME"
if ! table_exists "$AUDIT_TABLE_NAME"; then
  ddb create-table --table-name "$AUDIT_TABLE_NAME" \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --provisioned-throughput ReadCapacityUnits=1,WriteCapacityUnits=1 >/dev/null
fi
enable_ttl "$AUDIT_TABLE_NAME"
for queue in "$ROUTING_QUEUE_NAME" "$ROUTING_DLQ_NAME" "$DELIVERY_QUEUE_NAME" "$DELIVERY_DLQ_NAME"; do
  if ! queue_exists "$queue"; then sqs create-queue --queue-name "$queue" >/dev/null; fi
done
echo "Bootstrap completed idempotently."
