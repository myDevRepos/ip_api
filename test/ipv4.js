const IPv4CidrRange = require('ip-num/IPRange').IPv4CidrRange;

let range = IPv4CidrRange.fromCidr("1.2.3.4/22");

let start = range.getFirst().toString() // gives 2001:db8:0:0:0:0:0:0
let stop = range.getLast().toString() // gives 2001:db8:7fff:ffff:ffff:ffff:ffff:ffff

console.log(`${start} - ${stop}`);