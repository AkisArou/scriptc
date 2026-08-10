function run(values: string[]): void {
  let value = values[0];
  if (!value) return;

  const printLength = () => {
    {
      const value = "shadow";
      if (value.length === 0) return;
    }
    console.log(value.length);
  };

  value = values.slice(1)[0];
  printLength();
}

try {
  run(["first"]);
} catch (error) {
  console.log(error instanceof TypeError, (error as Error).message);
}

function capturedNarrow(values: string[]): () => string {
  let value = values[0];
  if (!value) return () => "fallback";
  return () => value;
}

console.log(capturedNarrow(["kept"])());
