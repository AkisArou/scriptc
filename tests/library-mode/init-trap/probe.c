/* A trap during init routes to the sink exactly once; the host survives
 * through its own longjmp frame below the entry. */
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>

extern void ki_init(void);
extern void ki_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);

static jmp_buf trap_jmp;
static int sink_calls = 0;
static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)addr;
  sink_calls++;
  printf("sink[%d]: %.*s", sink_calls, (int)len, (const char *)msg);
  longjmp(trap_jmp, 1);
}

int main(void) {
  ki_set_panic_sink(sink, NULL);
  if (setjmp(trap_jmp) == 0) {
    ki_init();
    printf("UNREACHABLE\n");
  } else {
    printf("survived init trap, sink_calls=%d\n", sink_calls);
  }
  return 0;
}
