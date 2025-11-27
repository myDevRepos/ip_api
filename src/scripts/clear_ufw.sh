#!/bin/bash

sudo ufw disable
sudo apt-get remove --purge ufw
sudo apt-get autoremove

# Set the default policies to ACCEPT
sudo iptables -P INPUT ACCEPT
sudo iptables -P FORWARD ACCEPT
sudo iptables -P OUTPUT ACCEPT

# Flush all iptables rules
sudo iptables -F

# Delete all custom chains
sudo iptables -X

# Flush all nat and mangle table rules
sudo iptables -t nat -F
sudo iptables -t mangle -F

sudo apt-get install iptables-persistent

sudo netfilter-persistent save
