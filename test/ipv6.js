const IPv6CidrRange = require('ip-num/IPRange').IPv6CidrRange;

// creating an IPv6 range from CIDR notation
let ipv6Range = IPv6CidrRange.fromCidr("2001:db8::/33");

// get first and last IPv6 number in the range
let start = ipv6Range.getFirst().toString() // gives 2001:db8:0:0:0:0:0:0
let stop = ipv6Range.getLast().toString() // gives 2001:db8:7fff:ffff:ffff:ffff:ffff:ffff

console.log(`${start} - ${stop}`);

console.log(start)

// getting number of IPv6 numbers in the range
ipv6Range.getSize() // Returns 39614081257132168796771975168

// splitting ranges
ipv6Range.split()[0].toCidrString() // returns 2001:db8:0:0:0:0:0:0/34
ipv6Range.split()[1].toCidrString() // returns 2001:db8:4000:0:0:0:0:0/34

let test = IPv6CidrRange.fromCidr('::/0');
console.log(test.toCidrString());

console.log(typeof test.value);