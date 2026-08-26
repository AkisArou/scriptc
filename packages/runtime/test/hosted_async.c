/* Hosted PromiseCore contract: heap continuations use one embedder-owned
 * FIFO, settled awaits still hop, and realm shutdown drops both pending and
 * already-enqueued work without resuming it. Run under ASan + RC audit. */
#include "../src/scr_runtime.h"

#include <assert.h>
#include <stdlib.h>

typedef struct TestFrame {
  size_t rc;
  char mark;
  ScrPromise *owned_promise;
} TestFrame;

static int frames_live;
static int frames_resumed;
static int frames_dropped;
static char order[32];
static size_t order_len;

static void frame_trace(void *opaque, ScrTraceVisit visit, void *context) {
  TestFrame *frame = (TestFrame *)opaque;
  if (frame->owned_promise != NULL) visit(frame->owned_promise, context);
}

static void frame_gcfree(void *opaque) {
  /* owned_promise is traced, so trial deletion already removed this edge. */
  frames_live--;
  frames_dropped++;
  scr_cyc_free(opaque);
}

static TestFrame *frame_new(char mark, ScrPromise *owned_promise) {
  TestFrame *frame = scr_cyc_alloc(sizeof *frame, &frame_trace, &frame_gcfree);
  frame->rc = 1;
  frame->mark = mark;
  frame->owned_promise = scr_promise_retain(owned_promise);
  frames_live++;
  return frame;
}

static void frame_release(void *opaque) {
  TestFrame *frame = (TestFrame *)opaque;
  if (--frame->rc != 0) {
    scr_cyc_on_release(frame);
    return;
  }
  scr_cyc_on_dead(frame);
  ScrPromise *owned = frame->owned_promise;
  frame->owned_promise = NULL;
  scr_promise_release(owned);
  frames_live--;
  frames_dropped++;
  scr_cyc_free(frame);
}

typedef struct TestJob {
  ScrHostedJobFn run;
  void *job;
} TestJob;

typedef struct TestQueue {
  TestJob jobs[32];
  size_t head;
  size_t length;
  bool refuse;
} TestQueue;

static bool enqueue(void *opaque, ScrHostedJobFn run, void *job) {
  TestQueue *queue = (TestQueue *)opaque;
  if (queue->refuse) return false;
  assert(queue->head + queue->length < 32);
  queue->jobs[queue->head + queue->length++] = (TestJob){run, job};
  return true;
}

static void drain_one(TestQueue *queue) {
  assert(queue->length > 0);
  TestJob job = queue->jobs[queue->head++];
  queue->length--;
  job.run(job.job);
  if (queue->length == 0) queue->head = 0;
}

static void resume(void *opaque, ScrPromise *settled) {
  TestFrame *frame = (TestFrame *)opaque;
  if (settled != NULL) scr_hosted_await_void(settled);
  order[order_len++] = frame->mark;
  frames_resumed++;
  frame_release(frame);
}

int main(void) {
  scr_init();
  TestQueue queue = {0};
  ScrHostedScheduler *scheduler = scr_hosted_scheduler_new(&enqueue, &queue);
  assert(scheduler != NULL);
  assert(scr_hosted_scheduler_is_accepting(scheduler));

  /* Already-settled still defers exactly once. */
  ScrPromise *settled = scr_promise_new();
  scr_promise_fulfill_void(settled);
  assert(scr_promise_await_hosted(scheduler, settled, &resume,
                                  frame_new('S', NULL), &frame_release));
  assert(order_len == 0 && queue.length == 1);
  drain_one(&queue);
  assert(order_len == 1 && order[0] == 'S');
  scr_promise_release(settled);

  /* Attachment order on one pending promise is FIFO, and every reaction is
   * an individual host job (not one ScriptC-owned batch drain). */
  ScrPromise *pending = scr_promise_new();
  assert(scr_promise_await_hosted(scheduler, pending, &resume,
                                  frame_new('A', NULL), &frame_release));
  assert(scr_promise_await_hosted(scheduler, pending, &resume,
                                  frame_new('B', NULL), &frame_release));
  scr_promise_fulfill_void(pending);
  assert(queue.length == 2);
  drain_one(&queue);
  drain_one(&queue);
  assert(order_len == 3 && order[1] == 'A' && order[2] == 'B');
  scr_promise_release(pending);

  /* A Promise -> frame -> Promise cycle is visible to cycle collection. */
  ScrPromise *cycle = scr_promise_new();
  assert(scr_promise_await_hosted(scheduler, cycle, &resume,
                                  frame_new('X', cycle), &frame_release));
  scr_promise_release(cycle);
  int dropped_before_cycle = frames_dropped;
  scr_collect_cycles();
  assert(frames_dropped == dropped_before_cycle + 1);

  /* Stop detaches pending reactions immediately. An already-enqueued job
   * remains callable by the host but observes the closed realm and drops. */
  ScrPromise *cancelled = scr_promise_new();
  assert(scr_promise_await_hosted(scheduler, cancelled, &resume,
                                  frame_new('C', NULL), &frame_release));
  assert(scr_hosted_scheduler_post(scheduler, &resume, frame_new('Q', NULL),
                                   &frame_release));
  int resumed_before_stop = frames_resumed;
  int dropped_before_stop = frames_dropped;
  scr_hosted_scheduler_stop(scheduler);
  assert(!scr_hosted_scheduler_is_accepting(scheduler));
  assert(frames_dropped == dropped_before_stop + 1); /* pending C */
  drain_one(&queue);                                /* queued Q */
  assert(frames_resumed == resumed_before_stop);
  assert(frames_dropped == dropped_before_stop + 2);
  scr_promise_release(cancelled);

  /* Closed and refusing schedulers consume frame ownership on failure. */
  assert(!scr_hosted_scheduler_post(scheduler, &resume, frame_new('N', NULL),
                                    &frame_release));
  scr_hosted_scheduler_release(scheduler);
  assert(frames_live == 0);
#ifdef SCR_RC_AUDIT
  scr_collect_cycles();
  assert(scr_promise_live_count() == 0);
#endif
  return 0;
}
