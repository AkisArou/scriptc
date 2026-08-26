let observed = 0;

export function start(): number {
  const captured = 39;
  async function settleOnHostedQueue(): Promise<number> {
    const value = (await Promise.resolve(1)) + (await Promise.resolve(2));
    observed = captured + value;
    return observed;
  }
  settleOnHostedQueue();
  return observed;
}

export function read(): number {
  return observed;
}

export function startHop(): number {
  observed = 0;
  async function settleAfterOneHop(): Promise<void> {
    await 0;
    observed = 7;
  }
  settleAfterOneHop();
  return observed;
}

export function startBranch(): number {
  observed = 0;
  const captured = 37;
  async function settleSelectedBranch(): Promise<void> {
    let value = 0;
    if (await Promise.resolve(true)) {
      value = await Promise.resolve(5);
    } else {
      value = 100;
    }
    observed = captured + value;
  }
  settleSelectedBranch();
  return observed;
}
