#!/usr/bin/env bash

set -Eeuo pipefail
[ "$(cat "${FAKE_LIFECYCLE_STATE:?}/running")" = 1 ]
