# Infrastructure DLQ

Symptoms: routing, delivery, or stream-failure DLQ count is non-zero.

Evidence: local ElasticMQ inspection and worker logs; hosted SQS DLQ alarm and CloudWatch logs. Safe actions: classify malformed versus transient records, repair the producer/configuration cause, then redrive only a bounded, observed batch. Unsafe: blind redrive, queue purge, or manual event-table changes.

Recovery verification: the redriven record has one durable outcome and DLQ count returns to zero. Exercise result: pending M12 deep-verification run.
