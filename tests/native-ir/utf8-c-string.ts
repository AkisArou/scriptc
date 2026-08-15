import { cStringObserve } from "@native-typescript/scabi-c-v1-fixture";

cStringObserve("native");

try {
  cStringObserve("before\0after");
} catch {
  cStringObserve("done");
}
process.exit(11);
