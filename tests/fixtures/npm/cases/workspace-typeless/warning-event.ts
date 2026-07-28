// A dynamic import reaches the ESM loader after the warning listener is
// installed. MODULE_TYPELESS_PACKAGE_JSON is both a stderr report and a
// real process 'warning' event under Node.
process.on(
  "warning",
  (warning: { code?: string; name: string; message: string }) => {
    console.log(`warning:${warning.code}:${warning.name}`);
  },
);

async function run(): Promise<void> {
  await import("wstypeless");
}

run();
