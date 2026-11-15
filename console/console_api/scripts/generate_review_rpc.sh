#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
kitex -module alicerealm.com idl/commission_review.thrift
