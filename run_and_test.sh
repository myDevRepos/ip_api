#!/bin/bash

# This script installs all `ipapi.is` dependencies
# and runs the functional tests.

npm install --production

node src/update_database.js

node src/functional_tests.js func ./config/test-config-cu.json