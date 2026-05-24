#!/usr/bin/env bash
# Poll once per hour; only emit at 18:00 local time.
# Cowork's monitor system runs this command; stdout lines become
# notifications that the day_dream skill picks up.
hour=$(date +%H)
if [ "$hour" = "18" ]; then
  echo "day_dream-trigger"
fi
