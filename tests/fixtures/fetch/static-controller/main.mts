const controller = new AbortController();
const signal = controller.signal;
console.log(
  "controller initial:",
  signal.aborted,
  controller.signal === signal,
);

const reason = { value: 1 };
let eventCalls = 0;
signal.addEventListener("abort", (event) => {
  eventCalls++;
  console.log(
    "controller event:",
    event.type,
    event.target === signal,
    (signal.reason as { value: number }) === reason,
  );
});
controller.abort(reason);
controller.abort(new Error("ignored"));
const observedReason = signal.reason as { value: number };
observedReason.value = 2;
console.log(
  "controller final:",
  signal.aborted,
  eventCalls,
  observedReason === reason,
  reason.value,
);

const computedController = new AbortController();
const abortMember: "abort" = "abort";
computedController[abortMember]("computed reason");
console.log("computed abort:", computedController.signal.reason);

let surplusEffects = "";
function constructorSurplus(): number {
  surplusEffects += "ctor ";
  return 1;
}
function abortSurplus(): number {
  surplusEffects += "abort";
  return 2;
}
// @ts-expect-error JavaScript accepts and evaluates surplus constructor arguments.
const surplusController = new AbortController(constructorSurplus());
// @ts-expect-error JavaScript also evaluates surplus abort() arguments.
surplusController.abort(undefined, abortSurplus());
console.log("controller surplus:", surplusEffects);

const fetchController = new AbortController();
setTimeout(() => fetchController.abort(new Error("manual timeout")), 20);
try {
  await fetch(`${process.argv[2]}/slow`, {
    signal: fetchController.signal,
  });
  console.log("controller fetch unexpectedly resolved");
} catch (error) {
  const caught = error as Error;
  console.log("controller fetch:", caught.name, caught.message);
}
