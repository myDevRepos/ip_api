#!/bin/bash

# Check if an IP address is provided as an argument
if [ -z "$1" ]; then
  echo "Usage: $0 IP_ADDRESS"
  exit 1
fi

# Use the first argument as the IP address for the iptables rules
iptables -I INPUT -s "$1" -p tcp --dport 80 -j DROP
iptables -I INPUT -s "$1" -p tcp --dport 443 -j DROP