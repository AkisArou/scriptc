/* K5/K6/K7 probe, mode-selected by argv[1]:
 *   trap        — the sink receives the range trap's message + a fault
 *                 address exactly once; the process survives (the sink
 *                 longjmps to a host frame BELOW the entry — the
 *                 conforming pattern; returning from the sink would abort)
 *   throw       — an escaped exception reaches the sink as "Uncaught ..."
 *   poisoned    — after a trap, any further entry aborts deterministically
 *   preregister — a trap before sink registration aborts
 */
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern void kp_init(void);
extern void kp_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern double kp_boom(double i);
extern double kp_fail(const uint8_t *p, size_t len);
extern double kp_ok(double x);

static jmp_buf trap_jmp;
static int sink_calls = 0;
static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx;
  sink_calls++;
  printf("sink[%d]: %.*s", sink_calls, (int)len, (const char *)msg);
  printf("addr: %s\n", addr != 0 ? "nonzero" : "zero");
  longjmp(trap_jmp, 1);
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "trap";

  if (strcmp(mode, "preregister") == 0) {
    /* No sink registered: the trap must abort (K6). Nothing after the
     * call may print. */
    kp_init();
    kp_boom(50);
    printf("UNREACHABLE\n");
    return 0;
  }

  kp_set_panic_sink(sink, NULL);
  kp_init();

  if (strcmp(mode, "trap") == 0) {
    if (setjmp(trap_jmp) == 0) {
      kp_boom(9);
      printf("UNREACHABLE\n");
    } else {
      printf("survived, sink_calls=%d\n", sink_calls);
    }
    return 0;
  }

  if (strcmp(mode, "throw") == 0) {
    if (setjmp(trap_jmp) == 0) {
      kp_fail((const uint8_t *)"kaput", 5);
      printf("UNREACHABLE\n");
    } else {
      printf("survived, sink_calls=%d\n", sink_calls);
    }
    return 0;
  }

  if (strcmp(mode, "poisoned") == 0) {
    if (setjmp(trap_jmp) == 0) {
      kp_boom(9);
    } else {
      printf("poisoned now\n");
      fflush(stdout);
      kp_ok(1); /* must abort — the library is poisoned */
      printf("UNREACHABLE\n");
    }
    return 0;
  }

  fprintf(stderr, "unknown mode %s\n", mode);
  return 2;
}
