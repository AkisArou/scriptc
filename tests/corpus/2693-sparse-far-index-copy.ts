// Far indexed writes grow ordinary arrays and leave intermediate holes.
const numbers = [1];
numbers[4] = 5;
console.log(
  "numbers",
  numbers.length,
  0 in numbers,
  1 in numbers,
  3 in numbers,
  4 in numbers,
  numbers.join(","),
);

const words = ["a"];
words[3] = "d";
console.log("words", words.length, 1 in words, 2 in words, words.join("|"));

// A far write on an initially empty optional REF array gives each new hole
// the undefined arm as backing. Join skips the holes, while copying methods
// Get and densify them as present undefined values.
const optional: (number | undefined)[] = [];
optional[2] = 7;
console.log(
  "optional",
  optional.length,
  0 in optional,
  1 in optional,
  2 in optional,
  optional.join(","),
);
const reversed = optional.toReversed();
console.log(
  "copy",
  reversed.length,
  0 in reversed,
  1 in reversed,
  2 in reversed,
  reversed[0],
  reversed[1] === undefined,
  reversed[2] === undefined,
);

// Join must not read a hole even when its REF representation has no
// undefined arm and therefore leaves zero backing.
const mixed: (number | string)[] = [];
mixed[2] = "x";
console.log("mixed", mixed.join("|"));
