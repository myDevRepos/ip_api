const { IPv6 } = require('ip-num');
const { collapseIPv6Number } = require('ip-num/IPv6Utils');

function ilog2_bs(value) {
  let result = 0n, i, v;
  for (i = 1n; value >> (1n << i); i <<= 1n);
  while (value > 1n) {
    v = 1n << --i;
    if (value >> v) {
      result += v;
      value >>= v;
    }
  }
  return result;
}

function isPowerOf2BigInt(n) {
  return n > 0n && (n & (n - 1n)) === 0n;
}

function getCidrFromInet6num(startIpStr, endIpStr) {
  const startIp = IPv6.fromString(startIpStr);
  const endIp = IPv6.fromString(endIpStr);

  const startBigInt = startIp.getValue();
  const endBigInt = endIp.getValue();

  const delta = endBigInt - startBigInt + BigInt(1);
  const isPowerOfTwo = isPowerOf2BigInt(delta);

  if (isPowerOfTwo) {
    const log2 = ilog2_bs(delta);
    const netmask = 128n - log2;
    const ipStr = collapseIPv6Number(startIp.toString());
    return `${ipStr}/${netmask}`;
  }

  return null;
}

// Example usage
const startIp = "2a0e:88c0:0000:0000:0000:0000:0000:0000";
const endIp = "2a0e:88c7:ffff:ffff:ffff:ffff:ffff:ffff";
console.log(getCidrFromInet6num(startIp, endIp));
