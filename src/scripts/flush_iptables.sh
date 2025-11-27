#!/bin/bash

# Flush existing iptables rules to start with a clean slate
iptables -F

# Set default policies to drop all incoming and forward traffic
iptables -P INPUT DROP
iptables -P FORWARD DROP

# Allow all outgoing connections
iptables -P OUTPUT ACCEPT

# Allow incoming traffic on port 80 (HTTP), 443 (HTTPS), 22 (SSH), 7630 (Web Socket Latency Server), and TCP 22379 (Uncommon Port Server) and 3389
iptables -A INPUT -p tcp --dport 80 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -j ACCEPT
iptables -A INPUT -p tcp --dport 7630 -j ACCEPT
iptables -A INPUT -p udp --dport 7630 -j ACCEPT
iptables -A INPUT -p tcp --dport 22379 -j ACCEPT
iptables -A INPUT -p tcp --dport 3389 -j ACCEPT
iptables -A INPUT -p udp --dport 3389 -j ACCEPT

# Allow loopback access
iptables -A INPUT -i lo -j ACCEPT

# Allow established and related incoming connections
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Save the rules to make them persistent across reboots
if [ -d "/etc/iptables" ]; then
    iptables-save > /etc/iptables/rules.v4 || echo "Failed to save iptables rules"
else
    echo "Directory /etc/iptables does not exist, rules not saved"
    mkdir -p /etc/iptables 2>/dev/null && iptables-save > /etc/iptables/rules.v4 || echo "Failed to create directory and save rules"
fi