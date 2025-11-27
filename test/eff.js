function bigIntToIPv6Bin(bigIntStr) {
  let bigInt = BigInt(bigIntStr);
  const hex = bigInt.toString(16).padStart(32, '0'); // Convert to hex and pad to ensure 32 characters
  const bytes = new Uint8Array(16);

  for (let i = 0; i < 16; i++) {
    // Convert each pair of hex characters to a byte
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

// Example usage:
const startIpBigIntStr = "53192074765378217751211935087032532992";
const endIpBigIntStr = "53192074844606380265476272680576483327";

const startIpBin = bigIntToIPv6Bin(startIpBigIntStr);
const endIpBin = bigIntToIPv6Bin(endIpBigIntStr);

// startIpBin and endIpBin now contain the binary representation of the IPv6 addresses

console.log(startIpBin.length)
console.log(endIpBin.length)