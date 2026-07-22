// The regex slice fences. test() on a g/y-flagged literal is the
// statefulness fence (lastIndex is not modeled); named capture groups and
// the d/v flags are outside the slice; method-as-value has no value form;
// regexes stay out of arrays and union arms.
const g = /ab/g.test("abab");
const y = /ab/y.test("abab");
const named = /(?<year>\d{4})-(?<month>\d{2})/;
const indices = /cat/d;
const sets = /[\p{L}]/v;
const asValue = /x/.test;
const list: RegExp[] = [/a/, /b/];
const maybe: RegExp | undefined = /a/;
