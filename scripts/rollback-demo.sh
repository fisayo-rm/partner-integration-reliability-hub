#!/usr/bin/env sh
set -eu
version="$1"
artifact="$2"
: "${ROLLBACK_FUNCTION_NAME:?ROLLBACK_FUNCTION_NAME is required}"
: "${ROLLBACK_ALIAS_NAME:=live}"
aws lambda update-alias --function-name "$ROLLBACK_FUNCTION_NAME" --name "$ROLLBACK_ALIAS_NAME" --function-version "$version" >/dev/null
test -f "$artifact"
pnpm wrangler pages deploy "$artifact" --project-name "${CLOUDFLARE_PAGES_PROJECT:?CLOUDFLARE_PAGES_PROJECT is required}" --branch main
printf '%s\n' "Rollback completed without changing DynamoDB history."
