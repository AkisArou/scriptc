#include <stdbool.h>
#include <stddef.h>

typedef void (*HostedJobFn)(void *);
typedef struct {
  HostedJobFn run;
  void *job;
} HostedJob;

static HostedJob queue_[16];
static size_t head_;
static size_t tail_;

static bool enqueue(void *context, HostedJobFn run, void *job) {
  (void)context;
  if (tail_ == sizeof queue_ / sizeof queue_[0]) return false;
  queue_[tail_++] = (HostedJob){run, job};
  return true;
}

extern int ha_hosted_configure(bool (*enqueue_)(void *, HostedJobFn, void *),
                               void *context);
extern void ha_hosted_stop(void);
extern void ha_init(void);
extern double ha_start(void);
extern double ha_read(void);
extern double ha_start_hop(void);
extern double ha_start_branch(void);

static void drain(void) {
  while (head_ != tail_) {
    HostedJob next = queue_[head_++];
    next.run(next.job);
  }
}

int main(void) {
  if (ha_hosted_configure(&enqueue, NULL) != 0) return 10;
  ha_init();
  if (ha_start() != 0) return 11; /* async prefix stopped at await */
  drain();
  if (ha_read() != 42) return 12;
  if (ha_start_hop() != 0) return 13;
  if (ha_read() != 0) return 14; /* non-Promise await still yields */
  drain();
  if (ha_read() != 7) return 15;
  if (ha_start_branch() != 0) return 16;
  drain();
  if (ha_read() != 42) return 17;
  ha_hosted_stop();
  return 0;
}
