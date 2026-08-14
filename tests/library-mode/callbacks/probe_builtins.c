/* CB6 builtin-name collision probe: neither channel is registered. If the
 * profile incorrectly claims lib.d.ts's isNaN binding, this call traps;
 * ordinary builtin lowering returns false/true and reaches both prints. */
#include <stdint.h>
#include <stdio.h>

extern void cbb_init(void);
extern uint8_t cbb_check_builtin(double x);

int main(void) {
  cbb_init();
  printf("finite: %u\n", (unsigned)cbb_check_builtin(123));
  printf("nan: %u\n", (unsigned)cbb_check_builtin(0.0 / 0.0));
  return 0;
}
