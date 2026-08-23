class BaseCounter {
  protected value = 0;

  constructor(seed: number) {
    this.value = seed;
  }

  step(delta: number): number {
    this.value = this.value + delta;
    return this.value;
  }
}

class Counter extends BaseCounter {
  private bonus = 1;

  override step(delta: number): number {
    return super.step(delta + 1) + this.bonus;
  }
}

class IntegerState {
  private value = 7;

  step(): number {
    this.value = ((this.value << 5) ^ (this.value >>> 2) ^ 17) & 1023;
    return this.value;
  }
}

export function classFields(): number {
  const counter: BaseCounter = new Counter(39);
  return counter.step(1);
}

export function integerFieldBitwise(): number {
  return new IntegerState().step();
}
