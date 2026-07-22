async function ok(): Promise<number> {
  return 1;
}
const top = await ok();
class Svc {
  async method(): Promise<void> {} // async methods lower now (static dispatch)
}
console.log(top);
export const marker: number = 1;

// Reached: collection defers its diagnostics until a reference makes
// them relevant; these references are what makes them count.
new Svc();
