#!/usr/bin/env bash
# LocalStack ready.d hook: the evidence bucket. Object Lock needs versioning and must be enabled at
# creation time, exactly as in AWS. The legacy table and its export bucket are created by the seed
# and export jobs, the way they already exist in a real account.
set -euo pipefail
awslocal s3api create-bucket --bucket evidence --object-lock-enabled-for-bucket >/dev/null
awslocal s3api put-object-lock-configuration --bucket evidence \
  --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":1}}}'
echo "evidence bucket ready (object lock: GOVERNANCE, 1 day)"
