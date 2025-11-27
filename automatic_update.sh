#!/bin/bash

# This script automatically detects whether a database update is needed,
# then downloads the database and restarts the API service.

isUpdateNeeded=$(node src/update_database.js isUpdateNeeded);

if [ "$isUpdateNeeded" == "true" ]; then
  echo "ipapi.is database needs to be updated and the API restarted";
  
  # First download the most recent version of the database
  node src/update_database.js maybeUpdate;

  # Now since the database is actually updated, ask the API to reload itself
  # Only reload if the API is actually running

  # Whenver the API starts, it will write a `ipapi.run` file with it's current endpoint to the ip_api base directory.
  # Use this endpoint from the `ipapi.run` file to restart the API
  if [ -e ipapi.run ]; then
      echo "Asking the API to reload";
      endpoint=$(cat ipapi.run);
      curl "$endpoint/restartApi?key=rd8730s9Yshdxv";
  else
      echo "ipapi.run file does not exist. API is not running.";
  fi

else
  echo "ipapi.is API is up to date. No action needed.";
fi