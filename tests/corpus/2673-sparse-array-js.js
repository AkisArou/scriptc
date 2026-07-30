function build(length) {
  var result = Array(length);
  for (var i = 0; i < length; i++) result[i] = i * 2;
  return result;
}

const packed = build(4);
console.log(packed.length, packed.join(","), Object.keys(packed).join(","));
