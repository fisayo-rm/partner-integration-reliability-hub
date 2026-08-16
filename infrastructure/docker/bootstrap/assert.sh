#!/bin/sh
set -eu
ddb() { aws dynamodb --endpoint-url "$DYNAMODB_ENDPOINT" "$@"; }
sqs() { aws sqs --endpoint-url "$ELASTICMQ_ENDPOINT" "$@"; }
tables=$(ddb list-tables --query 'length(TableNames)' --output text)
queues=$(sqs list-queues --query 'length(QueueUrls)' --output text)
[ "$tables" = "2" ] && [ "$queues" = "4" ]
echo "Bootstrap resources stable: $tables tables, $queues queues."
