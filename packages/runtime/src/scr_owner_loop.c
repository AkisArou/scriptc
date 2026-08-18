/* The retained-callback service's default wake, for a program that owns its
 * own loop.
 *
 * The owner gateway takes a wake function at construction because a host that
 * already has a loop — GLib's, CFRunLoop, an Android Looper — must be the one
 * to decide how a foreign producer gets the script thread's attention. That is
 * the case the gateway exists for, and an embedder supplies the wake itself.
 *
 * A plain executable has no embedder, and until this unit existed it therefore
 * could not use the service at all: the only way in was a wake nobody was
 * there to write. So this is the wake for that case, and only that case — a
 * self-pipe the foreign thread writes one byte to, and the four-function hook
 * scriptc's own loop already consults for pollable foreign work.
 *
 * It installs ONLY when no embedder has configured the service, so linking it
 * can never take the decision away from a host that made one. */
#include "scr_runtime.h"

#include <stdbool.h>

#if !defined(_WIN32) && !defined(__wasi__)
#include <fcntl.h>
#include <unistd.h>
#endif

static int scr_owner_loop_pipe[2] = {-1, -1};
static bool scr_owner_loop_installed;

/* Runs on the PRODUCING thread. write() to a nonblocking pipe is
 * async-signal-safe and takes no lock the gateway holds; a full pipe already
 * means a wake is pending, so a dropped byte cannot lose an event. */
static void scr_owner_loop_wake(void *context) {
  (void)context;
#if !defined(_WIN32) && !defined(__wasi__)
  if (scr_owner_loop_pipe[1] < 0) return;
  const char byte = 1;
  (void)!write(scr_owner_loop_pipe[1], &byte, 1);
#endif
}

/* The fd must describe the queue as it is NOW, not as it was when the first
 * event arrived. The gateway writes one byte whenever a drain leaves work
 * behind, so one byte comes back per delivery and the fd falls quiet exactly
 * when the queue does.
 *
 * Consuming fewer would leave it readable forever: the loop could then never
 * block, and a program receiving a slow trickle of foreign events would spin
 * at full CPU between them. */
static void scr_owner_loop_consume(size_t bytes) {
#if !defined(_WIN32) && !defined(__wasi__)
  if (scr_owner_loop_pipe[0] < 0) return;
  char buf[64];
  if (bytes == 1) {
    (void)!read(scr_owner_loop_pipe[0], buf, 1);
    return;
  }
  while (read(scr_owner_loop_pipe[0], buf, sizeof buf) > 0) {}
#else
  (void)bytes;
#endif
}

/* The loop stays alive while a FOREIGN registration exists, not merely while
 * an event is queued: such a producer may be about to raise one, and a program
 * that exited in between would drop it. A registration only the script thread
 * can raise holds nothing open — that thread is sitting in this loop, so it is
 * not about to raise anything, and counting it would keep a finished program
 * running forever. */
static bool scr_owner_loop_pending(void) {
  return scr_retained_callbacks_foreign_pending() ||
         scr_retained_callbacks_pending();
}

/* True means "this station did something", which is what makes the loop
 * re-examine the world — including the pending-exception check immediately
 * after. A handler that threw did something, so an exception result reports
 * true as surely as a delivery does; reporting false there would leave the
 * exception unobserved and the loop spinning on a registration that can no
 * longer make progress. */
static bool scr_owner_loop_dispatch(void) {
  ScrRetainedCallbackDispatch dispatched = scr_retained_callbacks_dispatch();
  if (!scr_retained_callbacks_pending()) {
    /* Nothing left: take whatever is still readable so the next poll blocks. */
    scr_owner_loop_consume(0);
  } else if (dispatched != SCR_RETAINED_CALLBACK_DISPATCH_IDLE) {
    scr_owner_loop_consume(1);
  }
  return dispatched != SCR_RETAINED_CALLBACK_DISPATCH_IDLE;
}

static int scr_owner_loop_pollfd(void) { return scr_owner_loop_pipe[0]; }

static void scr_owner_loop_stop(void) {
  scr_retained_callbacks_stop_accepting();
  (void)scr_retained_callbacks_discard();
}

bool scr_owner_loop_install(void) {
  if (scr_owner_loop_installed) return true;
  /* An embedder that already configured the service owns the wake, and this
   * unit has nothing to add. Saying so with `true` is not a lie of
   * convenience: the caller asked for the service to be usable, and it is. */
  if (scr_retained_callbacks_configured()) return true;
#if !defined(_WIN32) && !defined(__wasi__)
  if (pipe(scr_owner_loop_pipe) == 0) {
    for (int i = 0; i < 2; i++) {
      (void)fcntl(scr_owner_loop_pipe[i], F_SETFL, O_NONBLOCK);
      (void)fcntl(scr_owner_loop_pipe[i], F_SETFD, FD_CLOEXEC);
    }
  } else {
    scr_owner_loop_pipe[0] = scr_owner_loop_pipe[1] = -1;
  }
#endif
  if (!scr_retained_callbacks_configure(&scr_owner_loop_wake, NULL)) {
    return false;
  }
  scr_owner_loop_installed = true;
  scr_loop_set_ffi(&scr_owner_loop_pending, &scr_owner_loop_dispatch,
                   &scr_owner_loop_pollfd, &scr_owner_loop_stop);
  return true;
}
