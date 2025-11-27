const IPv6 = require('ip-num/IPNumber').IPv6;
const bigInt = require("big-integer");

let ipv6 = new IPv6('2001:db8:0:0:0:0:0:0');
console.log(ipv6.value);
console.log(typeof ipv6.value);

b = bigInt('455345345435334');
console.log('b', typeof b.value)

let ipv6_int = IPv6.fromBigInt(bigInt('53200351810744245460824670217068085248'));
console.log(ipv6_int.toString());