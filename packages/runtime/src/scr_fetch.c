/* fetch over scriptc's OWN net stack — the static tier below is entirely
 * engine-free, while the dynamic tier exposes the same transport through
 * the island's full web API. Both use the
 * scr_platform poller + scr_net sockets, scr_http's HTTP/1.1 client
 * parser, scr_tls (vendored mbedTLS) for https, and zlib for response
 * decompression. No libcurl anywhere: the architecture is Node's own
 * (libuv sockets + OpenSSL + undici; ours: poller + mbedTLS + this
 * unit), which is what lets fetch compile for every target the socket
 * units reach — win32 included, where no system-libcurl contract
 * exists. The curl implementation this replaces stays compilable for
 * one release as the reference (scr_fetch_curl.c, selected by
 * SCRIPTC_FETCH_CURL=1 at build time; same install symbol, same island
 * surface, same fixture suite).
 *
 * Architecture (the JS half is UNCHANGED from the curl bridge):
 * - The JS half (fetch_glue below) defines globalThis.fetch over two host
 *   functions: host.start(req, cbs) begins a transfer and host.abort(id)
 *   cancels one (response-body cancel). fetch() returns a REAL island
 *   promise; the Response's body is an island ReadableStream fed by
 *   C→engine callbacks as data arrives.
 * - The C half is a fetch-layer client over scr_http's client machinery:
 *   one ScrHttpClientReq per hop, minted runtime closures (caps[0] boxes
 *   the transfer) as its response/data/end/error listeners, callbacks
 *   firing from the net unit's dispatch station — the loop's own poller
 *   sleeps on socket readiness, so this unit registers NO poll hook with
 *   the island (the curl bridge needed one to sleep on curl's fds).
 *   AbortSignal.timeout stays punctual through the loop's island-timer
 *   deadline hook (scr_loop_set_island_deadline — armed island timers cap
 *   the idle sleep exactly the way the curl poll capped its own).
 * - fetch SEMANTICS, matched to Node/undici: HTTP errors RESOLVE (only
 *   network failure rejects, with TypeError "fetch failed" — Node's exact
 *   message); redirects are followed IN THIS UNIT (20 hops, fetch's
 *   limit; 303 — and 301/302 for POST — rewrite to GET and drop the body
 *   and its content-* headers, the fetch spec's rules; authorization is
 *   stripped on cross-origin hops; response.url = the final URL without
 *   its fragment, response.redirected set; a redirect hop's own body
 *   never reaches the island). The request head carries undici's exact
 *   default header set in undici's order (host, connection, the user
 *   headers, accept, accept-language, sec-fetch-mode, user-agent,
 *   accept-encoding — captured from Node 24 on the wire); gzip/zlib
 *   response bodies arrive decompressed (accept-encoding advertises
 *   "gzip, deflate", and content-encoding: gzip/x-gzip/deflate inflates
 *   through zlib's 15+32 auto-detect — raw-deflate servers and br/zstd
 *   are out of the slice, honestly: br/zstd are never offered).
 * - DNS: scr_net dials IP literals only (Node's shape for its slice), so
 *   this unit resolves hostnames with getaddrinfo AT HOP START — the
 *   dns.lookup precedent (scr_dgram.c): synchronous resolution, first
 *   answer wins; failures ride the socket's deferred
 *   "getaddrinfo ENOTFOUND host" error so the rejection's cause is
 *   Node's exact shape. TLS handshakes verify/SNI against the URL
 *   HOSTNAME while the socket dials the resolved IP.
 * - Proxies, matched to Node: undici's global fetch IGNORES http_proxy/
 *   https_proxy unless NODE_USE_ENV_PROXY=1 opts in (Node 24's
 *   EnvHttpProxyAgent). Opted in, http:// targets relay through the
 *   proxy as absolute-URI requests (the classic forward-proxy wire form;
 *   undici tunnels CONNECT, but the fixture proxy counts either form
 *   identically), no_proxy exclusions honored. https-over-proxy
 *   (CONNECT) is out of the slice.
 * - AbortSignal is wired in both tiers: an already-aborted signal rejects
 *   with its reason before any transfer starts and aborting a live
 *   transfer destroys the hop's connection. The dynamic tier uses the
 *   island's Web/timer glue; the static tier below uses native signal
 *   handles and the runtime's unref'd timer heap.
 * - Error causes, Node's shapes: connect ECONNREFUSED ip:port /
 *   getaddrinfo ENOTFOUND host pass through from the net layer with
 *   their codes; a server that dies before the response head maps to
 *   undici's cause exactly — "other side closed", code UND_ERR_SOCKET
 *   (the curl bridge could only offer curl's own string there).
 * - Ownership: each transfer is refcounted — the live registry holds +1
 *   and every minted listener closure's box holds +1; settling releases
 *   the engine callback object and the hop client, and teardown
 *   (registered with the island) frees whatever is still live before the
 *   engine goes down, so the island audit stays zero. */
#ifndef SCR_DYNAMIC

#include "scr_runtime.h"
#include "scr_url_internal.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zlib.h>

/*
 * The static tier is a small native Web-platform island of its own:
 * AbortSignal, Response, ReadableStream, its default reader, and its
 * controller are SCR_DYN_HANDLE values. That preserves identity and
 * permits normal typed member syntax while every operation still lands
 * in C. Response promises resolve at the response HEAD; body chunks flow
 * into the same native stream consumed by reader.read() or json().
 */

typedef struct SfTransfer SfTransfer;
typedef struct SfSignal SfSignal;
typedef struct SfSignalWatch SfSignalWatch;
typedef struct SfEvent SfEvent;
typedef struct SfStream SfStream;
typedef struct SfReader SfReader;
typedef struct SfResponse SfResponse;
typedef struct SfHeaders SfHeaders;
typedef struct SfCollector SfCollector;
typedef struct SfReadRequest SfReadRequest;
typedef struct SfPullWait SfPullWait;
typedef struct SfStartWait SfStartWait;
typedef struct SfCancelWait SfCancelWait;

typedef struct SfChunk {
  ScrDyn *value;
  struct SfChunk *next;
} SfChunk;

struct SfReadRequest {
  ScrPromise *promise;
  SfReadRequest *next;
};

typedef struct SfAbortListener {
  ScrDyn *listener;
  bool capture;
  bool once;
  size_t id;
  SfSignal *target;        /* weak; the target owns this listener */
  SfSignal *option_signal; /* owned unless it is the target */
  SfSignalWatch *signal_watch;
  struct SfAbortListener *next;
} SfAbortListener;

struct SfSignalWatch {
  SfSignal *source; /* weak; NULL after the source fires */
  void *owner;      /* owner keeps source alive */
  void (*fire)(SfSignalWatch *, SfSignal *);
  SfSignalWatch *next;
};

struct SfSignal {
  size_t rc;
  bool aborted;
  ScrDyn *reason;
  ScrError *error_reason;
  ScrDyn *onabort;
  size_t onabort_order;
  SfAbortListener *listeners;
  size_t next_listener_id;
  SfSignalWatch *watchers;
  SfSignal **sources;
  SfSignalWatch **source_watches;
  size_t source_count;
  double timer_id;
};

struct SfEvent {
  size_t rc;
  SfSignal *target;
  double time_stamp;
  bool dispatching;
  bool stop_propagation;
  bool stop_immediate;
};

struct SfReader {
  size_t rc;
  size_t handle_refs;
  SfStream *stream; /* weak; handle refs retain it while the lock is live */
  SfReadRequest *pending_head;
  SfReadRequest *pending_tail;
  ScrPromise *closed;
};

enum {
  SF_COLLECT_JSON,
  SF_COLLECT_TEXT,
  SF_COLLECT_BYTES,
};

enum {
  SF_REDIRECT_FOLLOW,
  SF_REDIRECT_ERROR,
  SF_REDIRECT_MANUAL,
};

struct SfCollector {
  ScrPromise *promise;
  SfStream *held_stream;
  char *data;
  size_t len;
  size_t cap;
  int mode;
};

struct SfPullWait {
  SfStream *stream;
  ScrPromise *promise;
};

struct SfStartWait {
  SfStream *stream;
  ScrPromise *promise;
};

struct SfCancelWait {
  ScrPromise *source;
  ScrPromise *result;
};

typedef struct SfThenState {
  size_t rc;
  bool called;
  ScrPromise *promise;
} SfThenState;

struct SfStream {
  size_t rc;
  SfChunk *head;
  SfChunk *tail;
  size_t queued;
  bool started;
  bool close_requested;
  bool closed;
  bool disturbed;
  bool internal_lock;
  bool initial_pull_pending;
  bool enqueue_draining;
  bool pulling;
  bool pull_again;
  bool discarded;
  ScrDyn *error;
  SfReader *reader;       /* owned while locked */
  SfCollector *collector; /* owned while a body reader is active */
  ScrDyn *pull_cb;
  ScrDyn *cancel_cb;
  ScrDyn *from_dyn;
  ScrArr *from_array;
  ScrBytes *from_bytes;
  ScrStr *from_string;
  ScrDyn *(*from_array_item)(ScrArr *, double);
  double from_index;
  SfTransfer *request_owner;  /* weak; transfer owns the stream */
  SfTransfer *response_owner; /* weak; transfer owns the stream */
};

struct SfHeaders {
  size_t rc;
  ScrArr *pairs;
};

struct SfResponse {
  size_t rc;
  SfStream *body;
  SfHeaders *headers;
  ScrStr *url;
  ScrStr *status_text;
  int status;
  bool redirected;
  bool null_body;
};

struct SfTransfer {
  size_t rc;                 /* live registry + one per listener closure */
  ScrPromise *promise;       /* owned */
  ScrUrl *url;               /* current hop, owned */
  ScrStr *method;            /* current method, owned */
  ScrArr *headers;           /* user header pairs, owned */
  ScrDyn *body;              /* replayable body or source stream, owned */
  int redirect_mode;
  int hops;
  bool redirected;
  ScrHttpClientReq *client;  /* owned */
  ScrNetSocket *response_socket; /* owned while the response is live */
  bool response_paused;
  bool response_null_body;
  SfSignal *signal;          /* owned */
  SfSignalWatch *signal_watch;
  SfStream *request_stream;  /* owned */
  SfStream *response_stream; /* owned */
  bool request_has_content_length;
  size_t request_content_length;
  size_t request_body_sent;
  z_stream zs;
  bool inflating;
  bool inflate_member_end;
  bool response_sent;
  bool done;
  struct SfTransfer *next;
};

static SfTransfer *sf_live;

static void sf_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static bool sf_name(const char *key, size_t len, const char *want) {
  return strlen(want) == len && memcmp(key, want, len) == 0;
}

static void sf_type_error(const char *message) {
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

static void sf_not_function(const char *what) {
  size_t n = strlen(what);
  char *message = malloc(n + 19);
  if (!message) sf_oom();
  memcpy(message, what, n);
  memcpy(message + n, " is not a function", 19);
  scr_throw_error_msg(SCR_ERR_TYPE, message, n + 18);
  free(message);
}

static bool sf_is_error_dyn(const ScrDyn *d) {
  if (!d || d->kind != SCR_DYN_OBJ) return false;
  const ScrDyn *mark = scr_dyn_obj_get(d, "%error", 6);
  return mark && mark->kind == SCR_DYN_BOOL && mark->v.b;
}

static void sf_throw_dyn_reason(ScrDyn *reason) {
  if (sf_is_error_dyn(reason)) {
    ScrError *e = scr_error_from_dyn(reason);
    scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v,
                  scr_error_trace_arg());
    return;
  }
  switch (reason ? reason->kind : SCR_DYN_UNDEF) {
  case SCR_DYN_NUM:
    scr_throw_f64(reason->v.num);
    return;
  case SCR_DYN_BOOL:
    scr_throw_bool(reason->v.b);
    return;
  case SCR_DYN_STR:
    scr_throw_str(scr_str_retain(reason->v.str));
    return;
  default:
    scr_throw_ref(scr_dyn_retain(reason ? reason : scr_dyn_undefined()),
                  &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
    return;
  }
}

static void sf_reject_promise_reason(ScrPromise *p, ScrDyn *reason) {
  sf_throw_dyn_reason(reason);
  scr_promise_reject_pending(p);
}

static ScrDyn *sf_dom_reason(const char *name, const char *message,
                            ScrError **error_out) {
  ScrStr *message_str = scr_str_new(message, strlen(message));
  ScrStr *name_str = scr_str_new(name, strlen(name));
  ScrDyn *m = scr_dyn_new_str(message_str);
  ScrDyn *n = scr_dyn_new_str(name_str);
  scr_str_release(message_str);
  scr_str_release(name_str);
  ScrError *e = scr_domex_new(m, n);
  scr_dyn_release(m);
  scr_dyn_release(n);
  ScrDyn *d = scr_dyn_from_error(e);
  *error_out = e; /* constructor +1 moves to the signal */
  return d;
}

/* ── AbortSignal ─────────────────────────────────────────────────── */

static SfSignal *sf_signal_new(void) {
  SfSignal *s = calloc(1, sizeof *s);
  if (!s) sf_oom();
  s->rc = 1;
  return s;
}

static SfSignal *sf_signal_retain(SfSignal *s) {
  s->rc++;
  return s;
}

static void sf_signal_release(SfSignal *s);

static void sf_watch_free(SfSignalWatch *w) {
  if (!w) return;
  if (w->source) {
    for (SfSignalWatch **at = &w->source->watchers; *at; at = &(*at)->next) {
      if (*at == w) {
        *at = w->next;
        break;
      }
    }
  }
  free(w);
}

static void sf_abort_listener_free(SfAbortListener *l) {
  if (!l) return;
  sf_watch_free(l->signal_watch);
  if (l->option_signal && l->option_signal != l->target) {
    sf_signal_release(l->option_signal);
  }
  scr_dyn_release(l->listener);
  free(l);
}

static void sf_signal_drop_listeners(SfSignal *s) {
  SfAbortListener *listeners = s->listeners;
  s->listeners = NULL; /* unlink before callback releases can re-enter */
  while (listeners) {
    SfAbortListener *next = listeners->next;
    listeners->next = NULL;
    sf_abort_listener_free(listeners);
    listeners = next;
  }
}

static void sf_signal_release(SfSignal *s) {
  if (!s || --s->rc > 0) return;
  for (size_t i = 0; i < s->source_count; i++) {
    sf_watch_free(s->source_watches[i]);
    sf_signal_release(s->sources[i]);
  }
  free(s->source_watches);
  free(s->sources);
  sf_signal_drop_listeners(s);
  scr_dyn_release(s->onabort);
  scr_dyn_release(s->reason);
  scr_error_release(s->error_reason);
  free(s);
}

static void *sf_signal_retain_v(void *p) {
  return sf_signal_retain((SfSignal *)p);
}
static void sf_signal_release_v(void *p) {
  sf_signal_release((SfSignal *)p);
}

static SfEvent *sf_event_new(SfSignal *target) {
  SfEvent *event = calloc(1, sizeof *event);
  if (!event) sf_oom();
  event->rc = 1;
  event->target = sf_signal_retain(target);
  event->time_stamp = scr_perf_now();
  event->dispatching = true;
  return event;
}

static SfEvent *sf_event_retain(SfEvent *event) {
  event->rc++;
  return event;
}

static void sf_event_release(SfEvent *event) {
  if (!event || --event->rc > 0) return;
  sf_signal_release(event->target);
  free(event);
}

static void *sf_event_retain_v(void *ptr) {
  return sf_event_retain((SfEvent *)ptr);
}

static void sf_event_release_v(void *ptr) {
  sf_event_release((SfEvent *)ptr);
}

static ScrDyn *sf_event_invoke(void *ptr, ScrDyn *self,
                               const char *method, ScrDyn *const *args,
                               size_t argc, const char *what) {
  SfEvent *event = ptr;
  (void)self;
  (void)args;
  (void)argc;
  if (strcmp(method, "preventDefault") == 0) {
    /* Abort events are not cancelable. */
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "stopPropagation") == 0) {
    event->stop_propagation = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "stopImmediatePropagation") == 0) {
    event->stop_propagation = true;
    event->stop_immediate = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "composedPath") == 0) {
    ScrDyn *path = scr_dyn_new_arr();
    if (event->dispatching) {
      scr_dyn_arr_push(
          path,
          scr_dyn_new_handle(event->target, SCR_DYNH_ABORT_SIGNAL));
    }
    return path;
  }
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_event_get(void *ptr, const char *key, size_t len) {
  SfEvent *event = ptr;
  if (sf_name(key, len, "type")) {
    ScrStr *type = scr_str_new("abort", 5);
    ScrDyn *out = scr_dyn_new_str(type);
    scr_str_release(type);
    return out;
  }
  if (sf_name(key, len, "bubbles") ||
      sf_name(key, len, "cancelable") ||
      sf_name(key, len, "composed") ||
      sf_name(key, len, "defaultPrevented")) {
    return scr_dyn_new_bool(false);
  }
  if (sf_name(key, len, "eventPhase")) {
    return scr_dyn_new_num(event->dispatching ? 2 : 0);
  }
  if (sf_name(key, len, "target") ||
      sf_name(key, len, "srcElement")) {
    return scr_dyn_new_handle(event->target, SCR_DYNH_ABORT_SIGNAL);
  }
  if (sf_name(key, len, "currentTarget")) {
    return event->dispatching
               ? scr_dyn_new_handle(event->target, SCR_DYNH_ABORT_SIGNAL)
               : scr_dyn_new_null();
  }
  if (sf_name(key, len, "isTrusted")) return scr_dyn_new_bool(true);
  if (sf_name(key, len, "timeStamp")) {
    return scr_dyn_new_num(event->time_stamp);
  }
  if (sf_name(key, len, "cancelBubble")) {
    return scr_dyn_new_bool(event->stop_propagation);
  }
  if (sf_name(key, len, "returnValue")) return scr_dyn_new_bool(true);
  return NULL;
}

static bool sf_event_set(void *ptr, const char *key, size_t len,
                         const ScrDyn *value) {
  SfEvent *event = ptr;
  if (sf_name(key, len, "cancelBubble")) {
    if (scr_dyn_truthy(value)) event->stop_propagation = true;
    return true;
  }
  if (sf_name(key, len, "returnValue")) {
    /* Setting false only prevents a cancelable event's default action. */
    return true;
  }
  return false;
}

static SfSignalWatch *sf_signal_watch(SfSignal *source, void *owner,
                                     void (*fire)(SfSignalWatch *,
                                                  SfSignal *)) {
  SfSignalWatch *w = calloc(1, sizeof *w);
  if (!w) sf_oom();
  w->source = source;
  w->owner = owner;
  w->fire = fire;
  w->next = source->watchers;
  source->watchers = w;
  return w;
}

static void sf_listener_signal_abort(SfSignalWatch *w,
                                     SfSignal *source) {
  (void)source;
  SfAbortListener *listener = w->owner;
  SfSignal *target = listener->target;
  for (SfAbortListener **at = &target->listeners; *at;
       at = &(*at)->next) {
    if (*at == listener) {
      *at = listener->next;
      sf_abort_listener_free(listener);
      return;
    }
  }
  sf_watch_free(w);
}

static void sf_signal_dispatch_listeners(SfSignal *s) {
  SfEvent *event_state = sf_event_new(s);
  ScrDyn *event =
      scr_dyn_new_handle(event_state, SCR_DYNH_EVENT);
  sf_event_release(event_state);
  ScrCaught *first_error = NULL;
  /*
   * EventTarget dispatch snapshots the handlers present at the start:
   * additions wait for the next event, removals before a listener's turn
   * suppress it, and a listener may remove itself safely. `onabort` occupies
   * the position where it was first assigned, just like an event-handler
   * attribute in the DOM. Holding raw list nodes across the user callback is
   * not safe because removeEventListener frees those nodes.
   */
  size_t count = s->onabort && s->onabort->kind == SCR_DYN_FUNC ? 1 : 0;
  for (SfAbortListener *l = s->listeners; l; l = l->next) count++;
  typedef struct {
    ScrDyn *listener;
    bool once;
    bool attribute;
    size_t id;
  } SfAbortDispatch;
  SfAbortDispatch *dispatch =
      count ? calloc(count, sizeof *dispatch) : NULL;
  if (count && !dispatch) sf_oom();
  size_t i = 0;
  if (s->onabort && s->onabort->kind == SCR_DYN_FUNC) {
    dispatch[i].listener = scr_dyn_retain(s->onabort);
    dispatch[i].attribute = true;
    dispatch[i].id = s->onabort_order;
    i++;
  }
  for (SfAbortListener *l = s->listeners; l; l = l->next) {
    dispatch[i].listener = scr_dyn_retain(l->listener);
    dispatch[i].once = l->once;
    dispatch[i].id = l->id;
    i++;
  }
  for (i = 1; i < count; i++) {
    SfAbortDispatch entry = dispatch[i];
    size_t j = i;
    while (j > 0 && dispatch[j - 1].id > entry.id) {
      dispatch[j] = dispatch[j - 1];
      j--;
    }
    dispatch[j] = entry;
  }

  for (i = 0; i < count; i++) {
    if (dispatch[i].attribute) {
      if (!s->onabort || s->onabort_order != dispatch[i].id) {
        scr_dyn_release(dispatch[i].listener);
        continue;
      }
      /*
       * Assignment replaces the handler without moving its registration
       * position. Invoke the current value if an earlier callback replaced
       * it during this dispatch.
       */
      ScrDyn *handler = scr_dyn_retain(s->onabort);
      ScrDyn *args[1] = {event};
      scr_dyn_this_push(s, SCR_DYNH_ABORT_SIGNAL);
      ScrDyn *r = scr_dyn_call(handler, args, 1, "signal.onabort");
      scr_dyn_this_pop();
      scr_dyn_release(r);
      scr_dyn_release(handler);
      scr_dyn_release(dispatch[i].listener);
      if (scr_exc_pending()) {
        ScrCaught *caught = scr_exc_take();
        if (!first_error) {
          first_error = caught;
        } else {
          scr_caught_release(caught);
        }
      }
      if (event_state->stop_immediate) {
        i++;
        break;
      }
      continue;
    }
    SfAbortListener **at = &s->listeners;
    while (*at && (*at)->id != dispatch[i].id) {
      at = &(*at)->next;
    }
    if (!*at) {
      scr_dyn_release(dispatch[i].listener);
      continue;
    }
    if (dispatch[i].once) {
      SfAbortListener *l = *at;
      *at = l->next;
      sf_abort_listener_free(l);
    }
    ScrDyn *callable = dispatch[i].listener;
    if (callable->kind == SCR_DYN_OBJ) {
      const ScrDyn *handle =
          scr_dyn_obj_get(callable, "handleEvent", 11);
      if (!handle || handle->kind != SCR_DYN_FUNC) {
        scr_dyn_release(dispatch[i].listener);
        continue;
      }
      callable = (ScrDyn *)handle;
    }
    ScrDyn *args[1] = {event};
    scr_dyn_this_push(s, SCR_DYNH_ABORT_SIGNAL);
    ScrDyn *r =
        scr_dyn_call(callable, args, 1, "abort listener");
    scr_dyn_this_pop();
    scr_dyn_release(r);
    scr_dyn_release(dispatch[i].listener);
    if (scr_exc_pending()) {
      ScrCaught *caught = scr_exc_take();
      if (!first_error) {
        first_error = caught;
      } else {
        scr_caught_release(caught);
      }
    }
    if (event_state->stop_immediate) {
      i++;
      break;
    }
  }
  while (i < count) {
    scr_dyn_release(dispatch[i].listener);
    i++;
  }
  event_state->dispatching = false;
  free(dispatch);
  scr_dyn_release(event);
  /* Abort is one-shot. Registrations cannot fire again, so retaining them
   * after dispatch only creates EventTarget→listener→EventTarget cycles
   * that the checked-dynamic boundary cannot trace. */
  sf_signal_drop_listeners(s);
  if (first_error) {
    scr_rethrow(first_error);
    scr_caught_release(first_error);
  }
}

static void sf_signal_abort_full(SfSignal *s, ScrDyn *reason,
                                 ScrError *error_reason) {
  if (s->aborted) return;
  s->aborted = true;
  s->reason = scr_dyn_retain(reason);
  s->error_reason = error_reason ? scr_error_retain(error_reason) : NULL;
  while (s->watchers) {
    SfSignalWatch *w = s->watchers;
    s->watchers = w->next;
    w->source = NULL;
    w->fire(w, s); /* the owner may free w */
  }
  sf_signal_dispatch_listeners(s);
}

static void sf_signal_abort_default(SfSignal *s, bool timeout) {
  ScrError *e = NULL;
  ScrDyn *reason = sf_dom_reason(
      timeout ? "TimeoutError" : "AbortError",
      timeout ? "The operation was aborted due to timeout"
              : "This operation was aborted",
      &e);
  sf_signal_abort_full(s, reason, e);
  scr_dyn_release(reason);
  scr_error_release(e);
}

static SfSignal *sf_signal_of(const ScrDyn *d, const char *where) {
  if (!d || d->kind != SCR_DYN_HANDLE ||
      d->v.handle.tag != SCR_DYNH_ABORT_SIGNAL) {
    sf_type_error(where);
    return NULL;
  }
  return (SfSignal *)d->v.handle.ptr;
}

static void sf_signal_timer_fire(ScrClosure *cb) {
  SfSignal *s = (SfSignal *)scr_box_get_ref(cb->caps[0]);
  if (!s) return;
  s->timer_id = 0;
  sf_signal_abort_default(s, true);
  sf_signal_release(s);
}

ScrDyn *scr_fetch_abort_timeout(double ms) {
  if (!isfinite(ms) || trunc(ms) != ms || ms < 0 || ms > 4294967295.0) {
    char received[48];
    scr_num_received(ms, received);
    const char *range =
        !isfinite(ms) || trunc(ms) != ms
            ? "an integer"
            : ">= 0 && <= 4294967295";
    char message[224];
    int len = snprintf(
        message, sizeof message,
        "The value of \"delay\" is out of range. It must be %s. Received %s",
        range, received);
    if (len < 0 || (size_t)len >= sizeof message) sf_oom();
    scr_throw_error_msg_code(SCR_ERR_RANGE, message, (size_t)len,
                             "ERR_OUT_OF_RANGE");
    return NULL;
  }
  SfSignal *s = sf_signal_new();
  ScrClosure *cb = scr_closure_new((void *)&sf_signal_timer_fire, 1);
  ScrBox *box =
      scr_box_new_obj(&sf_signal_retain_v, &sf_signal_release_v, NULL);
  scr_box_set_ref(box, sf_signal_retain(s));
  cb->caps[0] = box;
  s->timer_id = scr_set_timeout_handle(cb, ms);
  scr_timer_unref(s->timer_id);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_ABORT_SIGNAL);
  sf_signal_release(s);
  return out;
}

ScrDyn *scr_fetch_abort_now(ScrDyn *reason) {
  SfSignal *s = sf_signal_new();
  if (!reason || reason->kind == SCR_DYN_UNDEF) {
    sf_signal_abort_default(s, false);
  } else {
    ScrError *e = sf_is_error_dyn(reason) ? scr_error_from_dyn(reason) : NULL;
    sf_signal_abort_full(s, reason, e);
    scr_error_release(e);
  }
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_ABORT_SIGNAL);
  sf_signal_release(s);
  return out;
}

static void sf_any_source_abort(SfSignalWatch *w, SfSignal *source) {
  SfSignal *out = (SfSignal *)w->owner;
  sf_signal_abort_full(out, source->reason, source->error_reason);
}

ScrDyn *scr_fetch_abort_any(ScrDyn *signals) {
  if (!signals || signals->kind != SCR_DYN_ARR) {
    sf_type_error("AbortSignal.any requires an array of AbortSignals");
    return NULL;
  }
  SfSignal *out = sf_signal_new();
  out->source_count = signals->v.arr.len;
  if (out->source_count) {
    out->sources = calloc(out->source_count, sizeof *out->sources);
    out->source_watches =
        calloc(out->source_count, sizeof *out->source_watches);
    if (!out->sources || !out->source_watches) sf_oom();
  }
  for (size_t i = 0; i < out->source_count; i++) {
    SfSignal *source =
        sf_signal_of(signals->v.arr.items[i],
                     "AbortSignal.any requires an array of AbortSignals");
    if (!source) {
      sf_signal_release(out);
      return NULL;
    }
    out->sources[i] = sf_signal_retain(source);
    if (source->aborted) {
      sf_signal_abort_full(out, source->reason, source->error_reason);
    } else {
      out->source_watches[i] =
          sf_signal_watch(source, out, &sf_any_source_abort);
    }
  }
  ScrDyn *boxed = scr_dyn_new_handle(out, SCR_DYNH_ABORT_SIGNAL);
  sf_signal_release(out);
  return boxed;
}

static bool sf_signal_listener_options(
    ScrDyn *const *args, size_t argc, bool *capture, bool *once,
    SfSignal **option_signal) {
  *capture = false;
  *once = false;
  if (option_signal) *option_signal = NULL;
  if (argc < 3) return true;
  if (args[2]->kind == SCR_DYN_BOOL) {
    /* EventTarget's boolean overload is `useCapture`, never `once`. */
    *capture = args[2]->v.b;
    return true;
  }
  if (args[2]->kind != SCR_DYN_OBJ) return true;
  const ScrDyn *capture_value =
      scr_dyn_obj_get(args[2], "capture", 7);
  const ScrDyn *once_value = scr_dyn_obj_get(args[2], "once", 4);
  *capture = capture_value && capture_value->kind == SCR_DYN_BOOL &&
             capture_value->v.b;
  *once = once_value && once_value->kind == SCR_DYN_BOOL &&
          once_value->v.b;
  if (option_signal) {
    const ScrDyn *signal_value =
        scr_dyn_obj_get(args[2], "signal", 6);
    if (signal_value && signal_value->kind != SCR_DYN_UNDEF) {
      *option_signal = sf_signal_of(
          signal_value,
          "AddEventListenerOptions.signal must be an AbortSignal");
      if (!*option_signal) return false;
    }
  }
  return true;
}

static bool sf_abort_listener_value(const ScrDyn *listener) {
  if (listener->kind == SCR_DYN_FUNC) return true;
  if (listener->kind != SCR_DYN_OBJ) return false;
  const ScrDyn *handle =
      scr_dyn_obj_get(listener, "handleEvent", 11);
  return handle && handle->kind == SCR_DYN_FUNC;
}

static ScrDyn *sf_signal_invoke(void *ptr, ScrDyn *self, const char *method,
                                ScrDyn *const *args, size_t argc,
                                const char *what) {
  SfSignal *s = ptr;
  if (strcmp(method, "throwIfAborted") == 0) {
    if (argc != 0) {
      sf_type_error("AbortSignal.throwIfAborted takes no arguments");
      return NULL;
    }
    if (s->aborted) {
      sf_throw_dyn_reason(s->reason);
      return NULL;
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "addEventListener") == 0) {
    if (argc < 2 || args[0]->kind != SCR_DYN_STR) {
      sf_type_error("AbortSignal.addEventListener requires an event name");
      return NULL;
    }
    /* Web IDL's nullable EventListener argument: null is a no-op. */
    if (args[1]->kind == SCR_DYN_NULL ||
        args[1]->kind == SCR_DYN_UNDEF) {
      return scr_dyn_retain(scr_dyn_undefined());
    }
    if (!sf_abort_listener_value(args[1])) {
      sf_type_error(
          "AbortSignal.addEventListener listener must be a function, "
          "an object with handleEvent, or null");
      return NULL;
    }
    bool capture = false;
    bool once = false;
    SfSignal *option_signal = NULL;
    if (!sf_signal_listener_options(
            args, argc, &capture, &once, &option_signal)) {
      return NULL;
    }
    /* AbortSignal is an EventTarget: listeners for other event names are
     * valid registrations even though this target only dispatches abort. */
    if (!sf_name(args[0]->v.str->data, args[0]->v.str->len, "abort")) {
      return scr_dyn_retain(scr_dyn_undefined());
    }
    if (option_signal && option_signal->aborted) {
      return scr_dyn_retain(scr_dyn_undefined());
    }
    if (s->aborted) {
      /* An already-aborted signal never dispatches another abort event. */
      return scr_dyn_retain(scr_dyn_undefined());
    }
    SfAbortListener **tail = &s->listeners;
    while (*tail) {
      if ((*tail)->capture == capture &&
          scr_dyn_strict_eq((*tail)->listener, args[1])) {
        return scr_dyn_retain(scr_dyn_undefined());
      }
      tail = &(*tail)->next;
    }
    SfAbortListener *l = calloc(1, sizeof *l);
    if (!l) sf_oom();
    l->listener = scr_dyn_retain(args[1]);
    l->capture = capture;
    l->once = once;
    l->id = ++s->next_listener_id;
    l->target = s;
    l->option_signal =
        option_signal && option_signal != s
            ? sf_signal_retain(option_signal)
            : option_signal;
    *tail = l;
    if (option_signal) {
      l->signal_watch =
          sf_signal_watch(option_signal, l, &sf_listener_signal_abort);
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "removeEventListener") == 0) {
    if (argc >= 2 && args[0]->kind == SCR_DYN_STR &&
        sf_name(args[0]->v.str->data, args[0]->v.str->len, "abort")) {
      bool capture = false;
      bool once = false;
      (void)sf_signal_listener_options(
          args, argc, &capture, &once, NULL);
      (void)once;
      for (SfAbortListener **at = &s->listeners; *at; at = &(*at)->next) {
        if ((*at)->capture == capture &&
            scr_dyn_strict_eq((*at)->listener, args[1])) {
          SfAbortListener *l = *at;
          *at = l->next;
          sf_abort_listener_free(l);
          break;
        }
      }
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  (void)self;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_signal_get(void *ptr, const char *key, size_t len) {
  SfSignal *s = ptr;
  if (sf_name(key, len, "aborted")) return scr_dyn_new_bool(s->aborted);
  if (sf_name(key, len, "reason")) {
    return s->aborted ? scr_dyn_retain(s->reason)
                      : scr_dyn_retain(scr_dyn_undefined());
  }
  if (sf_name(key, len, "onabort")) {
    return s->onabort ? scr_dyn_retain(s->onabort) : scr_dyn_new_null();
  }
  return NULL;
}

static bool sf_signal_set(void *ptr, const char *key, size_t len,
                          const ScrDyn *value) {
  SfSignal *s = ptr;
  if (!sf_name(key, len, "onabort")) return false;
  if (value->kind != SCR_DYN_FUNC && value->kind != SCR_DYN_NULL &&
      value->kind != SCR_DYN_UNDEF) {
    sf_type_error("AbortSignal.onabort must be a function or null");
    return true;
  }
  bool had_handler = s->onabort != NULL;
  scr_dyn_release(s->onabort);
  if (value->kind == SCR_DYN_FUNC) {
    s->onabort = scr_dyn_retain((ScrDyn *)value);
    if (!had_handler) s->onabort_order = ++s->next_listener_id;
  } else {
    s->onabort = NULL;
    s->onabort_order = 0;
  }
  return true;
}

/* ── ReadableStream ──────────────────────────────────────────────── */

static SfStream *sf_stream_new_native(void) {
  SfStream *s = calloc(1, sizeof *s);
  if (!s) sf_oom();
  s->rc = 1;
  s->started = true;
  return s;
}

static SfStream *sf_stream_retain(SfStream *s) {
  s->rc++;
  return s;
}

static SfReader *sf_reader_retain(SfReader *r) {
  r->rc++;
  return r;
}

static SfReadRequest *sf_reader_take_request(SfReader *r) {
  SfReadRequest *request = r->pending_head;
  if (!request) return NULL;
  r->pending_head = request->next;
  if (!r->pending_head) r->pending_tail = NULL;
  request->next = NULL;
  return request;
}

static void sf_reader_reject_message_all(SfReader *r, const char *message) {
  SfReadRequest *request;
  while ((request = sf_reader_take_request(r)) != NULL) {
    sf_type_error(message);
    scr_promise_reject_pending(request->promise);
    scr_promise_release(request->promise);
    free(request);
  }
}

static void sf_reader_release(SfReader *r) {
  if (!r || --r->rc > 0) return;
  sf_reader_reject_message_all(r, "ReadableStream was released");
  scr_promise_release(r->closed);
  free(r);
}

static void sf_chunk_release(SfChunk *c) {
  if (!c) return;
  scr_dyn_release(c->value);
  free(c);
}

static void sf_stream_drop_chunks(SfStream *s) {
  while (s->head) {
    SfChunk *c = s->head;
    s->head = c->next;
    sf_chunk_release(c);
  }
  s->tail = NULL;
  s->queued = 0;
}

/*
 * The live transfer owns one stream reference. When every user-visible
 * Response/body/reader/collector reference is gone, only that transfer
 * reference remains. Stop queueing at that point and drain the wire so a
 * paused unread response cannot keep the process alive forever.
 *
 * A pending read remains a consumer even if its reader handle was dropped:
 * fulfill that request first, then reconsider from sf_stream_drain().
 */
static void sf_response_discard_if_unobserved(SfStream *s) {
  if (s->rc != 1 || s->discarded || !s->response_owner ||
      s->collector || (s->reader && s->reader->pending_head)) {
    return;
  }
  s->discarded = true;
  sf_stream_drop_chunks(s);
  SfTransfer *t = s->response_owner;
  if (!t->done && t->response_paused && t->response_socket) {
    t->response_paused = false;
    scr_net_sock_release(scr_net_sock_resume(t->response_socket));
  }
}

static void sf_stream_drop_source_callbacks(
    SfStream *s, bool include_cancel) {
  ScrDyn *pull = s->pull_cb;
  ScrDyn *cancel = include_cancel ? s->cancel_cb : NULL;
  s->pull_cb = NULL;
  if (include_cancel) s->cancel_cb = NULL;
  /* Unlink both edges before either closure release can re-enter through a
   * captured stream handle. */
  scr_dyn_release(pull);
  scr_dyn_release(cancel);
}

static void sf_stream_release(SfStream *s) {
  if (!s) return;
  if (--s->rc > 0) {
    sf_response_discard_if_unobserved(s);
    return;
  }
  sf_stream_drop_chunks(s);
  if (s->reader) {
    s->reader->stream = NULL;
    sf_reader_reject_message_all(s->reader, "ReadableStream was released");
    sf_reader_release(s->reader);
    s->reader = NULL;
  }
  scr_dyn_release(s->error);
  scr_dyn_release(s->pull_cb);
  scr_dyn_release(s->cancel_cb);
  scr_dyn_release(s->from_dyn);
  scr_arr_release(s->from_array);
  scr_bytes_release(s->from_bytes);
  scr_str_release(s->from_string);
  free(s);
}

static void *sf_stream_retain_v(void *p) {
  return sf_stream_retain((SfStream *)p);
}
static void sf_stream_release_v(void *p) {
  sf_stream_release((SfStream *)p);
}

/*
 * The stream owns its active reader so the lock survives loss of the
 * user-visible reader box. Conversely, every reader HANDLE retains the
 * stream while the lock is live. Keeping those two ownership classes
 * distinct avoids a permanent stream↔reader cycle while making chained
 * expressions such as `new ReadableStream(...).getReader()` safe.
 */
static void *sf_reader_handle_retain_v(void *p) {
  SfReader *r = p;
  sf_reader_retain(r);
  r->handle_refs++;
  if (r->stream) sf_stream_retain(r->stream);
  return r;
}

static void sf_reader_handle_release_v(void *p) {
  SfReader *r = p;
  SfStream *stream = r->stream;
  if (r->handle_refs > 0) r->handle_refs--;
  sf_reader_release(r);
  sf_stream_release(stream);
}

static ScrBytes *sf_chunk_bytes(const ScrDyn *chunk) {
  if (chunk && chunk->kind == SCR_DYN_TYPED_REF) {
    ScrDyn *materialized = scr_dyn_typed_ref_materialize(chunk);
    ScrBytes *bytes = sf_chunk_bytes(materialized);
    scr_dyn_release(materialized);
    return bytes;
  }
  if (chunk && chunk->kind == SCR_DYN_BYTES) {
    return scr_bytes_copy(chunk->v.bytes);
  }
  if (chunk && chunk->kind == SCR_DYN_STR) {
    ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)chunk->v.str->len);
    memcpy(b->data, chunk->v.str->data, chunk->v.str->len);
    return b;
  }
  sf_type_error("ReadableStream chunks must be Uint8Array or string values");
  return NULL;
}

static ScrDyn *sf_read_result(bool done, ScrDyn *value) {
  ScrDyn *result = scr_dyn_new_obj();
  scr_dyn_obj_set(result, "done", 4, scr_dyn_new_bool(done));
  scr_dyn_obj_set(result, "value", 5,
                  value ? scr_dyn_retain(value)
                        : scr_dyn_retain(scr_dyn_undefined()));
  return result;
}

static void sf_reader_fulfill_one(SfReader *r, bool done, ScrDyn *value) {
  if (!r) return;
  SfReadRequest *request = sf_reader_take_request(r);
  if (!request) return;
  scr_promise_fulfill_ref(request->promise, sf_read_result(done, value),
                          &scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_promise_release(request->promise);
  free(request);
}

static void sf_reader_reject_all(SfReader *r, ScrDyn *reason) {
  if (!r) return;
  SfReadRequest *request;
  while ((request = sf_reader_take_request(r)) != NULL) {
    sf_reject_promise_reason(request->promise, reason);
    scr_promise_release(request->promise);
    free(request);
  }
}

static void sf_collector_append(SfCollector *c, const ScrBytes *bytes) {
  if (bytes->len == 0) return;
  if (c->len > SIZE_MAX - bytes->len) sf_oom();
  size_t need = c->len + bytes->len;
  if (need > c->cap) {
    size_t cap = c->cap ? c->cap : 4096;
    while (cap < need) {
      if (cap > SIZE_MAX / 2) {
        cap = need;
        break;
      }
      cap *= 2;
    }
    char *next = realloc(c->data, cap);
    if (!next) sf_oom();
    c->data = next;
    c->cap = cap;
  }
  memcpy(c->data + c->len, bytes->data, bytes->len);
  c->len = need;
}

static void sf_collector_drop(SfStream *s) {
  SfCollector *c = s->collector;
  if (!c) return;
  s->collector = NULL;
  /*
   * Body-mixin consumption acquires a reader that is never exposed or
   * released. Keep that lock after text()/json()/bytes() settles: Node
   * reports response.body.locked === true and rejects a later getReader(),
   * on both fulfillment and rejection.
   */
  scr_promise_release(c->promise);
  free(c->data);
  SfStream *held = c->held_stream;
  free(c);
  sf_stream_release(held);
}

static void sf_collector_finish(SfStream *s) {
  SfCollector *c = s->collector;
  if (!c) return;
  ScrDyn *value = NULL;
  ScrBytes *bytes = scr_bytes_new(SCR_BYTES_U8, (double)c->len);
  if (c->len) memcpy(bytes->data, c->data, c->len);
  if (c->mode == SF_COLLECT_JSON) {
    ScrStr *text = scr_text_decode(bytes);
    value = scr_json_parse(text);
    scr_str_release(text);
  } else if (c->mode == SF_COLLECT_TEXT) {
    ScrStr *text = scr_text_decode(bytes);
    value = scr_dyn_new_str(text);
    scr_str_release(text);
  } else {
    value = scr_dyn_new_bytes_copy(bytes);
  }
  scr_bytes_release(bytes);
  if (scr_exc_pending()) {
    scr_dyn_release(value);
    scr_promise_reject_pending(c->promise);
  } else {
    scr_promise_fulfill_ref(c->promise, value, &scr_dyn_retain_v,
                            &scr_dyn_release_v, NULL);
  }
  sf_collector_drop(s);
}

static void sf_collector_reject(SfStream *s, ScrDyn *reason) {
  if (!s->collector) return;
  sf_reject_promise_reason(s->collector->promise, reason);
  sf_collector_drop(s);
}

static void sf_stream_request_flush(SfStream *s);
static void sf_transfer_stream_error(SfTransfer *t, ScrDyn *reason);
static void sf_settle(SfTransfer *t);
static void sf_stream_pull(SfStream *s);
static void sf_stream_schedule_initial_pull(SfStream *s);

/*
 * A default ReadableStream has a one-chunk high-water mark. Apply that
 * bound to the transport itself: pausing the IncomingMessage only moves
 * bytes into its parser-side buffer, while pausing the socket leaves them
 * in the kernel/TCP window. resume() merely re-arms the poller, so calling
 * it while satisfying a read never re-enters this stack.
 */
static void sf_response_pause_if_full(SfStream *s) {
  SfTransfer *t = s->response_owner;
  if (s->discarded || !t || t->done || t->response_paused ||
      !t->response_socket ||
      s->queued < 1) {
    return;
  }
  t->response_paused = true;
  scr_net_sock_release(scr_net_sock_pause(t->response_socket));
}

static void sf_response_resume_if_ready(SfStream *s) {
  SfTransfer *t = s->response_owner;
  if (!t || t->done || !t->response_paused || !t->response_socket ||
      s->queued >= 1 || s->close_requested || s->closed || s->error) {
    return;
  }
  t->response_paused = false;
  scr_net_sock_release(scr_net_sock_resume(t->response_socket));
}

static void sf_stream_finish_close(SfStream *s) {
  if (!s->close_requested || s->head || s->closed || s->error) return;
  s->closed = true;
  sf_stream_drop_source_callbacks(s, true);
  if (s->reader) scr_promise_fulfill_void(s->reader->closed);
}

static void sf_stream_drain(SfStream *s) {
  if (!s->started) return;
  if (s->request_owner) {
    sf_stream_request_flush(s);
    return;
  }
  if (s->collector) {
    while (s->head) {
      SfChunk *c = s->head;
      s->head = c->next;
      if (!s->head) s->tail = NULL;
      s->queued--;
      ScrBytes *bytes = sf_chunk_bytes(c->value);
      if (!bytes) {
        sf_chunk_release(c);
        scr_promise_reject_pending(s->collector->promise);
        sf_collector_drop(s);
        sf_stream_drop_chunks(s);
        return;
      }
      sf_collector_append(s->collector, bytes);
      scr_bytes_release(bytes);
      sf_chunk_release(c);
    }
    sf_stream_finish_close(s);
    sf_response_resume_if_ready(s);
    if (s->error) sf_collector_reject(s, s->error);
    else if (s->closed) sf_collector_finish(s);
    return;
  }
  if (s->reader) {
    bool dequeued = false;
    while (s->reader->pending_head && s->head) {
      SfChunk *c = s->head;
      s->head = c->next;
      if (!s->head) s->tail = NULL;
      s->queued--;
      dequeued = true;
      sf_reader_fulfill_one(s->reader, false, c->value);
      sf_chunk_release(c);
    }
    sf_stream_finish_close(s);
    if (s->error) {
      sf_reader_reject_all(s->reader, s->error);
    } else if (s->closed) {
      while (s->reader->pending_head) {
        sf_reader_fulfill_one(s->reader, true, NULL);
      }
    }
    /* Consuming the last queued chunk raises desiredSize above zero even
     * when no read request remains. That transition is fresh demand and
     * must replenish the queue up to its default high-water mark. */
    if (dequeued && !s->enqueue_draining && !s->head &&
        !s->close_requested && !s->closed && !s->error) {
      sf_stream_pull(s);
    }
    sf_response_resume_if_ready(s);
    sf_response_discard_if_unobserved(s);
    return;
  }
  sf_stream_finish_close(s);
  sf_response_resume_if_ready(s);
}

static void sf_stream_enqueue_value(SfStream *s, ScrDyn *value) {
  if (s->close_requested || s->closed || s->error) {
    sf_type_error("Invalid state: the ReadableStream is already closed");
    return;
  }
  SfChunk *c = calloc(1, sizeof *c);
  if (!c) sf_oom();
  c->value = scr_dyn_retain(value);
  if (s->tail) s->tail->next = c;
  else s->head = c;
  s->tail = c;
  s->queued++;
  bool was_enqueue_draining = s->enqueue_draining;
  s->enqueue_draining = true;
  sf_stream_drain(s);
  s->enqueue_draining = was_enqueue_draining;
  /* Enqueue is the event that can create fresh demand after a deferred
   * pull. Merely having a waiting reader/request is not: looping on that
   * state re-enters pull synchronously and starves timers. */
  if (
    s->started &&
    !s->close_requested &&
    !s->closed &&
    !s->error &&
    (s->request_owner || (s->reader && s->reader->pending_head) || !s->head)
  ) {
    sf_stream_pull(s);
  }
  sf_response_pause_if_full(s);
}

static void sf_stream_enqueue_bytes(SfStream *s, ScrBytes *bytes) {
  ScrDyn *value = scr_dyn_new_bytes_copy(bytes);
  sf_stream_enqueue_value(s, value);
  scr_dyn_release(value);
}

static void sf_stream_close(SfStream *s) {
  if (s->close_requested || s->closed || s->error) return;
  s->close_requested = true;
  /* pull can never run again once close is requested. Keep cancel until
   * the queued tail drains because cancel() may still invoke it. */
  sf_stream_drop_source_callbacks(s, false);
  sf_stream_drain(s);
  sf_stream_finish_close(s);
}

static void sf_stream_error(SfStream *s, ScrDyn *reason) {
  if (s->closed || s->error) return;
  s->error = scr_dyn_retain(reason);
  sf_stream_drop_chunks(s);
  sf_stream_drain(s);
  if (s->reader) {
    sf_reject_promise_reason(s->reader->closed, reason);
  }
  if (s->request_owner) {
    sf_transfer_stream_error(s->request_owner, reason);
  }
  sf_stream_drop_source_callbacks(s, true);
}

/* Web Streams adopts promise-like results from start/pull/cancel through
 * PromiseResolve, not merely native Promise instances. Keep that adoption
 * local to this surface: the checked-dynamic language intentionally does
 * not otherwise assimilate arbitrary objects carrying a `then` member. */
static SfThenState *sf_then_state_retain(SfThenState *state) {
  state->rc++;
  return state;
}

static void sf_then_state_release(SfThenState *state) {
  if (--state->rc > 0) return;
  scr_promise_release(state->promise);
  free(state);
}

static void *sf_then_state_retain_v(void *ptr) {
  return sf_then_state_retain((SfThenState *)ptr);
}

static void sf_then_state_release_v(void *ptr) {
  sf_then_state_release((SfThenState *)ptr);
}

static ScrBox *sf_then_state_box(SfThenState *state) {
  ScrBox *box = scr_box_new_obj(
      &sf_then_state_retain_v, &sf_then_state_release_v, NULL);
  scr_box_set_ref(box, sf_then_state_retain(state));
  return box;
}

static void sf_then_adopt(ScrPromise *target, ScrDyn *value);

static ScrDyn *sf_then_resolve_thunk(
    ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  SfThenState *state = (SfThenState *)scr_box_get_ref(cb->caps[0]);
  if (!state->called) {
    state->called = true;
    sf_then_adopt(
        state->promise, argc ? args[0] : scr_dyn_undefined());
  }
  sf_then_state_release(state);
  return scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *sf_then_reject_thunk(
    ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  SfThenState *state = (SfThenState *)scr_box_get_ref(cb->caps[0]);
  if (!state->called) {
    state->called = true;
    sf_reject_promise_reason(
        state->promise, argc ? args[0] : scr_dyn_undefined());
  }
  sf_then_state_release(state);
  return scr_dyn_retain(scr_dyn_undefined());
}

static void sf_then_call_task(ScrClosure *cb) {
  SfThenState *state = (SfThenState *)scr_box_get_ref(cb->caps[0]);
  ScrDyn *thenable = (ScrDyn *)scr_box_get_ref(cb->caps[1]);
  ScrDyn *then_fn = (ScrDyn *)scr_box_get_ref(cb->caps[2]);

  ScrClosure *resolve_cb =
      scr_closure_new((void *)&sf_then_resolve_thunk, 1);
  resolve_cb->caps[0] = sf_then_state_box(state);
  ScrDyn *resolve = scr_dyn_new_func(
      resolve_cb, &sf_then_resolve_thunk, 1, "(value)", "resolve");

  ScrClosure *reject_cb =
      scr_closure_new((void *)&sf_then_reject_thunk, 1);
  reject_cb->caps[0] = sf_then_state_box(state);
  ScrDyn *reject = scr_dyn_new_func(
      reject_cb, &sf_then_reject_thunk, 1, "(reason)", "reject");

  ScrDyn *args[2] = {resolve, reject};
  scr_dyn_this_push_dyn(thenable);
  ScrDyn *result =
      scr_dyn_call(then_fn, args, 2, "thenable.then");
  scr_dyn_this_pop();
  if (result) {
    scr_dyn_release(result);
  } else if (!state->called) {
    state->called = true;
    scr_promise_reject_pending(state->promise);
  } else {
    /* A throw after either resolving function ran is ignored. */
    scr_exc_clear();
  }

  scr_dyn_release(resolve);
  scr_dyn_release(reject);
  scr_dyn_release(then_fn);
  scr_dyn_release(thenable);
  sf_then_state_release(state);
}

static void sf_then_schedule(
    ScrPromise *target, ScrDyn *thenable, ScrDyn *then_fn) {
  SfThenState *state = calloc(1, sizeof *state);
  if (!state) sf_oom();
  state->rc = 1;
  state->promise = scr_promise_retain(target);

  ScrClosure *task =
      scr_closure_new((void *)&sf_then_call_task, 3);
  task->caps[0] = sf_then_state_box(state);
  task->caps[1] =
      scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_box_set_ref(task->caps[1], scr_dyn_retain(thenable));
  task->caps[2] =
      scr_box_new_obj(&scr_dyn_retain_v, &scr_dyn_release_v, NULL);
  scr_box_set_ref(task->caps[2], scr_dyn_retain(then_fn));
  sf_then_state_release(state);
  scr_queue_microtask(task);
}

static void sf_then_adopt(ScrPromise *target, ScrDyn *value) {
  if (value->kind == SCR_DYN_PROMISE) {
    scr_promise_race_add(
        target, value->v.promise, &scr_promise_adapt_copy);
    return;
  }
  if (value->kind == SCR_DYN_OBJ) {
    const ScrDyn *then_fn = scr_dyn_obj_get(value, "then", 4);
    if (then_fn && then_fn->kind == SCR_DYN_FUNC) {
      sf_then_schedule(target, value, (ScrDyn *)then_fn);
      return;
    }
  }
  scr_promise_fulfill_ref(
      target, scr_dyn_retain(value), &scr_dyn_retain_v,
      &scr_dyn_release_v, NULL);
}

/* +1 when the callback result must be awaited; NULL for a plain value. */
static ScrPromise *sf_stream_callback_promise(ScrDyn *value) {
  if (value->kind == SCR_DYN_PROMISE) {
    return scr_promise_retain(value->v.promise);
  }
  if (value->kind != SCR_DYN_OBJ) return NULL;
  const ScrDyn *then_fn = scr_dyn_obj_get(value, "then", 4);
  if (!then_fn || then_fn->kind != SCR_DYN_FUNC) return NULL;
  ScrPromise *promise = scr_promise_new();
  sf_then_schedule(promise, value, (ScrDyn *)then_fn);
  return promise;
}

static void sf_stream_pull_wait_entry(ScrFiber *self, void *arg) {
  (void)self;
  SfPullWait *wait = arg;
  SfStream *s = wait->stream;
  ScrDyn *value = scr_await_dyn(wait->promise);
  bool rejected = scr_exc_pending();
  ScrCaught *caught = rejected ? scr_exc_take() : NULL;
  scr_dyn_release(value);
  scr_promise_release(wait->promise);
  free(wait);

  s->pulling = false;
  if (rejected) {
    s->pull_again = false;
    ScrDyn *reason = scr_caught_to_dyn(caught);
    sf_stream_error(s, reason);
    scr_dyn_release(reason);
  } else {
    bool again = s->pull_again;
    s->pull_again = false;
    if (again && !s->close_requested && !s->closed && !s->error) {
      sf_stream_pull(s);
    }
  }
  scr_caught_release(caught);
  sf_stream_release(s);
}

static void sf_stream_start_wait_entry(ScrFiber *self, void *arg) {
  (void)self;
  SfStartWait *wait = arg;
  SfStream *s = wait->stream;
  ScrDyn *value = scr_await_dyn(wait->promise);
  bool rejected = scr_exc_pending();
  ScrCaught *caught = rejected ? scr_exc_take() : NULL;
  scr_dyn_release(value);
  scr_promise_release(wait->promise);
  free(wait);

  if (rejected) {
    ScrDyn *reason = scr_caught_to_dyn(caught);
    sf_stream_error(s, reason);
    scr_dyn_release(reason);
  } else {
    s->started = true;
    sf_stream_drain(s);
    if (!s->close_requested && !s->closed && !s->error &&
        s->queued == 0) {
      sf_stream_pull(s);
      sf_stream_drain(s);
    }
  }
  scr_caught_release(caught);
  sf_stream_release(s);
}

static ScrDyn *sf_controller_box(SfStream *s) {
  return scr_dyn_new_handle(s, SCR_DYNH_WEB_CONTROLLER);
}

static bool sf_stream_has_from_source(const SfStream *s) {
  return s->from_dyn || s->from_array || s->from_bytes || s->from_string;
}

static void sf_stream_pull_from_source(SfStream *s) {
  ScrDyn *value = NULL;
  if (s->from_array) {
    if (s->from_index >= scr_arr_len(s->from_array)) {
      sf_stream_close(s);
      return;
    }
    value = s->from_array_item(s->from_array, s->from_index++);
  } else if (s->from_bytes) {
    if (s->from_index >= scr_bytes_len(s->from_bytes)) {
      sf_stream_close(s);
      return;
    }
    value = scr_dyn_new_num(
        scr_bytes_get(s->from_bytes, s->from_index++));
  } else if (s->from_string) {
    double len = scr_str_utf16_len(s->from_string);
    if (s->from_index >= len) {
      sf_stream_close(s);
      return;
    }
    ScrStr *cp = scr_str_cp_at(s->from_string, s->from_index);
    s->from_index += scr_str_utf16_len(cp);
    value = scr_dyn_new_str(cp);
    scr_str_release(cp);
  } else if (s->from_dyn->kind == SCR_DYN_ARR) {
    if (s->from_index >= (double)s->from_dyn->v.arr.len) {
      sf_stream_close(s);
      return;
    }
    value = scr_dyn_retain(
        s->from_dyn->v.arr.items[(size_t)s->from_index++]);
  } else if (s->from_dyn->kind == SCR_DYN_BYTES) {
    if (s->from_index >= scr_bytes_len(s->from_dyn->v.bytes)) {
      sf_stream_close(s);
      return;
    }
    value = scr_dyn_new_num(
        scr_bytes_get(s->from_dyn->v.bytes, s->from_index++));
  } else {
    double len = scr_str_utf16_len(s->from_dyn->v.str);
    if (s->from_index >= len) {
      sf_stream_close(s);
      return;
    }
    ScrStr *cp = scr_str_cp_at(s->from_dyn->v.str, s->from_index);
    s->from_index += scr_str_utf16_len(cp);
    value = scr_dyn_new_str(cp);
    scr_str_release(cp);
  }
  sf_stream_enqueue_value(s, value);
  scr_dyn_release(value);
}

static void sf_stream_initial_pull_task(ScrClosure *cb) {
  SfStream *s = (SfStream *)scr_box_get_ref(cb->caps[0]);
  if (!s) return;
  s->initial_pull_pending = false;
  if (s->started && !s->close_requested && !s->closed && !s->error &&
      s->queued == 0) {
    sf_stream_pull(s);
    sf_stream_drain(s);
  }
  sf_stream_release(s);
}

static void sf_stream_schedule_initial_pull(SfStream *s) {
  if ((!s->pull_cb && !sf_stream_has_from_source(s)) ||
      s->initial_pull_pending || s->close_requested || s->closed ||
      s->error) {
    return;
  }
  s->initial_pull_pending = true;
  ScrClosure *cb =
      scr_closure_new((void *)&sf_stream_initial_pull_task, 1);
  ScrBox *box =
      scr_box_new_obj(&sf_stream_retain_v, &sf_stream_release_v, NULL);
  scr_box_set_ref(box, sf_stream_retain(s));
  cb->caps[0] = box;
  scr_queue_microtask(cb);
}

static void sf_stream_pull(SfStream *s) {
  if (!s->started ||
      (!s->pull_cb && !sf_stream_has_from_source(s)) ||
      s->initial_pull_pending || s->close_requested || s->closed ||
      s->error) {
    return;
  }
  if (s->pulling) {
    s->pull_again = true;
    return;
  }
  if (sf_stream_has_from_source(s)) {
    for (;;) {
      s->pulling = true;
      sf_stream_pull_from_source(s);
      s->pulling = false;
      bool again = s->pull_again;
      s->pull_again = false;
      if (!again || s->close_requested || s->closed || s->error) return;
    }
  }
  for (;;) {
    s->pulling = true;
    ScrDyn *controller = sf_controller_box(s);
    ScrDyn *args[1] = {controller};
    ScrDyn *pull_cb = scr_dyn_retain(s->pull_cb);
    ScrDyn *r =
        scr_dyn_call(pull_cb, args, 1, "underlyingSource.pull");
    scr_dyn_release(pull_cb);
    scr_dyn_release(controller);
    if (!r) {
      s->pulling = false;
      s->pull_again = false;
      ScrCaught *caught = scr_exc_take();
      ScrDyn *reason = scr_caught_to_dyn(caught);
      sf_stream_error(s, reason);
      scr_dyn_release(reason);
      scr_caught_release(caught);
      return;
    }
    ScrPromise *callback_promise = sf_stream_callback_promise(r);
    if (callback_promise) {
      SfPullWait *wait = malloc(sizeof *wait);
      if (!wait) sf_oom();
      wait->stream = sf_stream_retain(s);
      wait->promise = callback_promise;
      ScrPromise *watcher =
          scr_async_spawn(&sf_stream_pull_wait_entry, wait);
      scr_promise_release(watcher);
      scr_dyn_release(r);
      return;
    }
    scr_dyn_release(r);
    s->pulling = false;
    bool again = s->pull_again;
    s->pull_again = false;
    if (!again || s->close_requested || s->closed || s->error) return;
  }
}

static SfReader *sf_stream_get_reader(SfStream *s) {
  if (s->reader || s->internal_lock) {
    sf_type_error("Invalid state: ReadableStream is locked");
    return NULL;
  }
  SfReader *r = calloc(1, sizeof *r);
  if (!r) sf_oom();
  r->rc = 1;
  r->stream = s;
  r->closed = scr_promise_new();
  /* A reader's internal closed capability never reports as an unhandled
   * rejection merely because user code does not read the property. */
  scr_promise_mark_handled(r->closed);
  if (s->closed) scr_promise_fulfill_void(r->closed);
  else if (s->error) sf_reject_promise_reason(r->closed, s->error);
  s->reader = sf_reader_retain(r);
  return r;
}

static ScrPromise *sf_reader_read(SfReader *r) {
  ScrPromise *p = scr_promise_new();
  SfStream *s = r->stream;
  if (!s || s->reader != r) {
    sf_type_error("This reader has been released");
    scr_promise_reject_pending(p);
    return p;
  }
  s->disturbed = true;
  SfReadRequest *request = calloc(1, sizeof *request);
  if (!request) sf_oom();
  request->promise = scr_promise_retain(p);
  if (r->pending_tail) r->pending_tail->next = request;
  else r->pending_head = request;
  r->pending_tail = request;
  sf_stream_drain(s);
  if (r->pending_head && !s->head && !s->closed && !s->error) {
    sf_stream_pull(s);
    sf_stream_drain(s);
  }
  return p;
}

static void sf_reader_release_lock(SfReader *r) {
  SfStream *s = r->stream;
  if (!s || s->reader != r) return;

  ScrPromise *old_closed = r->closed;
  if (!s->closed && !s->error) {
    sf_type_error("Invalid state: Reader released");
    scr_promise_reject_pending(old_closed);
  } else {
    r->closed = scr_promise_new();
    scr_promise_mark_handled(r->closed);
    sf_type_error("Invalid state: Reader released");
    scr_promise_reject_pending(r->closed);
    scr_promise_release(old_closed);
  }

  sf_reader_reject_message_all(r, "Invalid state: Releasing reader");

  size_t handle_refs = r->handle_refs;
  s->reader = NULL;
  r->stream = NULL;
  sf_reader_release(r); /* stream's ownership */
  while (handle_refs-- > 0) sf_stream_release(s);
}

static void sf_stream_cancel_wait_entry(ScrFiber *self, void *arg) {
  (void)self;
  SfCancelWait *wait = arg;
  ScrDyn *value = scr_await_dyn(wait->source);
  bool rejected = scr_exc_pending();
  ScrCaught *caught = rejected ? scr_exc_take() : NULL;
  scr_dyn_release(value);
  if (rejected) {
    ScrDyn *reason = scr_caught_to_dyn(caught);
    sf_reject_promise_reason(wait->result, reason);
    scr_dyn_release(reason);
  } else {
    scr_promise_fulfill_void(wait->result);
  }
  scr_caught_release(caught);
  scr_promise_release(wait->source);
  scr_promise_release(wait->result);
  free(wait);
}

static ScrPromise *sf_stream_cancel(SfStream *s, ScrDyn *reason,
                                    bool through_reader) {
  ScrPromise *p = scr_promise_new();
  if (!through_reader && (s->reader || s->internal_lock)) {
    sf_type_error("Invalid state: cannot cancel a locked ReadableStream");
    scr_promise_reject_pending(p);
    return p;
  }
  /*
   * ReadableStreamCancel disturbs the stream before inspecting its state.
   * This remains observable through Response.bodyUsed even when the
   * stream had already closed or errored.
   */
  s->disturbed = true;
  if (s->closed) {
    /* WHATWG cancel is a no-op once the stream is closed. */
    scr_promise_fulfill_void(p);
    return p;
  }
  if (s->error) {
    /* An errored stream preserves and rejects with its stored reason. */
    sf_reject_promise_reason(p, s->error);
    return p;
  }
  ScrDyn *cancel_cb =
      s->cancel_cb ? scr_dyn_retain(s->cancel_cb) : NULL;
  sf_stream_drop_chunks(s);
  SfTransfer *response_owner = s->response_owner;
  if (response_owner && response_owner->client) {
    scr_http_client_destroy(response_owner->client);
  }
  if (s->close_requested) sf_stream_finish_close(s);
  else sf_stream_close(s);
  if (response_owner && !response_owner->done) sf_settle(response_owner);

  if (cancel_cb) {
    ScrDyn *args[1] = {reason ? reason : scr_dyn_undefined()};
    ScrDyn *r =
        scr_dyn_call(cancel_cb, args, 1, "underlyingSource.cancel");
    scr_dyn_release(cancel_cb);
    if (!r) {
      scr_promise_reject_pending(p);
      return p;
    }
    ScrPromise *callback_promise = sf_stream_callback_promise(r);
    if (callback_promise) {
      SfCancelWait *wait = malloc(sizeof *wait);
      if (!wait) sf_oom();
      wait->source = callback_promise;
      wait->result = scr_promise_retain(p);
      ScrPromise *watcher =
          scr_async_spawn(&sf_stream_cancel_wait_entry, wait);
      scr_promise_release(watcher);
      scr_dyn_release(r);
      return p;
    }
    scr_dyn_release(r);
  } else {
    scr_dyn_release(cancel_cb);
  }
  scr_promise_fulfill_void(p);
  return p;
}

static ScrPromise *sf_stream_collect(SfStream *s, int mode) {
  ScrPromise *p = scr_promise_new();
  if (s->disturbed || s->reader || s->internal_lock) {
    sf_type_error("Body is unusable: Body has already been read");
    scr_promise_reject_pending(p);
    return p;
  }
  s->disturbed = true;
  s->internal_lock = true;
  SfCollector *c = calloc(1, sizeof *c);
  if (!c) sf_oom();
  c->promise = scr_promise_retain(p);
  c->held_stream = sf_stream_retain(s);
  c->mode = mode;
  s->collector = c;
  sf_stream_drain(s);
  return p;
}

ScrDyn *scr_fetch_stream_new(ScrDyn *source) {
  if (source && source->kind != SCR_DYN_UNDEF &&
      source->kind != SCR_DYN_NULL && source->kind != SCR_DYN_OBJ) {
    sf_type_error("ReadableStream source must be an object");
    return NULL;
  }
  SfStream *s = sf_stream_new_native();
  if (source && source->kind == SCR_DYN_OBJ) {
    const ScrDyn *type = scr_dyn_obj_get(source, "type", 4);
    if (type && type->kind != SCR_DYN_UNDEF) {
      sf_stream_release(s);
      sf_type_error("byte streams are not supported by static ReadableStream");
      return NULL;
    }
    const ScrDyn *pull = scr_dyn_obj_get(source, "pull", 4);
    const ScrDyn *cancel = scr_dyn_obj_get(source, "cancel", 6);
    const ScrDyn *start = scr_dyn_obj_get(source, "start", 5);
    if (pull && pull->kind != SCR_DYN_UNDEF) {
      if (pull->kind != SCR_DYN_FUNC) {
        sf_stream_release(s);
        sf_type_error("ReadableStream source.pull must be a function");
        return NULL;
      }
      s->pull_cb = scr_dyn_retain((ScrDyn *)pull);
    }
    if (cancel && cancel->kind != SCR_DYN_UNDEF) {
      if (cancel->kind != SCR_DYN_FUNC) {
        sf_stream_release(s);
        sf_type_error("ReadableStream source.cancel must be a function");
        return NULL;
      }
      s->cancel_cb = scr_dyn_retain((ScrDyn *)cancel);
    }
    if (start && start->kind != SCR_DYN_UNDEF) {
      if (start->kind != SCR_DYN_FUNC) {
        sf_stream_release(s);
        sf_type_error("ReadableStream source.start must be a function");
        return NULL;
      }
      s->started = false;
      ScrDyn *controller = sf_controller_box(s);
      ScrDyn *args[1] = {controller};
      ScrDyn *r =
          scr_dyn_call((ScrDyn *)start, args, 1, "underlyingSource.start");
      scr_dyn_release(controller);
      if (!r) {
        sf_stream_release(s);
        return NULL;
      }
      ScrPromise *callback_promise = sf_stream_callback_promise(r);
      if (callback_promise) {
        SfStartWait *wait = malloc(sizeof *wait);
        if (!wait) sf_oom();
        wait->stream = sf_stream_retain(s);
        wait->promise = callback_promise;
        ScrPromise *watcher =
            scr_async_spawn(&sf_stream_start_wait_entry, wait);
        scr_promise_release(watcher);
      } else {
        s->started = true;
      }
      scr_dyn_release(r);
    }
  }
  if (s->started) sf_stream_schedule_initial_pull(s);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_WEB_STREAM);
  sf_stream_release(s);
  return out;
}

ScrDyn *scr_fetch_stream_from(ScrDyn *iterable) {
  if (!iterable) {
    sf_type_error("ReadableStream.from requires an iterable");
    return NULL;
  }
  if (iterable->kind != SCR_DYN_ARR &&
       iterable->kind != SCR_DYN_BYTES &&
       iterable->kind != SCR_DYN_STR &&
       iterable->kind != SCR_DYN_JSVAL) {
    /* Reuse the checked-dynamic iterable error wording. */
    ScrDyn *packed = scr_dyn_iter_pack(iterable, NULL);
    scr_dyn_release(packed);
    return NULL;
  }
  ScrDyn *source = iterable;
  if (iterable->kind == SCR_DYN_JSVAL) {
    /* Static builds do not normally carry engine values. If one reaches
     * this fallback, validate/drain it through the engine once; native
     * arrays/bytes/strings retain their live container below. */
    source = scr_dyn_iter_pack(iterable, NULL);
    if (!source) return NULL;
  }
  SfStream *s = sf_stream_new_native();
  s->from_dyn = scr_dyn_retain(source);
  sf_stream_schedule_initial_pull(s);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_WEB_STREAM);
  sf_stream_release(s);
  if (source != iterable) scr_dyn_release(source);
  return out;
}

ScrDyn *scr_fetch_stream_from_array(
    ScrArr *iterable, ScrDyn *(*item)(ScrArr *, double)) {
  SfStream *s = sf_stream_new_native();
  s->from_array = scr_arr_retain(iterable);
  s->from_array_item = item;
  sf_stream_schedule_initial_pull(s);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_WEB_STREAM);
  sf_stream_release(s);
  return out;
}

ScrDyn *scr_fetch_stream_from_bytes(ScrBytes *iterable) {
  SfStream *s = sf_stream_new_native();
  s->from_bytes = scr_bytes_retain(iterable);
  sf_stream_schedule_initial_pull(s);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_WEB_STREAM);
  sf_stream_release(s);
  return out;
}

ScrDyn *scr_fetch_stream_from_string(ScrStr *iterable) {
  SfStream *s = sf_stream_new_native();
  s->from_string = scr_str_retain(iterable);
  sf_stream_schedule_initial_pull(s);
  ScrDyn *out = scr_dyn_new_handle(s, SCR_DYNH_WEB_STREAM);
  sf_stream_release(s);
  return out;
}

ScrPromise *scr_fetch_reader_read(ScrDyn *reader) {
  if (!reader || reader->kind != SCR_DYN_HANDLE ||
      reader->v.handle.tag != SCR_DYNH_WEB_READER) {
    sf_type_error("Expected a ReadableStreamDefaultReader");
    ScrPromise *p = scr_promise_new();
    scr_promise_reject_pending(p);
    return p;
  }
  return sf_reader_read((SfReader *)reader->v.handle.ptr);
}

static SfStream *sf_stream_of(const ScrDyn *d) {
  if (!d || d->kind != SCR_DYN_HANDLE ||
      d->v.handle.tag != SCR_DYNH_WEB_STREAM) {
    sf_type_error("Expected a ReadableStream");
    return NULL;
  }
  return (SfStream *)d->v.handle.ptr;
}

static ScrDyn *sf_stream_invoke(void *ptr, ScrDyn *self, const char *method,
                                ScrDyn *const *args, size_t argc,
                                const char *what) {
  SfStream *s = ptr;
  if (strcmp(method, "getReader") == 0) {
    if (argc != 0) {
      sf_type_error("BYOB readers are not supported");
      return NULL;
    }
    SfReader *r = sf_stream_get_reader(s);
    if (!r) return NULL;
    ScrDyn *out = scr_dyn_new_handle(r, SCR_DYNH_WEB_READER);
    sf_reader_release(r);
    return out;
  }
  if (strcmp(method, "cancel") == 0) {
    ScrPromise *p =
        sf_stream_cancel(s, argc ? args[0] : scr_dyn_undefined(), false);
    ScrDyn *out = scr_dyn_new_promise(p);
    scr_promise_release(p);
    return out;
  }
  (void)self;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_stream_get(void *ptr, const char *key, size_t len) {
  SfStream *s = ptr;
  if (sf_name(key, len, "locked")) {
    return scr_dyn_new_bool(s->reader != NULL || s->internal_lock);
  }
  return NULL;
}

static ScrDyn *sf_reader_invoke(void *ptr, ScrDyn *self, const char *method,
                                ScrDyn *const *args, size_t argc,
                                const char *what) {
  SfReader *r = ptr;
  if (strcmp(method, "read") == 0) {
    if (argc != 0) {
      sf_type_error("ReadableStreamDefaultReader.read takes no arguments");
      return NULL;
    }
    ScrPromise *p = sf_reader_read(r);
    ScrDyn *out = scr_dyn_new_promise(p);
    scr_promise_release(p);
    return out;
  }
  if (strcmp(method, "cancel") == 0) {
    ScrPromise *p;
    if (!r->stream) {
      sf_type_error("This reader has been released");
      p = scr_promise_new();
      scr_promise_reject_pending(p);
    } else {
      p = sf_stream_cancel(
          r->stream, argc ? args[0] : scr_dyn_undefined(), true);
    }
    ScrDyn *out = scr_dyn_new_promise(p);
    scr_promise_release(p);
    return out;
  }
  if (strcmp(method, "releaseLock") == 0) {
    sf_reader_release_lock(r);
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  (void)self;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_reader_get(void *ptr, const char *key, size_t len) {
  SfReader *r = ptr;
  if (sf_name(key, len, "closed")) return scr_dyn_new_promise(r->closed);
  return NULL;
}

static ScrDyn *sf_controller_invoke(void *ptr, ScrDyn *self,
                                    const char *method,
                                    ScrDyn *const *args, size_t argc,
                                    const char *what) {
  SfStream *s = ptr;
  if (strcmp(method, "enqueue") == 0) {
    sf_stream_enqueue_value(
        s, argc ? args[0] : scr_dyn_undefined());
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "close") == 0) {
    if (s->close_requested || s->closed || s->error) {
      sf_type_error("Invalid state: Controller is already closed");
      return NULL;
    }
    sf_stream_close(s);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "error") == 0) {
    sf_stream_error(s, argc ? args[0] : scr_dyn_undefined());
    return scr_dyn_retain(scr_dyn_undefined());
  }
  (void)self;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_controller_get(void *ptr, const char *key, size_t len) {
  SfStream *s = ptr;
  if (sf_name(key, len, "desiredSize")) {
    if (s->error) return scr_dyn_new_null();
    if (s->closed) return scr_dyn_new_num(0);
    return scr_dyn_new_num(1.0 - (double)s->queued);
  }
  return NULL;
}

/* ── Headers ─────────────────────────────────────────────────────── */

static bool sf_header_name_ok(const char *s, size_t len);

static SfHeaders *sf_headers_new(ScrArr *pairs) {
  SfHeaders *h = calloc(1, sizeof *h);
  if (!h) sf_oom();
  h->rc = 1;
  h->pairs = pairs;
  return h;
}

static SfHeaders *sf_headers_retain(SfHeaders *h) {
  h->rc++;
  return h;
}

static void sf_headers_release(SfHeaders *h) {
  if (!h || --h->rc > 0) return;
  scr_arr_release(h->pairs);
  free(h);
}

static void *sf_headers_retain_v(void *p) {
  return sf_headers_retain((SfHeaders *)p);
}

static void sf_headers_release_v(void *p) {
  sf_headers_release((SfHeaders *)p);
}

static ScrStr *sf_headers_name(const ScrDyn *value) {
  ScrStr *raw =
      scr_dyn_string_coerce(value ? value : scr_dyn_undefined());
  if (!raw) return NULL;
  if (!sf_header_name_ok(raw->data, raw->len)) {
    scr_str_release(raw);
    sf_type_error("Headers: invalid header name");
    return NULL;
  }
  char *lower = malloc(raw->len);
  if (!lower) sf_oom();
  for (size_t i = 0; i < raw->len; i++) {
    char c = raw->data[i];
    lower[i] =
        c >= 'A' && c <= 'Z' ? (char)(c - 'A' + 'a') : c;
  }
  ScrStr *out = scr_str_new(lower, raw->len);
  free(lower);
  scr_str_release(raw);
  return out;
}

static bool sf_headers_key_eq(const ScrStr *left, const ScrStr *right) {
  return left->len == right->len &&
         memcmp(left->data, right->data, left->len) == 0;
}

static ScrStr *sf_headers_get_value(SfHeaders *h, const ScrStr *name) {
  size_t n = (size_t)scr_arr_len(h->pairs);
  size_t count = 0;
  size_t total = 0;
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *key = scr_arr_get_ref(h->pairs, (double)i);
    ScrStr *value = scr_arr_get_ref(h->pairs, (double)(i + 1));
    if (sf_headers_key_eq(key, name)) {
      if (count > 0) total += 2;
      total += value->len;
      count++;
    }
    scr_str_release(key);
    scr_str_release(value);
  }
  if (count == 0) return NULL;

  char *joined = malloc(total > 0 ? total : 1);
  if (!joined) sf_oom();
  size_t at = 0;
  size_t emitted = 0;
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *key = scr_arr_get_ref(h->pairs, (double)i);
    ScrStr *value = scr_arr_get_ref(h->pairs, (double)(i + 1));
    if (sf_headers_key_eq(key, name)) {
      if (emitted > 0) {
        joined[at++] = ',';
        joined[at++] = ' ';
      }
      memcpy(joined + at, value->data, value->len);
      at += value->len;
      emitted++;
    }
    scr_str_release(key);
    scr_str_release(value);
  }
  ScrStr *out = scr_str_new(joined, total);
  free(joined);
  return out;
}

static int sf_headers_name_cmp(const void *left, const void *right) {
  const ScrStr *a = *(ScrStr *const *)left;
  const ScrStr *b = *(ScrStr *const *)right;
  size_t shared = a->len < b->len ? a->len : b->len;
  int cmp = memcmp(a->data, b->data, shared);
  if (cmp != 0) return cmp;
  return a->len < b->len ? -1 : a->len > b->len ? 1 : 0;
}

static ScrStr **sf_headers_sorted_names(SfHeaders *h, size_t *count_out) {
  size_t n = (size_t)scr_arr_len(h->pairs);
  size_t capacity = n / 2;
  ScrStr **names = capacity ? malloc(capacity * sizeof *names) : NULL;
  if (capacity && !names) sf_oom();
  size_t count = 0;
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *key = scr_arr_get_ref(h->pairs, (double)i);
    bool seen = false;
    for (size_t j = 0; j < count; j++) {
      if (sf_headers_key_eq(names[j], key)) {
        seen = true;
        break;
      }
    }
    if (seen) scr_str_release(key);
    else names[count++] = key;
  }
  if (count > 1) {
    qsort(names, count, sizeof *names, &sf_headers_name_cmp);
  }
  *count_out = count;
  return names;
}

static ScrDyn *sf_headers_invoke(void *ptr, ScrDyn *self,
                                 const char *method,
                                 ScrDyn *const *args, size_t argc,
                                 const char *what) {
  SfHeaders *h = ptr;
  if (strcmp(method, "get") == 0 || strcmp(method, "has") == 0) {
    ScrStr *name = sf_headers_name(argc ? args[0] : NULL);
    if (!name) return NULL;
    ScrStr *value = sf_headers_get_value(h, name);
    scr_str_release(name);
    if (strcmp(method, "has") == 0) {
      bool present = value != NULL;
      scr_str_release(value);
      return scr_dyn_new_bool(present);
    }
    if (!value) return scr_dyn_new_null();
    ScrDyn *out = scr_dyn_new_str(value);
    scr_str_release(value);
    return out;
  }
  if (strcmp(method, "getSetCookie") == 0) {
    ScrDyn *out = scr_dyn_new_arr();
    size_t n = (size_t)scr_arr_len(h->pairs);
    for (size_t i = 0; i + 1 < n; i += 2) {
      ScrStr *key = scr_arr_get_ref(h->pairs, (double)i);
      ScrStr *value = scr_arr_get_ref(h->pairs, (double)(i + 1));
      if (key->len == 10 &&
          memcmp(key->data, "set-cookie", 10) == 0) {
        scr_dyn_arr_push(out, scr_dyn_new_str(value));
      }
      scr_str_release(key);
      scr_str_release(value);
    }
    return out;
  }
  if (strcmp(method, "forEach") == 0) {
    ScrDyn *callback = argc ? args[0] : scr_dyn_undefined();
    const ScrDyn *this_arg =
        argc > 1 ? args[1] : scr_dyn_undefined();
    size_t count = 0;
    ScrStr **names = sf_headers_sorted_names(h, &count);
    for (size_t i = 0; i < count; i++) {
      ScrStr *value = sf_headers_get_value(h, names[i]);
      ScrDyn *boxed_value = scr_dyn_new_str(value);
      ScrDyn *boxed_name = scr_dyn_new_str(names[i]);
      ScrDyn *call_args[3] = {boxed_value, boxed_name, self};
      scr_dyn_this_push_dyn(this_arg);
      ScrDyn *result =
          scr_dyn_call(callback, call_args, 3, "Headers.forEach callback");
      scr_dyn_this_pop();
      scr_dyn_release(boxed_value);
      scr_dyn_release(boxed_name);
      scr_str_release(value);
      scr_str_release(names[i]);
      if (!result) {
        for (size_t j = i + 1; j < count; j++) {
          scr_str_release(names[j]);
        }
        free(names);
        return NULL;
      }
      scr_dyn_release(result);
    }
    free(names);
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (strcmp(method, "append") == 0 || strcmp(method, "delete") == 0 ||
      strcmp(method, "set") == 0) {
    sf_type_error("immutable");
    return NULL;
  }
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_headers_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  (void)key;
  (void)len;
  return NULL;
}

/* ── Response ────────────────────────────────────────────────────── */

static SfResponse *sf_response_retain(SfResponse *r) {
  r->rc++;
  return r;
}

static void sf_response_release(SfResponse *r) {
  if (!r || --r->rc > 0) return;
  sf_stream_release(r->body);
  sf_headers_release(r->headers);
  scr_str_release(r->url);
  scr_str_release(r->status_text);
  free(r);
}

static void *sf_response_retain_v(void *p) {
  return sf_response_retain((SfResponse *)p);
}
static void sf_response_release_v(void *p) {
  sf_response_release((SfResponse *)p);
}

static ScrPromise *sf_response_collect(SfResponse *r, int mode) {
  if (!r->null_body) return sf_stream_collect(r->body, mode);

  /*
   * A null body is not a disturbed empty stream: body stays null,
   * bodyUsed stays false, and the body readers may be called repeatedly.
   * Each call therefore consumes its own empty payload.
   */
  ScrPromise *p = scr_promise_new();
  ScrDyn *value = NULL;
  if (mode == SF_COLLECT_JSON) {
    ScrStr *empty = scr_str_new("", 0);
    value = scr_json_parse(empty);
    scr_str_release(empty);
  } else if (mode == SF_COLLECT_TEXT) {
    ScrStr *empty = scr_str_new("", 0);
    value = scr_dyn_new_str(empty);
    scr_str_release(empty);
  } else {
    ScrBytes *empty = scr_bytes_new(SCR_BYTES_U8, 0);
    value = scr_dyn_new_bytes_copy(empty);
    scr_bytes_release(empty);
  }
  if (scr_exc_pending()) {
    scr_dyn_release(value);
    scr_promise_reject_pending(p);
  } else {
    scr_promise_fulfill_ref(p, value, &scr_dyn_retain_v,
                            &scr_dyn_release_v, NULL);
  }
  return p;
}

static ScrDyn *sf_response_invoke(void *ptr, ScrDyn *self,
                                  const char *method,
                                  ScrDyn *const *args, size_t argc,
                                  const char *what) {
  SfResponse *r = ptr;
  int mode = -1;
  if (strcmp(method, "json") == 0) mode = SF_COLLECT_JSON;
  else if (strcmp(method, "text") == 0) mode = SF_COLLECT_TEXT;
  else if (strcmp(method, "bytes") == 0) mode = SF_COLLECT_BYTES;
  if (mode >= 0) {
    if (argc != 0) {
      sf_type_error("Response body readers take no arguments");
      return NULL;
    }
    ScrPromise *p = sf_response_collect(r, mode);
    ScrDyn *out = scr_dyn_new_promise(p);
    scr_promise_release(p);
    return out;
  }
  (void)args;
  (void)self;
  sf_not_function(what);
  return NULL;
}

static ScrDyn *sf_response_get(void *ptr, const char *key, size_t len) {
  SfResponse *r = ptr;
  if (sf_name(key, len, "status")) return scr_dyn_new_num((double)r->status);
  if (sf_name(key, len, "ok")) {
    return scr_dyn_new_bool(r->status >= 200 && r->status <= 299);
  }
  if (sf_name(key, len, "bodyUsed")) {
    return scr_dyn_new_bool(!r->null_body && r->body->disturbed);
  }
  if (sf_name(key, len, "body")) {
    return r->null_body
               ? scr_dyn_new_null()
               : scr_dyn_new_handle(r->body, SCR_DYNH_WEB_STREAM);
  }
  if (sf_name(key, len, "url")) return scr_dyn_new_str(r->url);
  if (sf_name(key, len, "redirected")) {
    return scr_dyn_new_bool(r->redirected);
  }
  if (sf_name(key, len, "statusText")) {
    return scr_dyn_new_str(r->status_text);
  }
  if (sf_name(key, len, "headers")) {
    return scr_dyn_new_handle(r->headers, SCR_DYNH_FETCH_HEADERS);
  }
  return NULL;
}

ScrPromise *scr_fetch_response_json(ScrDyn *response) {
  if (!response || response->kind != SCR_DYN_HANDLE ||
      response->v.handle.tag != SCR_DYNH_FETCH_RESPONSE) {
    sf_type_error("Illegal invocation");
    return scr_promise_settled_ref(NULL, &scr_dyn_retain_v,
                                   &scr_dyn_release_v, NULL);
  }
  SfResponse *r = response->v.handle.ptr;
  return sf_response_collect(r, SF_COLLECT_JSON);
}

/* ── fetch transfer ──────────────────────────────────────────────── */

static SfTransfer *sf_retain(SfTransfer *t) {
  t->rc++;
  return t;
}

static void sf_release(SfTransfer *t) {
  if (--t->rc > 0) return;
  scr_promise_release(t->promise);
  scr_url_release(t->url);
  scr_str_release(t->method);
  scr_arr_release(t->headers);
  scr_dyn_release(t->body);
  if (t->client) scr_http_client_release(t->client);
  scr_net_sock_release(t->response_socket);
  if (t->inflating) inflateEnd(&t->zs);
  sf_watch_free(t->signal_watch);
  sf_signal_release(t->signal);
  sf_stream_release(t->request_stream);
  sf_stream_release(t->response_stream);
  free(t);
}

static void *sf_retain_v(void *p) { return sf_retain((SfTransfer *)p); }
static void sf_release_v(void *p) { sf_release((SfTransfer *)p); }

static ScrClosure *sf_closure(SfTransfer *t, void *fn) {
  ScrClosure *cb = scr_closure_new(fn, 1);
  ScrBox *box = scr_box_new_obj(&sf_retain_v, &sf_release_v, NULL);
  scr_box_set_ref(box, sf_retain(t));
  cb->caps[0] = box;
  return cb;
}

static SfTransfer *sf_from(ScrClosure *cb) {
  return (SfTransfer *)scr_box_get_ref(cb->caps[0]);
}

static void sf_settle(SfTransfer *t) {
  if (t->done) return;
  t->done = true;
  if (t->signal_watch) {
    sf_watch_free(t->signal_watch);
    t->signal_watch = NULL;
  }
  if (t->request_stream && t->request_stream->request_owner == t) {
    t->request_stream->request_owner = NULL;
  }
  if (t->response_stream && t->response_stream->response_owner == t) {
    t->response_stream->response_owner = NULL;
  }
  if (t->client) {
    scr_http_client_release(t->client);
    t->client = NULL;
  }
  if (t->response_socket) {
    scr_net_sock_release(t->response_socket);
    t->response_socket = NULL;
    t->response_paused = false;
  }
  for (SfTransfer **link = &sf_live; *link; link = &(*link)->next) {
    if (*link == t) {
      *link = t->next;
      sf_release(t); /* registry reference */
      return;
    }
  }
}

static void sf_reject(SfTransfer *t, const char *message) {
  if (t->done) return;
  sf_type_error(message);
  scr_promise_reject_pending(t->promise);
  sf_settle(t);
}

static void sf_reject_reason(SfTransfer *t, ScrDyn *reason) {
  if (t->done) return;
  sf_reject_promise_reason(t->promise, reason);
  sf_settle(t);
}

static void sf_transfer_abort_watch(SfSignalWatch *w, SfSignal *signal) {
  SfTransfer *t = w->owner;
  if (t->done) return;
  if (t->client) scr_http_client_destroy(t->client);
  if (t->response_sent && t->response_stream) {
    sf_stream_error(t->response_stream, signal->reason);
    sf_settle(t);
  } else {
    sf_reject_reason(t, signal->reason);
  }
}

static void sf_transfer_stream_error(SfTransfer *t, ScrDyn *reason) {
  if (!t || t->done) return;
  if (t->client) scr_http_client_destroy(t->client);
  if (t->response_sent && t->response_stream) {
    sf_stream_error(t->response_stream, reason);
    sf_settle(t);
  } else {
    sf_reject_reason(t, reason);
  }
}

static bool sf_eq_ci(const ScrStr *s, const char *lit) {
  size_t n = strlen(lit);
  if (s->len != n) return false;
  for (size_t i = 0; i < n; i++) {
    char c = s->data[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    if (c != lit[i]) return false;
  }
  return true;
}

static ScrStr *sf_bare_host(const ScrStr *host) {
  if (host->len >= 2 && host->data[0] == '[' &&
      host->data[host->len - 1] == ']') {
    return scr_str_new(host->data + 1, host->len - 2);
  }
  return scr_str_retain((ScrStr *)host);
}

static int sf_port(const ScrUrl *u, int dflt) {
  if (u->port->len == 0) return dflt;
  int p = 0;
  for (size_t i = 0; i < u->port->len; i++) {
    p = p * 10 + (u->port->data[i] - '0');
  }
  return p;
}

static ScrStr *sf_path(const ScrUrl *u) {
  size_t plen = (u->path->len > 0 ? u->path->len : 1) + u->query->len;
  char *buf = malloc(plen);
  if (!buf) sf_oom();
  size_t n = 0;
  if (u->path->len > 0) {
    memcpy(buf, u->path->data, u->path->len);
    n = u->path->len;
  } else {
    buf[n++] = '/';
  }
  memcpy(buf + n, u->query->data, u->query->len);
  n += u->query->len;
  ScrStr *out = scr_str_new(buf, n);
  free(buf);
  return out;
}

static ScrStr *sf_url_serialize(const ScrUrl *u) {
  size_t cap = u->scheme->len + u->userinfo->len + u->host->len +
               u->port->len + u->path->len + u->query->len + 8;
  char *buf = malloc(cap);
  if (!buf) sf_oom();
  size_t n = 0;
  memcpy(buf + n, u->scheme->data, u->scheme->len);
  n += u->scheme->len;
  buf[n++] = ':';
  if (u->has_authority) {
    buf[n++] = '/';
    buf[n++] = '/';
    if (u->userinfo->len > 0) {
      memcpy(buf + n, u->userinfo->data, u->userinfo->len);
      n += u->userinfo->len;
      buf[n++] = '@';
    }
    memcpy(buf + n, u->host->data, u->host->len);
    n += u->host->len;
    if (u->port->len > 0) {
      buf[n++] = ':';
      memcpy(buf + n, u->port->data, u->port->len);
      n += u->port->len;
    }
  }
  if (u->path->len > 0) {
    memcpy(buf + n, u->path->data, u->path->len);
    n += u->path->len;
  } else {
    buf[n++] = '/';
  }
  memcpy(buf + n, u->query->data, u->query->len);
  n += u->query->len;
  ScrStr *out = scr_str_new(buf, n);
  free(buf);
  return out;
}

static ScrUrl *sf_url_parse_quiet(ScrStr *text) {
  ScrUrl *url = scr_url_new(text);
  if (!url) scr_exc_clear();
  return url;
}

static const char *sf_env2(const char *lower, const char *upper) {
  const char *value = getenv(lower);
  if (!value || value[0] == '\0') value = getenv(upper);
  return value && value[0] != '\0' ? value : NULL;
}

static bool sf_no_proxy_match(const char *list, const ScrStr *host,
                              int port) {
  const char *p = list;
  while (*p) {
    while (*p == ',' || *p == ' ' || *p == '\t') p++;
    const char *start = p;
    while (*p && *p != ',' && *p != ' ' && *p != '\t') p++;
    size_t len = (size_t)(p - start);
    if (len == 0) continue;
    if (len == 1 && start[0] == '*') return true;
    size_t host_len = len;
    long entry_port = -1;
    for (size_t i = 0; i < len; i++) {
      if (start[i] == ':') {
        host_len = i;
        entry_port = strtol(start + i + 1, NULL, 10);
        break;
      }
    }
    if (host_len > 0 && start[0] == '.') {
      start++;
      host_len--;
    }
    if (host_len == 0 || (entry_port >= 0 && entry_port != port)) {
      continue;
    }
    size_t offset = host->len >= host_len ? host->len - host_len : 0;
    bool boundary =
        host->len == host_len ||
        (host->len > host_len && host->data[offset - 1] == '.');
    if (!boundary) continue;
    bool equal = true;
    for (size_t i = 0; i < host_len; i++) {
      char a = host->data[offset + i];
      char b = start[i];
      if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
      if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
      if (a != b) {
        equal = false;
        break;
      }
    }
    if (equal) return true;
  }
  return false;
}

static ScrUrl *sf_proxy_for(const ScrUrl *target, bool https,
                            int target_port) {
  const char *optin = getenv("NODE_USE_ENV_PROXY");
  if (!optin || strcmp(optin, "1") != 0) return NULL;
  const char *proxy = https ? sf_env2("https_proxy", "HTTPS_PROXY")
                            : sf_env2("http_proxy", "HTTP_PROXY");
  if (!proxy) return NULL;
  const char *no_proxy = sf_env2("no_proxy", "NO_PROXY");
  if (no_proxy &&
      sf_no_proxy_match(no_proxy, target->host, target_port)) {
    return NULL;
  }
  ScrStr *text = scr_str_new(proxy, strlen(proxy));
  ScrUrl *url = sf_url_parse_quiet(text);
  scr_str_release(text);
  return url;
}

static ScrUrl *sf_resolve_url(const ScrUrl *base, const ScrStr *location) {
  ScrStr *absolute = scr_str_new(location->data, location->len);
  ScrUrl *parsed = sf_url_parse_quiet(absolute);
  scr_str_release(absolute);
  if (parsed) return parsed;

  /*
   * Empty and fragment-only references preserve the complete base path
   * and query. The request serializer drops the resulting fragment, but
   * resolving it first is significant: `Location: #next` re-requests
   * `/a/start`, not its parent `/a/`.
   */
  if (location->len == 0 || location->data[0] == '#') {
    ScrStr *base_text = sf_url_serialize(base);
    size_t len = base_text->len + location->len;
    char *joined = malloc(len);
    if (!joined) sf_oom();
    memcpy(joined, base_text->data, base_text->len);
    memcpy(joined + base_text->len, location->data, location->len);
    ScrStr *text = scr_str_new(joined, len);
    free(joined);
    scr_str_release(base_text);
    ScrUrl *out = sf_url_parse_quiet(text);
    scr_str_release(text);
    return out;
  }

  size_t cap = base->scheme->len + base->userinfo->len + base->host->len +
               base->port->len + base->path->len + base->query->len +
               location->len + 16;
  char *buf = malloc(cap);
  if (!buf) sf_oom();
  size_t n = 0;
  memcpy(buf + n, base->scheme->data, base->scheme->len);
  n += base->scheme->len;
  buf[n++] = ':';
  if (location->len >= 2 && location->data[0] == '/' &&
      location->data[1] == '/') {
    memcpy(buf + n, location->data, location->len);
    n += location->len;
  } else {
    buf[n++] = '/';
    buf[n++] = '/';
    if (base->userinfo->len > 0) {
      memcpy(buf + n, base->userinfo->data, base->userinfo->len);
      n += base->userinfo->len;
      buf[n++] = '@';
    }
    memcpy(buf + n, base->host->data, base->host->len);
    n += base->host->len;
    if (base->port->len > 0) {
      buf[n++] = ':';
      memcpy(buf + n, base->port->data, base->port->len);
      n += base->port->len;
    }
    if (location->len > 0 && location->data[0] == '/') {
      memcpy(buf + n, location->data, location->len);
      n += location->len;
    } else if (location->len > 0 && location->data[0] == '?') {
      memcpy(buf + n, base->path->data, base->path->len);
      n += base->path->len;
      memcpy(buf + n, location->data, location->len);
      n += location->len;
    } else {
      size_t keep = 0;
      for (size_t i = 0; i < base->path->len; i++) {
        if (base->path->data[i] == '/') keep = i + 1;
      }
      memcpy(buf + n, base->path->data, keep);
      n += keep;
      if (keep == 0) buf[n++] = '/';
      memcpy(buf + n, location->data, location->len);
      n += location->len;
    }
  }
  ScrStr *text = scr_str_new(buf, n);
  free(buf);
  ScrUrl *out = sf_url_parse_quiet(text);
  scr_str_release(text);
  return out;
}

static bool sf_pairs_have(ScrArr *pairs, const char *name) {
  size_t n = (size_t)scr_arr_len(pairs);
  size_t want = strlen(name);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *key = (ScrStr *)scr_arr_get_ref(pairs, (double)i);
    bool same = key->len == want;
    for (size_t j = 0; j < want && same; j++) {
      char c = key->data[j];
      if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
      same = c == name[j];
    }
    scr_str_release(key);
    if (same) return true;
  }
  return false;
}

static bool sf_header_name_ok(const char *s, size_t len) {
  if (len == 0) return false;
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') ||
          strchr("!#$%&'*+-.^_`|~", c) != NULL)) {
      return false;
    }
  }
  return true;
}

static bool sf_header_value_ok(const ScrStr *value) {
  for (size_t i = 0; i < value->len; i++) {
    unsigned char c = (unsigned char)value->data[i];
    if ((c < 0x20 && c != '\t') || c == 0x7f) return false;
  }
  return true;
}

static ScrStr *sf_header_value_bytestring(ScrStr *value) {
  size_t len = (size_t)scr_str_utf16_len(value);
  char *bytes = malloc(len ? len : 1);
  if (!bytes) sf_oom();
  for (size_t i = 0; i < len; i++) {
    double code = scr_str_char_code_at(value, (double)i);
    if (code > 255) {
      char message[192];
      int message_len = snprintf(
          message, sizeof message,
          "Cannot convert argument to a ByteString because the character "
          "at index %zu has a value of %.0f which is greater than 255.",
          i, code);
      free(bytes);
      if (message_len < 0 || (size_t)message_len >= sizeof message) {
        sf_oom();
      }
      sf_type_error(message);
      return NULL;
    }
    bytes[i] = (char)(unsigned char)code;
  }
  ScrStr *out = scr_str_new(bytes, len);
  free(bytes);
  return out;
}

static bool sf_header_name_ci(
    const char *name, size_t name_len, const char *want) {
  size_t want_len = strlen(want);
  if (name_len != want_len) return false;
  for (size_t i = 0; i < name_len; i++) {
    char c = name[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    if (c != want[i]) return false;
  }
  return true;
}

static bool sf_header_value_ci(const ScrStr *value, const char *want) {
  size_t start = 0;
  size_t end = value->len;
  while (start < end &&
         (value->data[start] == ' ' || value->data[start] == '\t')) {
    start++;
  }
  while (end > start &&
         (value->data[end - 1] == ' ' || value->data[end - 1] == '\t')) {
    end--;
  }
  return sf_header_name_ci(
      value->data + start, end - start, want);
}

static bool sf_request_header_ok(
    const char *name, size_t name_len, const ScrStr *value) {
  if (sf_header_name_ci(name, name_len, "connection")) {
    return sf_header_value_ci(value, "close") ||
           sf_header_value_ci(value, "keep-alive");
  }
  return
      !sf_header_name_ci(name, name_len, "transfer-encoding") &&
      !sf_header_name_ci(name, name_len, "keep-alive") &&
      !sf_header_name_ci(name, name_len, "upgrade") &&
      !sf_header_name_ci(name, name_len, "expect");
}

static ScrStr *sf_trim_header_value(const ScrStr *value) {
  size_t start = 0;
  size_t end = value->len;
  while (start < end &&
         (value->data[start] == ' ' || value->data[start] == '\t')) {
    start++;
  }
  while (end > start &&
         (value->data[end - 1] == ' ' || value->data[end - 1] == '\t')) {
    end--;
  }
  return scr_str_new(value->data + start, end - start);
}

static bool sf_push_header(ScrArr *pairs, const char *name, size_t name_len,
                           ScrStr *value) {
  if (!sf_header_name_ok(name, name_len)) {
    sf_type_error("fetch failed");
    return false;
  }
  ScrStr *byte_value = sf_header_value_bytestring(value);
  if (!byte_value) return false;
  if (!sf_header_value_ok(byte_value)) {
    scr_str_release(byte_value);
    sf_type_error("fetch failed");
    return false;
  }
  ScrStr *normalized = sf_trim_header_value(byte_value);
  scr_str_release(byte_value);
  if (!sf_header_name_ci(name, name_len, "set-cookie")) {
    size_t n = (size_t)scr_arr_len(pairs);
    for (size_t i = 0; i + 1 < n; i += 2) {
      ScrStr *key = scr_arr_get_ref(pairs, (double)i);
      bool match = key->len == name_len;
      for (size_t j = 0; j < name_len && match; j++) {
        unsigned char a = (unsigned char)key->data[j];
        unsigned char b = (unsigned char)name[j];
        if (a >= 'A' && a <= 'Z') a = (unsigned char)(a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (unsigned char)(b - 'A' + 'a');
        match = a == b;
      }
      scr_str_release(key);
      if (!match) continue;

      ScrStr *previous =
          scr_arr_get_ref(pairs, (double)(i + 1));
      const char *separator =
          sf_header_name_ci(name, name_len, "cookie") ? "; " : ", ";
      size_t separator_len = 2;
      size_t joined_len =
          previous->len + separator_len + normalized->len;
      char *joined_data = malloc(joined_len ? joined_len : 1);
      if (!joined_data) sf_oom();
      memcpy(joined_data, previous->data, previous->len);
      memcpy(joined_data + previous->len, separator, separator_len);
      memcpy(joined_data + previous->len + separator_len,
             normalized->data, normalized->len);
      ScrStr *joined = scr_str_new(joined_data, joined_len);
      free(joined_data);
      scr_str_release(previous);
      scr_str_release(normalized);
      if (!sf_request_header_ok(name, name_len, joined)) {
        scr_str_release(joined);
        sf_type_error("fetch failed");
        return false;
      }
      scr_arr_set_ref(pairs, (double)(i + 1), joined);
      return true;
    }
  }
  if (!sf_request_header_ok(name, name_len, normalized)) {
    scr_str_release(normalized);
    sf_type_error("fetch failed");
    return false;
  }
  scr_arr_push_ref(pairs, scr_str_new(name, name_len));
  scr_arr_push_ref(pairs, normalized);
  return true;
}

static bool sf_add_headers(ScrArr *pairs, const ScrDyn *headers) {
  if (!headers || headers->kind == SCR_DYN_UNDEF ||
      headers->kind == SCR_DYN_NULL) {
    return true;
  }
  if (headers->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; i < headers->v.obj.len; i++) {
      const ScrDynEntry *e = &headers->v.obj.entries[i];
      if (e->value->kind != SCR_DYN_STR ||
          !sf_push_header(pairs, e->key, e->key_len, e->value->v.str)) {
        if (!scr_exc_pending()) sf_type_error("fetch failed");
        return false;
      }
    }
    return true;
  }
  if (headers->kind == SCR_DYN_ARR) {
    for (size_t i = 0; i < headers->v.arr.len; i++) {
      const ScrDyn *pair = headers->v.arr.items[i];
      if (pair->kind != SCR_DYN_ARR || pair->v.arr.len != 2 ||
          pair->v.arr.items[0]->kind != SCR_DYN_STR ||
          pair->v.arr.items[1]->kind != SCR_DYN_STR ||
          !sf_push_header(pairs, pair->v.arr.items[0]->v.str->data,
                          pair->v.arr.items[0]->v.str->len,
                          pair->v.arr.items[1]->v.str)) {
        if (!scr_exc_pending()) sf_type_error("fetch failed");
        return false;
      }
    }
    return true;
  }
  if (headers->kind == SCR_DYN_HANDLE &&
      headers->v.handle.tag == SCR_DYNH_FETCH_HEADERS) {
    SfHeaders *source = (SfHeaders *)headers->v.handle.ptr;
    size_t n = (size_t)scr_arr_len(source->pairs);
    for (size_t i = 0; i + 1 < n; i += 2) {
      ScrStr *name = scr_arr_get_ref(source->pairs, (double)i);
      ScrStr *value =
          scr_arr_get_ref(source->pairs, (double)(i + 1));
      bool ok = sf_push_header(pairs, name->data, name->len, value);
      scr_str_release(name);
      scr_str_release(value);
      if (!ok) return false;
    }
    return true;
  }
  sf_type_error("fetch failed");
  return false;
}

static void sf_push_header_text(ScrArr *pairs, const char *name,
                                const char *value, size_t value_len) {
  scr_arr_push_ref(pairs, scr_str_new(name, strlen(name)));
  scr_arr_push_ref(pairs, scr_str_new(value, value_len));
}

static void sf_strip_header(ScrArr **headers, const char *name) {
  ScrArr *old = *headers;
  size_t n = (size_t)scr_arr_len(old);
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, n);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *key = (ScrStr *)scr_arr_get_ref(old, (double)i);
    if (sf_eq_ci(key, name)) {
      scr_str_release(key);
      continue;
    }
    scr_arr_push_ref(out, key);
    scr_arr_push_ref(out, scr_arr_get_ref(old, (double)(i + 1)));
  }
  scr_arr_release(old);
  *headers = out;
}

static bool sf_content_length(ScrArr *headers, bool *present_out,
                              size_t *length_out) {
  bool present = false;
  size_t length = 0;
  size_t n = (size_t)scr_arr_len(headers);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *name = scr_arr_get_ref(headers, (double)i);
    ScrStr *value = scr_arr_get_ref(headers, (double)(i + 1));
    if (!sf_eq_ci(name, "content-length")) {
      scr_str_release(name);
      scr_str_release(value);
      continue;
    }
    if (present) {
      scr_str_release(name);
      scr_str_release(value);
      sf_type_error("fetch failed");
      return false;
    }
    size_t start = 0;
    size_t end = value->len;
    while (start < end &&
           (value->data[start] == ' ' || value->data[start] == '\t')) {
      start++;
    }
    while (end > start &&
           (value->data[end - 1] == ' ' ||
            value->data[end - 1] == '\t')) {
      end--;
    }
    bool valid = start < end;
    size_t parsed = 0;
    for (size_t j = start; j < end && valid; j++) {
      unsigned char c = (unsigned char)value->data[j];
      if (c < '0' || c > '9') {
        valid = false;
        break;
      }
      size_t digit = (size_t)(c - '0');
      if (parsed > (SIZE_MAX - digit) / 10) {
        valid = false;
        break;
      }
      parsed = parsed * 10 + digit;
    }
    scr_str_release(name);
    scr_str_release(value);
    if (!valid) {
      sf_type_error("fetch failed");
      return false;
    }
    present = true;
    length = parsed;
  }
  *present_out = present;
  *length_out = length;
  return true;
}

static ScrStr *sf_method(const ScrDyn *init) {
  const ScrDyn *value =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "method", 6)
          : NULL;
  if (!value || value->kind == SCR_DYN_UNDEF) return scr_str_new("GET", 3);
  if (value->kind != SCR_DYN_STR) {
    sf_type_error("fetch failed");
    return NULL;
  }
  ScrStr *method = scr_str_retain(value->v.str);
  static const char *normalized[] = {
      "DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"};
  for (size_t i = 0; i < sizeof normalized / sizeof normalized[0]; i++) {
    const char *candidate = normalized[i];
    size_t n = strlen(candidate);
    if (method->len != n) continue;
    bool same = true;
    for (size_t j = 0; j < n && same; j++) {
      char c = method->data[j];
      if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
      same = c == candidate[j];
    }
    if (same) {
      scr_str_release(method);
      return scr_str_new(candidate, n);
    }
  }
  bool valid = method->len > 0;
  for (size_t i = 0; i < method->len && valid; i++) {
    unsigned char c = (unsigned char)method->data[i];
    valid = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') ||
            strchr("!#$%&'*+-.^_`|~", c) != NULL;
  }
  if (!valid) {
    scr_str_release(method);
    sf_type_error("fetch failed");
    return NULL;
  }
  if (sf_eq_ci(method, "connect") || sf_eq_ci(method, "trace") ||
      sf_eq_ci(method, "track")) {
    size_t message_len = method->len + 31;
    char *message = malloc(message_len + 1);
    if (!message) sf_oom();
    int len = snprintf(message, message_len + 1, "'%.*s' HTTP method is unsupported.",
                       (int)method->len, method->data);
    scr_str_release(method);
    if (len < 0 || (size_t)len > message_len) sf_oom();
    sf_type_error(message);
    free(message);
    return NULL;
  }
  return method;
}

static bool sf_redirect_mode(const ScrDyn *init, int *out) {
  const ScrDyn *value =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "redirect", 8)
          : NULL;
  if (!value || value->kind == SCR_DYN_UNDEF) {
    *out = SF_REDIRECT_FOLLOW;
    return true;
  }
  ScrStr *mode = scr_dyn_string_coerce_js(value);
  if (!mode) return false;
  if (mode->len == 6 && memcmp(mode->data, "follow", 6) == 0) {
    *out = SF_REDIRECT_FOLLOW;
    scr_str_release(mode);
    return true;
  }
  if (mode->len == 5 && memcmp(mode->data, "error", 5) == 0) {
    *out = SF_REDIRECT_ERROR;
    scr_str_release(mode);
    return true;
  }
  if (mode->len == 6 && memcmp(mode->data, "manual", 6) == 0) {
    *out = SF_REDIRECT_MANUAL;
    scr_str_release(mode);
    return true;
  }
  static const char prefix[] = "undefined: ";
  static const char suffix[] =
      " is not an accepted type. Expected one of follow, manual, error.";
  size_t message_len =
      sizeof prefix - 1 + mode->len + sizeof suffix - 1;
  char *message = malloc(message_len + 1);
  if (!message) sf_oom();
  memcpy(message, prefix, sizeof prefix - 1);
  memcpy(message + sizeof prefix - 1, mode->data, mode->len);
  memcpy(message + sizeof prefix - 1 + mode->len,
         suffix, sizeof suffix - 1);
  message[message_len] = '\0';
  scr_str_release(mode);
  sf_type_error(message);
  free(message);
  return false;
}

static ScrPromise *sf_reject_now(ScrPromise *promise, const char *message) {
  if (!scr_exc_pending()) sf_type_error(message);
  scr_promise_reject_pending(promise);
  return promise;
}

static void sf_request_length_mismatch(SfTransfer *t) {
  if (t->client) scr_http_client_destroy(t->client);
  sf_reject(t, "fetch failed");
}

static void sf_stream_request_flush(SfStream *s) {
  SfTransfer *t = s->request_owner;
  if (!s->started || !t || t->done || !t->client) return;
  while (s->head) {
    SfChunk *c = s->head;
    s->head = c->next;
    if (!s->head) s->tail = NULL;
    s->queued--;
    ScrBytes *bytes = sf_chunk_bytes(c->value);
    if (!bytes) {
      sf_chunk_release(c);
      sf_stream_drop_chunks(s);
      ScrCaught *caught = scr_exc_take();
      ScrDyn *reason = scr_caught_to_dyn(caught);
      sf_transfer_stream_error(t, reason);
      scr_dyn_release(reason);
      scr_caught_release(caught);
      return;
    }
    if (t->request_has_content_length &&
        (t->request_body_sent > t->request_content_length ||
         bytes->len >
             t->request_content_length - t->request_body_sent)) {
      scr_bytes_release(bytes);
      sf_chunk_release(c);
      sf_stream_drop_chunks(s);
      sf_request_length_mismatch(t);
      return;
    }
    t->request_body_sent += bytes->len;
    scr_http_client_write_bytes(t->client, bytes);
    scr_bytes_release(bytes);
    sf_chunk_release(c);
  }
  if (s->error) {
    sf_transfer_stream_error(t, s->error);
  } else if (s->close_requested) {
    if (t->request_has_content_length &&
        t->request_body_sent != t->request_content_length) {
      sf_request_length_mismatch(t);
      return;
    }
    sf_stream_finish_close(s);
    scr_http_client_end(t->client);
  }
}

static bool sf_start_hop(SfTransfer *t);
static bool sf_redirect(SfTransfer *t, int status, const ScrStr *location);

static void sf_response_terminate(SfTransfer *t) {
  if (!t || t->done || !t->response_stream) return;
  if (t->client) scr_http_client_destroy(t->client);
  ScrError *e = NULL;
  ScrDyn *reason = sf_dom_reason("TypeError", "terminated", &e);
  sf_stream_error(t->response_stream, reason);
  scr_dyn_release(reason);
  scr_error_release(e);
  sf_settle(t);
}

static void sf_on_data(ScrClosure *cb, ScrBytes *chunk) {
  SfTransfer *t = sf_from(cb);
  if (!t) return;
  if (t->done || !t->response_stream) {
    sf_release(t);
    return;
  }
  /*
   * Fetch exposes no body for HEAD/204/205/304 responses. The shared HTTP
   * parser still drains an invalid payload on 205, so discard those bytes
   * here instead of queueing them into an inaccessible stream that would
   * apply backpressure forever.
   */
  if (t->response_null_body) {
    sf_release(t);
    return;
  }
  if (t->response_stream->discarded) {
    sf_release(t);
    return;
  }
  if (!t->inflating) {
    sf_stream_enqueue_bytes(t->response_stream, chunk);
    sf_release(t);
    return;
  }

  if (t->inflate_member_end) {
    if (inflateReset(&t->zs) != Z_OK) {
      sf_response_terminate(t);
      sf_release(t);
      return;
    }
    t->inflate_member_end = false;
  }
  t->zs.next_in = (Bytef *)chunk->data;
  t->zs.avail_in = (uInt)chunk->len;
  unsigned char out[16384];
  while (t->zs.avail_in > 0 && !t->done) {
    t->zs.next_out = out;
    t->zs.avail_out = sizeof out;
    int result = inflate(&t->zs, Z_NO_FLUSH);
    size_t produced = sizeof out - t->zs.avail_out;
    if (produced > 0) {
      ScrBytes *decoded = scr_bytes_new(SCR_BYTES_U8, (double)produced);
      memcpy(decoded->data, out, produced);
      sf_stream_enqueue_bytes(t->response_stream, decoded);
      scr_bytes_release(decoded);
    }
    if (result == Z_STREAM_END) {
      /* A gzip representation can contain concatenated members. */
      t->inflate_member_end = true;
      if (t->zs.avail_in == 0) break;
      if (inflateReset(&t->zs) != Z_OK) {
        sf_response_terminate(t);
        break;
      }
      t->inflate_member_end = false;
      continue;
    }
    if (result != Z_OK && result != Z_BUF_ERROR) {
      sf_response_terminate(t);
      break;
    }
    if (result == Z_BUF_ERROR && produced == 0) break;
  }
  sf_release(t);
}

static void sf_on_end(ScrClosure *cb) {
  SfTransfer *t = sf_from(cb);
  if (!t) return;
  if (!t->done) {
    if (t->response_stream) sf_stream_close(t->response_stream);
    sf_settle(t);
  }
  sf_release(t);
}

static void sf_on_res_error(ScrClosure *cb, ScrStr *message) {
  (void)message;
  SfTransfer *t = sf_from(cb);
  if (!t) return;
  if (!t->done && t->response_stream) {
    sf_response_terminate(t);
  } else {
    sf_reject(t, "fetch failed");
  }
  sf_release(t);
}

static bool sf_response_has_null_body(const SfTransfer *t, int status) {
  return sf_eq_ci(t->method, "head") || status == 101 ||
         status == 204 || status == 205 || status == 304;
}

static void sf_on_response(ScrClosure *cb, ScrHttpReq *res) {
  SfTransfer *t = sf_from(cb);
  if (!t) {
    scr_http_req_release(res);
    return;
  }
  if (t->done) {
    scr_http_req_release(res);
    sf_release(t);
    return;
  }
  int status = (int)scr_http_req_status(res);
  if (status == 301 || status == 302 || status == 303 ||
      status == 307 || status == 308) {
    ScrStr *name = scr_str_new("location", 8);
    ScrStr *location = scr_http_req_header(res, name);
    scr_str_release(name);
    if (location) {
      if (t->redirect_mode == SF_REDIRECT_MANUAL) {
        scr_str_release(location);
      } else {
        ScrHttpClientReq *old = t->client;
        t->client = NULL;
        if (old) {
          scr_http_client_destroy(old);
          scr_http_client_release(old);
        }
        if (t->redirect_mode == SF_REDIRECT_ERROR) {
          sf_reject(t, "fetch failed");
          scr_str_release(location);
          scr_http_req_release(res);
          sf_release(t);
          return;
        }
        bool follow = sf_redirect(t, status, location);
        scr_str_release(location);
        if (follow) sf_start_hop(t);
        scr_http_req_release(res);
        sf_release(t);
        return;
      }
    }
  }
  bool null_body = sf_response_has_null_body(t, status);
  t->response_null_body = null_body;
  if (!null_body) {
    ScrStr *name = scr_str_new("content-encoding", 16);
    ScrStr *encoding = scr_http_req_header(res, name);
    scr_str_release(name);
    if (encoding) {
      if (sf_eq_ci(encoding, "gzip") || sf_eq_ci(encoding, "x-gzip") ||
          sf_eq_ci(encoding, "deflate")) {
        memset(&t->zs, 0, sizeof t->zs);
        if (inflateInit2(&t->zs, 15 + 32) != Z_OK) sf_oom();
        t->inflating = true;
      }
      scr_str_release(encoding);
    }
  }
  SfStream *body = sf_stream_new_native();
  body->response_owner = t;
  t->response_stream = sf_stream_retain(body);
  t->response_socket = scr_http_req_socket(res);
  SfResponse *response = calloc(1, sizeof *response);
  if (!response) sf_oom();
  response->rc = 1;
  response->body = sf_stream_retain(body);
  response->headers = sf_headers_new(scr_http_req_header_pairs(res));
  response->url = sf_url_serialize(t->url);
  response->status_text = scr_http_req_status_message(res);
  if (!response->status_text) response->status_text = scr_str_new("", 0);
  response->status = status;
  response->redirected = t->redirected;
  response->null_body = null_body;
  ScrDyn *boxed = scr_dyn_new_handle(response, SCR_DYNH_FETCH_RESPONSE);
  sf_response_release(response);
  sf_stream_release(body);

  scr_http_req_on_data(res, sf_closure(t, (void *)&sf_on_data),
                       &sf_on_data, false);
  scr_http_req_on_end(res, sf_closure(t, (void *)&sf_on_end), false);
  scr_http_req_on_error(res, sf_closure(t, (void *)&sf_on_res_error),
                        &sf_on_res_error, false);
  t->response_sent = true;
  ScrPromise *promise = t->promise;
  t->promise = NULL;
  scr_promise_fulfill_ref(promise, boxed, &scr_dyn_retain_v,
                          &scr_dyn_release_v, NULL);
  scr_promise_release(promise);
  scr_http_req_release(res);
  sf_release(t);
}

static void sf_on_client_error(ScrClosure *cb, ScrStr *message) {
  (void)message;
  SfTransfer *t = sf_from(cb);
  if (!t) return;
  if (!t->done) {
    if (t->response_sent && t->response_stream) {
      sf_response_terminate(t);
    } else {
      sf_reject(t, "fetch failed");
    }
  }
  sf_release(t);
}

static void sf_on_upgrade(
    ScrClosure *cb, ScrHttpReq *res, ScrNetSocket *socket,
    ScrBytes *head) {
  SfTransfer *t = sf_from(cb);
  scr_http_req_release(res);
  scr_bytes_release(head);
  scr_net_sock_destroy(socket);
  scr_net_sock_release(socket);
  if (!t) return;
  if (!t->done) sf_reject(t, "fetch failed");
  sf_release(t);
}

static bool sf_body_is_stream(const ScrDyn *body) {
  return body &&
         ((body->kind == SCR_DYN_HANDLE &&
           body->v.handle.tag == SCR_DYNH_WEB_STREAM) ||
          body->kind == SCR_DYN_ARR);
}

static bool sf_redirect(SfTransfer *t, int status,
                        const ScrStr *location) {
  if (t->hops >= 20) {
    sf_reject(t, "fetch failed");
    return false;
  }
  ScrUrl *next = sf_resolve_url(t->url, location);
  if (!next ||
      !(sf_eq_ci(next->scheme, "http") ||
        sf_eq_ci(next->scheme, "https")) ||
      next->userinfo->len > 0) {
    scr_url_release(next);
    sf_reject(t, "fetch failed");
    return false;
  }

  bool is_get = sf_eq_ci(t->method, "get");
  bool is_head = sf_eq_ci(t->method, "head");
  bool rewrite =
      (status == 303 && !is_get && !is_head) ||
      ((status == 301 || status == 302) &&
       sf_eq_ci(t->method, "post"));
  if (sf_body_is_stream(t->body) && status != 303) {
    scr_url_release(next);
    sf_reject(t, "fetch failed");
    return false;
  }
  if (rewrite) {
    scr_str_release(t->method);
    t->method = scr_str_new("GET", 3);
    scr_dyn_release(t->body);
    t->body = NULL;
    sf_strip_header(&t->headers, "content-type");
    sf_strip_header(&t->headers, "content-length");
    sf_strip_header(&t->headers, "content-encoding");
    sf_strip_header(&t->headers, "content-language");
    sf_strip_header(&t->headers, "content-location");
  }

  bool same_origin =
      t->url->host->len == next->host->len &&
      memcmp(t->url->host->data, next->host->data, next->host->len) == 0 &&
      sf_port(t->url, 0) == sf_port(next, 0) &&
      t->url->scheme->len == next->scheme->len &&
      memcmp(t->url->scheme->data, next->scheme->data,
             next->scheme->len) == 0;
  if (!same_origin) {
    sf_strip_header(&t->headers, "authorization");
    sf_strip_header(&t->headers, "proxy-authorization");
    sf_strip_header(&t->headers, "cookie");
  }

  scr_url_release(t->url);
  t->url = next;
  t->hops++;
  t->redirected = true;
  return true;
}

static bool sf_start_hop(SfTransfer *t) {
  ScrUrl *url = t->url;
  bool https = sf_eq_ci(url->scheme, "https");
  int default_port = https ? 443 : 80;
  int port = sf_port(url, default_port);
  ScrUrl *proxy = https ? NULL : sf_proxy_for(url, false, port);
  size_t user_len = (size_t)scr_arr_len(t->headers);
  ScrArr *headers = scr_arr_new(SCR_ELEM_STR, user_len + 16);

  if (!sf_pairs_have(t->headers, "host")) {
    char authority[384];
    int authority_len =
        port == default_port
            ? snprintf(authority, sizeof authority, "%.*s",
                       (int)url->host->len, url->host->data)
            : snprintf(authority, sizeof authority, "%.*s:%d",
                       (int)url->host->len, url->host->data, port);
    if (authority_len < 0 ||
        (size_t)authority_len >= sizeof authority) {
      scr_arr_release(headers);
      scr_url_release(proxy);
      sf_reject(t, "fetch failed");
      return false;
    }
    sf_push_header_text(headers, "host", authority,
                        (size_t)authority_len);
  }
  if (!sf_pairs_have(t->headers, "connection")) {
    sf_push_header_text(headers, "connection", "keep-alive", 10);
  }
  for (size_t i = 0; i + 1 < user_len; i += 2) {
    scr_arr_push_ref(headers, scr_arr_get_ref(t->headers, (double)i));
    scr_arr_push_ref(headers,
                     scr_arr_get_ref(t->headers, (double)(i + 1)));
  }
  if (!sf_pairs_have(t->headers, "accept")) {
    sf_push_header_text(headers, "accept", "*/*", 3);
  }
  if (!sf_pairs_have(t->headers, "accept-language")) {
    sf_push_header_text(headers, "accept-language", "*", 1);
  }
  if (!sf_pairs_have(t->headers, "sec-fetch-mode")) {
    sf_push_header_text(headers, "sec-fetch-mode", "cors", 4);
  }
  if (!sf_pairs_have(t->headers, "user-agent")) {
    sf_push_header_text(headers, "user-agent", "node", 4);
  }
  if (!sf_pairs_have(t->headers, "accept-encoding")) {
    sf_push_header_text(headers, "accept-encoding", "gzip, deflate", 13);
  }

  ScrStr *bare =
      sf_bare_host(proxy ? proxy->host : url->host);
  ScrStr *dial = scr_net_blocking_lookup(bare);
  ScrStr *path = proxy ? sf_url_serialize(url) : sf_path(url);
  int dial_port = proxy ? sf_port(proxy, 80) : port;
  ScrStr *sni = https ? sf_bare_host(url->host) : NULL;
  void *tls_ctx =
      https ? scr_tls_fetch_client_ctx(sni, true) : NULL;
  ScrHttpClientReq *client = scr_http_request_ex(
      dial, dial_port, path, t->method, 0, headers, false, NULL, NULL,
      default_port, https ? &scr_tls_fetch_client_wrap : NULL, tls_ctx);
  scr_arr_release(headers);
  scr_str_release(path);
  scr_str_release(dial);
  scr_str_release(bare);
  scr_str_release(sni);
  scr_url_release(proxy);
  if (!client) {
    sf_reject_now(t->promise, "fetch failed");
    sf_settle(t);
    return false;
  }
  t->client = client;

  scr_http_client_on_response(
      client, sf_closure(t, (void *)&sf_on_response),
      &sf_on_response, true);
  scr_http_client_on_upgrade(
      client, sf_closure(t, (void *)&sf_on_upgrade),
      &sf_on_upgrade, true);
  scr_http_client_on_error(
      client, sf_closure(t, (void *)&sf_on_client_error),
      &sf_on_client_error, false);

  ScrDyn *body = t->body;
  if (body && body->kind == SCR_DYN_STR) {
    scr_http_client_end_str(client, body->v.str);
  } else if (body && body->kind == SCR_DYN_BYTES) {
    scr_http_client_end_bytes(client, body->v.bytes);
  } else if (sf_body_is_stream(body)) {
    SfStream *stream = NULL;
    ScrDyn *seeded = NULL;
    if (body->kind == SCR_DYN_ARR) {
      seeded = scr_fetch_stream_from(body);
      if (!seeded) {
        if (t->client) scr_http_client_destroy(t->client);
        sf_reject_now(t->promise, "fetch failed");
        sf_settle(t);
        return false;
      }
      stream = sf_stream_of(seeded);
    } else {
      stream = sf_stream_of(body);
    }
    if (!stream || stream->reader || stream->internal_lock ||
        stream->disturbed) {
      scr_dyn_release(seeded);
      if (t->client) scr_http_client_destroy(t->client);
      sf_reject(t,
                "Response body object should not be disturbed or locked");
      return false;
    }
    stream->disturbed = true;
    stream->internal_lock = true;
    stream->request_owner = t;
    t->request_stream = sf_stream_retain(stream);
    sf_stream_request_flush(stream);
    if (stream->started && !stream->close_requested && !stream->closed &&
        !stream->error && !t->done && t->client) {
      sf_stream_pull(stream);
    }
    scr_dyn_release(seeded);
  } else {
    scr_http_client_end(client);
  }
  return true;
}

ScrPromise *scr_fetch_static(ScrStr *url, ScrDyn *init) {
  ScrPromise *promise = scr_promise_new();
  if (init && init->kind != SCR_DYN_OBJ &&
      init->kind != SCR_DYN_UNDEF && init->kind != SCR_DYN_NULL) {
    return sf_reject_now(promise, "fetch failed");
  }
  int redirect_mode;
  if (!sf_redirect_mode(init, &redirect_mode)) {
    return sf_reject_now(promise, "fetch failed");
  }
  const ScrDyn *signal_dyn =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "signal", 6)
          : NULL;
  SfSignal *signal = NULL;
  if (signal_dyn && signal_dyn->kind != SCR_DYN_UNDEF &&
      signal_dyn->kind != SCR_DYN_NULL) {
    signal = sf_signal_of(signal_dyn,
                          "Request init.signal must be an AbortSignal");
    if (!signal) return sf_reject_now(promise, "fetch failed");
  }

  ScrUrl *u = scr_url_new(url);
  if (!u) {
    scr_promise_reject_pending(promise);
    return promise;
  }
  if (u->userinfo->len > 0) {
    static const char prefix[] =
        "Request cannot be constructed from a URL that includes credentials: ";
    size_t message_len = sizeof prefix - 1 + url->len;
    char *message = malloc(message_len + 1);
    if (!message) sf_oom();
    memcpy(message, prefix, sizeof prefix - 1);
    memcpy(message + sizeof prefix - 1, url->data, url->len);
    message[message_len] = '\0';
    sf_type_error(message);
    free(message);
    scr_url_release(u);
    return sf_reject_now(promise, "fetch failed");
  }
  bool https = sf_eq_ci(u->scheme, "https");
  if (!https && !sf_eq_ci(u->scheme, "http")) {
    scr_url_release(u);
    return sf_reject_now(promise, "fetch failed");
  }

  ScrStr *method = sf_method(init);
  if (!method) {
    scr_url_release(u);
    return sf_reject_now(promise, "fetch failed");
  }
  const ScrDyn *body =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "body", 4)
          : NULL;
  bool body_present =
      body && body->kind != SCR_DYN_UNDEF && body->kind != SCR_DYN_NULL;
  bool body_stream =
      body_present &&
      ((body->kind == SCR_DYN_HANDLE &&
        body->v.handle.tag == SCR_DYNH_WEB_STREAM) ||
       body->kind == SCR_DYN_ARR);
  const ScrDyn *duplex =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "duplex", 6)
          : NULL;
  bool duplex_present =
      duplex && duplex->kind != SCR_DYN_UNDEF;
  bool duplex_half =
      duplex_present && duplex->kind == SCR_DYN_STR &&
      duplex->v.str->len == 4 &&
      memcmp(duplex->v.str->data, "half", 4) == 0;
  if (duplex_present && !duplex_half) {
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(
        promise, "RequestInit.duplex must be 'half'");
  }
  if (body_present && body->kind != SCR_DYN_STR &&
      body->kind != SCR_DYN_BYTES && !body_stream) {
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(promise, "fetch failed");
  }
  if (body_stream && !duplex_half) {
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(
        promise,
        "RequestInit: duplex option is required when sending a body.");
  }
  if (body_present &&
      ((method->len == 3 && memcmp(method->data, "GET", 3) == 0) ||
       (method->len == 4 && memcmp(method->data, "HEAD", 4) == 0))) {
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(
        promise, "Request with GET/HEAD method cannot have body.");
  }

  ScrArr *headers = scr_arr_new(SCR_ELEM_STR, 16);
  const ScrDyn *init_headers =
      init && init->kind == SCR_DYN_OBJ
          ? scr_dyn_obj_get(init, "headers", 7)
          : NULL;
  if (!sf_add_headers(headers, init_headers)) {
    scr_arr_release(headers);
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(promise, "fetch failed");
  }
  if (body && body->kind == SCR_DYN_STR &&
      !sf_pairs_have(headers, "content-type")) {
    sf_push_header_text(headers, "content-type",
                        "text/plain;charset=UTF-8", 24);
  }
  bool has_content_length = false;
  size_t content_length = 0;
  if (!sf_content_length(headers, &has_content_length, &content_length)) {
    scr_arr_release(headers);
    scr_str_release(method);
    scr_url_release(u);
    return sf_reject_now(promise, "fetch failed");
  }
  if (has_content_length && !body_stream) {
    size_t body_length =
        !body_present
            ? 0
            : body->kind == SCR_DYN_STR
                ? body->v.str->len
                : body->v.bytes->len;
    if (body_length != content_length) {
      scr_arr_release(headers);
      scr_str_release(method);
      scr_url_release(u);
      return sf_reject_now(promise, "fetch failed");
    }
  }
  /*
   * Request construction validates URL/method/body/headers before fetch
   * observes an already-aborted signal. Undici does the same: abort wins
   * over starting I/O, but never masks a RequestInit validation error.
   */
  if (signal && signal->aborted) {
    scr_arr_release(headers);
    scr_str_release(method);
    scr_url_release(u);
    sf_reject_promise_reason(promise, signal->reason);
    return promise;
  }

  SfTransfer *t = calloc(1, sizeof *t);
  if (!t) sf_oom();
  t->rc = 1; /* registry */
  t->promise = scr_promise_retain(promise);
  t->url = u;
  t->method = method;
  t->headers = headers;
  t->body = body_present ? scr_dyn_retain((ScrDyn *)body) : NULL;
  t->redirect_mode = redirect_mode;
  t->request_has_content_length = has_content_length;
  t->request_content_length = content_length;
  if (signal) {
    t->signal = sf_signal_retain(signal);
    t->signal_watch =
        sf_signal_watch(signal, t, &sf_transfer_abort_watch);
  }
  t->next = sf_live;
  sf_live = t;
  sf_start_hop(t);
  return promise;
}

/* ── handle dispatch tables + teardown ───────────────────────────── */

static bool sf_no_set(void *ptr, const char *key, size_t len,
                      const ScrDyn *value) {
  (void)ptr;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

static const ScrDynHandleOps sf_signal_ops = {
    "AbortSignal", &sf_signal_retain_v, &sf_signal_release_v,
    &sf_signal_invoke, &sf_signal_get, &sf_signal_set, NULL};
static const ScrDynHandleOps sf_stream_ops = {
    "ReadableStream", &sf_stream_retain_v, &sf_stream_release_v,
    &sf_stream_invoke, &sf_stream_get, &sf_no_set, NULL};
static const ScrDynHandleOps sf_reader_ops = {
    "ReadableStreamDefaultReader", &sf_reader_handle_retain_v,
    &sf_reader_handle_release_v, &sf_reader_invoke, &sf_reader_get,
    &sf_no_set, NULL};
static const ScrDynHandleOps sf_controller_ops = {
    "ReadableStreamDefaultController", &sf_stream_retain_v,
    &sf_stream_release_v, &sf_controller_invoke, &sf_controller_get,
    &sf_no_set, NULL};
static const ScrDynHandleOps sf_response_ops = {
    "Response", &sf_response_retain_v, &sf_response_release_v,
    &sf_response_invoke, &sf_response_get, &sf_no_set, NULL};
static const ScrDynHandleOps sf_headers_ops = {
    "Headers", &sf_headers_retain_v, &sf_headers_release_v,
    &sf_headers_invoke, &sf_headers_get, &sf_no_set, NULL};
static const ScrDynHandleOps sf_event_ops = {
    "Event", &sf_event_retain_v, &sf_event_release_v,
    &sf_event_invoke, &sf_event_get, &sf_event_set, NULL};

static void sf_teardown(void) {
  while (sf_live) {
    SfTransfer *t = sf_live;
    if (t->client) scr_http_client_destroy(t->client);
    if (t->response_stream) sf_stream_close(t->response_stream);
    sf_settle(t);
  }
}

void scr_fetch_install(void) {
  static bool installed;
  if (installed) return;
  installed = true;
  scr_net_install();
  scr_dyn_handle_install(SCR_DYNH_ABORT_SIGNAL, &sf_signal_ops);
  scr_dyn_handle_install(SCR_DYNH_WEB_STREAM, &sf_stream_ops);
  scr_dyn_handle_install(SCR_DYNH_WEB_READER, &sf_reader_ops);
  scr_dyn_handle_install(SCR_DYNH_WEB_CONTROLLER, &sf_controller_ops);
  scr_dyn_handle_install(SCR_DYNH_FETCH_RESPONSE, &sf_response_ops);
  scr_dyn_handle_install(SCR_DYNH_FETCH_HEADERS, &sf_headers_ops);
  scr_dyn_handle_install(SCR_DYNH_EVENT, &sf_event_ops);
  atexit(sf_teardown);
}

#else

#include "scr_runtime.h"
#include "scr_url_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zlib.h>

#include "quickjs.h"

static void fx_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* ── small string helpers (ScrStr names are not NUL-guaranteed at the
 * lengths we compare, so everything is len-aware, ASCII-case-folded) ── */

static bool fx_eq_ci(const char *a, size_t alen, const char *b) {
  size_t blen = strlen(b);
  if (alen != blen) return false;
  for (size_t i = 0; i < alen; i++) {
    char c = a[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    if (c != b[i]) return false;
  }
  return true;
}

static bool fx_str_is(const ScrStr *s, const char *lit) { return fx_eq_ci(s->data, s->len, lit); }

/* Does the flat [name, value, ...] pairs array carry `name`? */
static bool fx_pairs_have(ScrArr *pairs, const char *name) {
  size_t n = (size_t)scr_arr_len(pairs);
  bool found = false;
  for (size_t i = 0; i + 1 < n && !found; i += 2) {
    ScrStr *nm = (ScrStr *)scr_arr_get_ref(pairs, (double)i);
    found = fx_eq_ci(nm->data, nm->len, name);
    scr_str_release(nm);
  }
  return found;
}

static void fx_pairs_push(ScrArr *pairs, const char *name, const char *value, size_t vlen) {
  scr_arr_push_ref(pairs, scr_str_new(name, strlen(name)));
  scr_arr_push_ref(pairs, scr_str_new(value, vlen));
}

/* ── transfers ───────────────────────────────────────────────────────── */

typedef struct FxTransfer {
  size_t rc; /* the live registry's +1 plus one per minted listener box */
  int id;
  JSContext *ctx;
  JSValue cbs; /* { onResponse, onData, onEnd, onError } — owned while live */
  bool cbs_live;
  /* the request, as it evolves across redirect hops */
  ScrStr *method;  /* owned */
  ScrArr *headers; /* flat [name, value, ...] user pairs — owned */
  ScrBytes *body;  /* owned, NULL = none */
  ScrUrl *url;     /* the CURRENT hop's URL — owned */
  int hops;
  bool redirected;
  /* the live hop */
  ScrHttpClientReq *client; /* +1, NULL between/after hops */
  bool responded; /* onResponse fired (the final response) */
  bool cancelled; /* island aborted/cancelled: die silently */
  bool done;      /* settled: no callback ever fires again */
  /* response decompression */
  bool inflating;
  z_stream zs;
  struct FxTransfer *next;
} FxTransfer;

static FxTransfer *fx_live = NULL; /* registry: +1 each */
static size_t fx_nlive = 0;
static int fx_next_id = 1;

static FxTransfer *fx_retain(FxTransfer *t) {
  t->rc++;
  return t;
}

static void fx_release(FxTransfer *t) {
  if (--t->rc > 0) return;
  scr_str_release(t->method);
  scr_arr_release(t->headers);
  if (t->body) scr_bytes_release(t->body);
  if (t->url) scr_url_release(t->url);
  if (t->client) scr_http_client_release(t->client);
  if (t->inflating) inflateEnd(&t->zs);
  if (t->cbs_live) JS_FreeValue(t->ctx, t->cbs);
  free(t);
}

static void *fx_retain_v(void *p) { return fx_retain((FxTransfer *)p); }
static void fx_release_v(void *p) { fx_release((FxTransfer *)p); }

/* Settle: the transfer is over (delivered, failed, or aborted) — drop the
 * hop client, free the engine callbacks, and leave the registry. Idempotent. */
static void fx_settle(FxTransfer *t) {
  if (t->done) return;
  t->done = true;
  if (t->client) {
    scr_http_client_release(t->client);
    t->client = NULL;
  }
  if (t->cbs_live) {
    JS_FreeValue(t->ctx, t->cbs);
    t->cbs = JS_UNDEFINED;
    t->cbs_live = false;
  }
  for (FxTransfer **link = &fx_live; *link; link = &(*link)->next) {
    if (*link == t) {
      *link = t->next;
      fx_nlive--;
      fx_release(t); /* the registry's +1 */
      return;
    }
  }
}

/* Calls one callback off the cbs object, swallowing (but reporting) any
 * engine exception — the callbacks are our own glue and must not throw.
 * Entered from the net dispatch station (the main stack): re-anchor the
 * engine's stack-overflow check first, the every-island-entry rule. */
static void fx_call(FxTransfer *t, const char *name, int argc, JSValueConst *argv) {
  if (!t->cbs_live) return;
  scr_island_host_enter();
  JSContext *ctx = t->ctx;
  JSValue fn = JS_GetPropertyStr(ctx, t->cbs, name);
  JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
  JS_FreeValue(ctx, fn);
  if (JS_IsException(r)) {
    JSValue e = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, e);
    fprintf(stderr, "scriptc: fetch internal callback '%s' threw: %s\n", name,
            msg ? msg : "?");
    if (msg) JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, e);
    return;
  }
  JS_FreeValue(ctx, r);
}

/* Network failure → onError(detail, code) → the glue's TypeError "fetch
 * failed" with the classified cause. Settles the transfer. */
static void fx_error(FxTransfer *t, const char *detail, const char *code) {
  if (t->done || t->cancelled) {
    fx_settle(t);
    return;
  }
  JSContext *ctx = t->ctx;
  JSValue args[2];
  args[0] = JS_NewString(ctx, detail);
  args[1] = code ? JS_NewString(ctx, code) : JS_UNDEFINED;
  fx_call(t, "onError", 2, (JSValueConst *)args);
  JS_FreeValue(ctx, args[0]);
  JS_FreeValue(ctx, args[1]);
  fx_settle(t);
}

/* ── minted listener closures (caps[0] boxes the transfer) ───────────── */

static ScrClosure *fx_closure(FxTransfer *t, void *fn) {
  /* fn doubles as the closure's own entry: zero-payload lists (req 'end')
   * call cb->fn(cb) directly, payload lists call the fn stored beside the
   * registration — both routes land on the same handler here. */
  ScrClosure *cb = scr_closure_new(fn, 1);
  ScrBox *box = scr_box_new_obj(&fx_retain_v, &fx_release_v, NULL);
  scr_box_set_ref(box, fx_retain(t));
  cb->caps[0] = box;
  return cb;
}

/* +1 — release after use. */
static FxTransfer *fx_from(ScrClosure *cb) { return (FxTransfer *)scr_box_get_ref(cb->caps[0]); }

/* ── URL helpers ─────────────────────────────────────────────────────── */

/* scheme://[userinfo@]host[:port]path[?query][#fragment] — response.url
 * and the proxy's absolute-URI form exclude the fragment (Node). */
static ScrStr *fx_url_serialize(const ScrUrl *u, bool with_fragment) {
  size_t cap = u->scheme->len + u->userinfo->len + u->host->len + u->port->len +
               u->path->len + u->query->len + u->fragment->len + 8;
  char *buf = malloc(cap);
  if (!buf) fx_oom();
  size_t n = 0;
  memcpy(buf + n, u->scheme->data, u->scheme->len);
  n += u->scheme->len;
  buf[n++] = ':';
  if (u->has_authority) {
    buf[n++] = '/';
    buf[n++] = '/';
    if (u->userinfo->len > 0) {
      memcpy(buf + n, u->userinfo->data, u->userinfo->len);
      n += u->userinfo->len;
      buf[n++] = '@';
    }
    memcpy(buf + n, u->host->data, u->host->len);
    n += u->host->len;
    if (u->port->len > 0) {
      buf[n++] = ':';
      memcpy(buf + n, u->port->data, u->port->len);
      n += u->port->len;
    }
  }
  if (u->path->len > 0) {
    memcpy(buf + n, u->path->data, u->path->len);
    n += u->path->len;
  } else {
    buf[n++] = '/';
  }
  memcpy(buf + n, u->query->data, u->query->len);
  n += u->query->len;
  if (with_fragment) {
    memcpy(buf + n, u->fragment->data, u->fragment->len);
    n += u->fragment->len;
  }
  ScrStr *out = scr_str_new(buf, n);
  free(buf);
  return out;
}

/* Parse an absolute URL, answering NULL (static exception CLEARED) instead
 * of throwing — this unit runs inside engine host calls and the net
 * dispatch, where a pending static exception belongs to nobody. */
static ScrUrl *fx_url_parse(ScrStr *s) {
  ScrUrl *u = scr_url_new(s);
  if (!u) scr_exc_clear();
  return u;
}

/* Resolve a Location header against the current hop's URL. Handles the
 * absolute form plus the relative shapes real servers send (//authority,
 * /rooted, ?query, plain relative); everything reparses through the
 * WHATWG parser so dot segments and encoding normalize consistently. */
static ScrUrl *fx_resolve(const ScrUrl *base, const ScrStr *loc) {
  ScrStr *abs_try = scr_str_new(loc->data, loc->len);
  ScrUrl *u = fx_url_parse(abs_try);
  scr_str_release(abs_try);
  if (u) return u;
  /* relative: assemble scheme://authority + resolved path/query */
  size_t cap = base->scheme->len + base->userinfo->len + base->host->len + base->port->len +
               base->path->len + base->query->len + loc->len + 16;
  char *buf = malloc(cap);
  if (!buf) fx_oom();
  size_t n = 0;
  memcpy(buf + n, base->scheme->data, base->scheme->len);
  n += base->scheme->len;
  buf[n++] = ':';
  if (loc->len >= 2 && loc->data[0] == '/' && loc->data[1] == '/') {
    memcpy(buf + n, loc->data, loc->len);
    n += loc->len;
  } else {
    buf[n++] = '/';
    buf[n++] = '/';
    if (base->userinfo->len > 0) {
      memcpy(buf + n, base->userinfo->data, base->userinfo->len);
      n += base->userinfo->len;
      buf[n++] = '@';
    }
    memcpy(buf + n, base->host->data, base->host->len);
    n += base->host->len;
    if (base->port->len > 0) {
      buf[n++] = ':';
      memcpy(buf + n, base->port->data, base->port->len);
      n += base->port->len;
    }
    if (loc->len > 0 && loc->data[0] == '/') {
      memcpy(buf + n, loc->data, loc->len);
      n += loc->len;
    } else if (loc->len > 0 && loc->data[0] == '?') {
      memcpy(buf + n, base->path->data, base->path->len);
      n += base->path->len;
      memcpy(buf + n, loc->data, loc->len);
      n += loc->len;
    } else {
      /* plain relative: replace everything after the path's last '/' */
      size_t keep = 0;
      for (size_t i = 0; i < base->path->len; i++) {
        if (base->path->data[i] == '/') keep = i + 1;
      }
      memcpy(buf + n, base->path->data, keep);
      n += keep;
      if (keep == 0) buf[n++] = '/';
      memcpy(buf + n, loc->data, loc->len);
      n += loc->len;
    }
  }
  ScrStr *s = scr_str_new(buf, n);
  free(buf);
  ScrUrl *out = fx_url_parse(s);
  scr_str_release(s);
  return out;
}

/* The URL host with IPv6 brackets stripped (the dial/SNI form). +1. */
static ScrStr *fx_bare_host(const ScrStr *host) {
  if (host->len >= 2 && host->data[0] == '[' && host->data[host->len - 1] == ']') {
    return scr_str_new(host->data + 1, host->len - 2);
  }
  return scr_str_retain((ScrStr *)host);
}

static int fx_url_port(const ScrUrl *u, int deflt) {
  if (u->port->len == 0) return deflt;
  int p = 0;
  for (size_t i = 0; i < u->port->len; i++) p = p * 10 + (u->port->data[i] - '0');
  return p;
}

/* ── env proxy (NODE_USE_ENV_PROXY=1, undici's EnvHttpProxyAgent) ────── */

static const char *fx_env2(const char *lower, const char *upper) {
  const char *v = getenv(lower);
  if (v == NULL || v[0] == '\0') v = getenv(upper);
  return (v != NULL && v[0] != '\0') ? v : NULL;
}

/* no_proxy: comma/space-separated host suffixes; "*" excludes everything;
 * a leading dot is stripped; entries match the host exactly or at a dot
 * boundary. Port qualifiers (host:port) require the port to match. */
static bool fx_no_proxy_match(const char *list, const ScrStr *host, int port) {
  const char *p = list;
  while (*p) {
    while (*p == ',' || *p == ' ' || *p == '\t') p++;
    const char *start = p;
    while (*p && *p != ',' && *p != ' ' && *p != '\t') p++;
    size_t len = (size_t)(p - start);
    if (len == 0) continue;
    if (len == 1 && start[0] == '*') return true;
    /* split a :port qualifier */
    size_t hlen = len;
    long eport = -1;
    for (size_t i = 0; i < len; i++) {
      if (start[i] == ':') {
        hlen = i;
        eport = strtol(start + i + 1, NULL, 10);
        break;
      }
    }
    if (hlen > 0 && start[0] == '.') {
      start++;
      hlen--;
    }
    if (hlen == 0) continue;
    if (eport >= 0 && eport != port) continue;
    if (host->len == hlen) {
      bool eq = true;
      for (size_t i = 0; i < hlen && eq; i++) {
        char a = host->data[i], b = start[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
        eq = a == b;
      }
      if (eq) return true;
    } else if (host->len > hlen && host->data[host->len - hlen - 1] == '.') {
      bool eq = true;
      for (size_t i = 0; i < hlen && eq; i++) {
        char a = host->data[host->len - hlen + i], b = start[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
        eq = a == b;
      }
      if (eq) return true;
    }
  }
  return false;
}

/* The proxy for this hop's target, parsed (+1), or NULL for direct. */
static ScrUrl *fx_proxy_for(const ScrUrl *target, bool https, int target_port) {
  const char *optin = getenv("NODE_USE_ENV_PROXY");
  if (optin == NULL || strcmp(optin, "1") != 0) return NULL;
  const char *proxy = https ? fx_env2("https_proxy", "HTTPS_PROXY")
                            : fx_env2("http_proxy", "HTTP_PROXY");
  if (proxy == NULL) return NULL;
  const char *no = fx_env2("no_proxy", "NO_PROXY");
  if (no != NULL && fx_no_proxy_match(no, target->host, target_port)) return NULL;
  ScrStr *ps = scr_str_new(proxy, strlen(proxy));
  ScrUrl *u = fx_url_parse(ps);
  scr_str_release(ps);
  return u;
}

/* ── DNS (the dns.lookup precedent: getaddrinfo at hop start) ────────── */

/* The address to DIAL for `host` (+1): brackets strip, then the shared
 * blocking lookup (scr_net.c) — IP literals and localhost pass through,
 * hostnames resolve first-answer, and resolution failure answers the
 * HOSTNAME unchanged so the dial's deferred "getaddrinfo ENOTFOUND host"
 * error is Node's exact cause. */
static ScrStr *fx_dial_host(const ScrStr *host) {
  ScrStr *bare = fx_bare_host(host);
  ScrStr *out = scr_net_blocking_lookup(bare);
  scr_str_release(bare);
  return out;
}

/* ── the hop ─────────────────────────────────────────────────────────── */

static void fx_on_response(ScrClosure *cb, ScrHttpReq *res /*+1*/);
static void fx_on_client_error(ScrClosure *cb, ScrStr *msg /*borrowed*/);
static void fx_on_upgrade(
    ScrClosure *cb, ScrHttpReq *res, ScrNetSocket *socket,
    ScrBytes *head);

static void fx_start_hop(FxTransfer *t) {
  ScrUrl *u = t->url;
  bool https = fx_str_is(u->scheme, "https");
  int default_port = https ? 443 : 80;
  int port = fx_url_port(u, default_port);
  ScrUrl *proxy = https ? NULL : fx_proxy_for(u, https, port);

  /* undici's request head, in undici's order: host, connection, the user
   * headers, then the fetch defaults for whatever the user left unset. */
  size_t nuser = (size_t)scr_arr_len(t->headers);
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, nuser + 16);
  if (!fx_pairs_have(t->headers, "host")) {
    char authority[300];
    int alen;
    if (port != default_port) {
      alen = snprintf(authority, sizeof authority, "%.*s:%d", (int)u->host->len, u->host->data, port);
    } else {
      alen = snprintf(authority, sizeof authority, "%.*s", (int)u->host->len, u->host->data);
    }
    fx_pairs_push(pairs, "host", authority, (size_t)alen);
  }
  if (!fx_pairs_have(t->headers, "connection")) {
    fx_pairs_push(pairs, "connection", "keep-alive", 10);
  }
  for (size_t i = 0; i + 1 < nuser; i += 2) {
    scr_arr_push_ref(pairs, scr_arr_get_ref(t->headers, (double)i));
    scr_arr_push_ref(pairs, scr_arr_get_ref(t->headers, (double)(i + 1)));
  }
  if (!fx_pairs_have(t->headers, "accept")) fx_pairs_push(pairs, "accept", "*/*", 3);
  if (!fx_pairs_have(t->headers, "accept-language")) fx_pairs_push(pairs, "accept-language", "*", 1);
  if (!fx_pairs_have(t->headers, "sec-fetch-mode")) fx_pairs_push(pairs, "sec-fetch-mode", "cors", 4);
  if (!fx_pairs_have(t->headers, "user-agent")) fx_pairs_push(pairs, "user-agent", "node", 4);
  if (!fx_pairs_have(t->headers, "accept-encoding")) {
    fx_pairs_push(pairs, "accept-encoding", "gzip, deflate", 13);
  }

  /* the request-target and the wire to dial */
  ScrStr *path;
  ScrStr *dial;
  int dial_port;
  if (proxy != NULL) {
    path = fx_url_serialize(u, false); /* absolute-URI through the proxy */
    dial = fx_dial_host(proxy->host);
    dial_port = fx_url_port(proxy, 80);
  } else {
    if (u->query->len > 0) {
      size_t plen = (u->path->len > 0 ? u->path->len : 1) + u->query->len;
      char *pb = malloc(plen);
      if (!pb) fx_oom();
      size_t n = 0;
      if (u->path->len > 0) {
        memcpy(pb, u->path->data, u->path->len);
        n = u->path->len;
      } else {
        pb[n++] = '/';
      }
      memcpy(pb + n, u->query->data, u->query->len);
      n += u->query->len;
      path = scr_str_new(pb, n);
      free(pb);
    } else {
      path = u->path->len > 0 ? scr_str_retain(u->path) : scr_str_new("/", 1);
    }
    dial = fx_dial_host(u->host);
    dial_port = port;
  }

  ScrHttpClientReq *c;
  if (https) {
    ScrStr *sni = fx_bare_host(u->host);
    void *cli = scr_tls_fetch_client_ctx(sni, true);
    scr_str_release(sni);
    c = scr_http_request_ex(dial, dial_port, path, t->method, 0, pairs, false, NULL, NULL,
                             443, &scr_tls_fetch_client_wrap, cli);
  } else {
    c = scr_http_request_ex(dial, dial_port, path, t->method, 0, pairs, false, NULL, NULL,
                             80, NULL, NULL);
  }
  scr_str_release(dial);
  scr_str_release(path);
  scr_arr_release(pairs);
  if (proxy) scr_url_release(proxy);

  t->client = c; /* the constructor's +1 */
  scr_http_client_on_response(c, fx_closure(t, (void *)&fx_on_response), &fx_on_response, true);
  scr_http_client_on_upgrade(c, fx_closure(t, (void *)&fx_on_upgrade), &fx_on_upgrade, true);
  scr_http_client_on_error(c, fx_closure(t, (void *)&fx_on_client_error), &fx_on_client_error, false);
  if (t->body != NULL) scr_http_client_end_bytes(c, t->body);
  else scr_http_client_end(c);
}

/* ── redirects ───────────────────────────────────────────────────────── */

static void fx_strip_header(ScrArr **headers, const char *name) {
  ScrArr *old = *headers;
  size_t n = (size_t)scr_arr_len(old);
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, n);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *nm = (ScrStr *)scr_arr_get_ref(old, (double)i);
    if (fx_eq_ci(nm->data, nm->len, name)) {
      scr_str_release(nm);
      continue;
    }
    scr_arr_push_ref(out, nm);
    scr_arr_push_ref(out, scr_arr_get_ref(old, (double)(i + 1)));
  }
  scr_arr_release(old);
  *headers = out;
}

/* Follows one redirect hop: rewrites the request per the fetch spec and
 * dials the next URL. Consumes nothing; the caller drops res/client. */
static bool fx_redirect(FxTransfer *t, int status, const ScrStr *loc) {
  if (t->hops >= 20) {
    fx_error(t, "redirect count exceeded", NULL);
    return false;
  }
  t->hops++;
  t->redirected = true;
  ScrUrl *next = fx_resolve(t->url, loc);
  if (next == NULL ||
      !(fx_str_is(next->scheme, "http") || fx_str_is(next->scheme, "https"))) {
    if (next) scr_url_release(next);
    fx_error(t, "invalid redirect URL", NULL);
    return false;
  }
  /* 303 rewrites everything but GET/HEAD to GET; 301/302 rewrite POST —
   * the body and its content-* headers drop with the rewrite. */
  bool is_get = fx_str_is(t->method, "GET");
  bool is_head = fx_str_is(t->method, "HEAD");
  if ((status == 303 && !is_get && !is_head) ||
      ((status == 301 || status == 302) && fx_str_is(t->method, "POST"))) {
    scr_str_release(t->method);
    t->method = scr_str_new("GET", 3);
    if (t->body) {
      scr_bytes_release(t->body);
      t->body = NULL;
    }
    fx_strip_header(&t->headers, "content-type");
    fx_strip_header(&t->headers, "content-length");
    fx_strip_header(&t->headers, "content-encoding");
    fx_strip_header(&t->headers, "content-language");
    fx_strip_header(&t->headers, "content-location");
  }
  /* cross-origin hop: credentials do not follow (the fetch spec's
   * authorization rule; cookies are not modeled as ambient state). */
  bool same_origin = t->url->host->len == next->host->len &&
                     memcmp(t->url->host->data, next->host->data, next->host->len) == 0 &&
                     fx_url_port(t->url, 0) == fx_url_port(next, 0) &&
                     t->url->scheme->len == next->scheme->len &&
                     memcmp(t->url->scheme->data, next->scheme->data, next->scheme->len) == 0;
  if (!same_origin) {
    fx_strip_header(&t->headers, "authorization");
    fx_strip_header(&t->headers, "proxy-authorization");
    fx_strip_header(&t->headers, "cookie");
  }
  scr_url_release(t->url);
  t->url = next;
  return true;
}

/* ── response delivery ───────────────────────────────────────────────── */

static void fx_emit_chunk(FxTransfer *t, const uint8_t *data, size_t len) {
  if (len == 0) return;
  JSValue chunk = JS_NewUint8ArrayCopy(t->ctx, data, len);
  fx_call(t, "onData", 1, (JSValueConst *)&chunk);
  JS_FreeValue(t->ctx, chunk);
}

static void fx_on_data(ScrClosure *cb, ScrBytes *chunk /*borrowed*/) {
  FxTransfer *t = fx_from(cb);
  if (t == NULL) return;
  if (t->done || t->cancelled || !t->responded) {
    fx_release(t);
    return;
  }
  if (!t->inflating) {
    fx_emit_chunk(t, chunk->data, chunk->len);
    fx_release(t);
    return;
  }
  t->zs.next_in = (Bytef *)chunk->data;
  t->zs.avail_in = (uInt)chunk->len;
  unsigned char out[16384];
  while (t->zs.avail_in > 0 && !t->done) {
    t->zs.next_out = out;
    t->zs.avail_out = sizeof out;
    int r = inflate(&t->zs, Z_NO_FLUSH);
    size_t produced = sizeof out - t->zs.avail_out;
    if (produced > 0) fx_emit_chunk(t, out, produced);
    if (r == Z_STREAM_END) break; /* trailing bytes (if any) are dropped */
    if (r != Z_OK && r != Z_BUF_ERROR) {
      /* corrupt encoding: the body errors (the glue turns a post-resolve
       * onError into controller.error — undici's terminated shape) */
      const char *detail = t->zs.msg ? t->zs.msg : "invalid compressed body";
      ScrHttpClientReq *c = t->client;
      if (c) scr_http_client_destroy(c);
      fx_error(t, detail, NULL);
      break;
    }
    if (r == Z_BUF_ERROR && produced == 0) break; /* need more input */
  }
  fx_release(t);
}

static void fx_on_end(ScrClosure *cb) {
  FxTransfer *t = fx_from(cb);
  if (t == NULL) return;
  if (t->done || t->cancelled) {
    fx_release(t);
    return;
  }
  fx_call(t, "onEnd", 0, NULL);
  fx_settle(t);
  fx_release(t);
}

/* Mid-body death ('aborted' on the response): the body errors. */
static void fx_on_res_error(ScrClosure *cb, ScrStr *msg /*borrowed*/) {
  FxTransfer *t = fx_from(cb);
  if (t == NULL) return;
  if (t->done || t->cancelled) {
    fx_release(t);
    return;
  }
  fx_error(t, msg->len > 0 ? msg->data : "aborted", NULL);
  fx_release(t);
}

static void fx_on_response(ScrClosure *cb, ScrHttpReq *res /*+1*/) {
  FxTransfer *t = fx_from(cb);
  if (t == NULL) {
    scr_http_req_release(res);
    return;
  }
  if (t->done || t->cancelled) {
    scr_http_req_release(res);
    fx_release(t);
    return;
  }
  int status = (int)scr_http_req_status(res);

  /* a redirect hop? (Location present, a redirect status) */
  if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
    ScrStr *locname = scr_str_new("location", 8);
    ScrStr *loc = scr_http_req_header(res, locname);
    scr_str_release(locname);
    if (loc != NULL) {
      /* drop this hop's connection (its body never reaches the island) */
      ScrHttpClientReq *old = t->client;
      t->client = NULL;
      bool go = fx_redirect(t, status, loc);
      scr_str_release(loc);
      if (old) {
        scr_http_client_destroy(old);
        scr_http_client_release(old);
      }
      if (go) fx_start_hop(t);
      scr_http_req_release(res);
      fx_release(t);
      return;
    }
    /* a FINAL 3xx (no Location) resolves with its own body, like Node —
     * the curl bridge documented this corner away; this unit delivers it */
  }

  t->responded = true;

  /* content-encoding: gzip/x-gzip/deflate inflate transparently (zlib's
   * 15+32 auto-detects the gzip and zlib framings) */
  {
    ScrStr *cename = scr_str_new("content-encoding", 16);
    ScrStr *ce = scr_http_req_header(res, cename);
    scr_str_release(cename);
    if (ce != NULL) {
      if (fx_str_is(ce, "gzip") || fx_str_is(ce, "x-gzip") || fx_str_is(ce, "deflate")) {
        memset(&t->zs, 0, sizeof t->zs);
        if (inflateInit2(&t->zs, 15 + 32) == Z_OK) t->inflating = true;
      }
      scr_str_release(ce);
    }
  }

  JSContext *ctx = t->ctx;
  ScrArr *raw = scr_http_req_raw_headers(res);
  size_t nraw = (size_t)scr_arr_len(raw);
  JSValue hdrs = JS_NewArray(ctx);
  for (size_t i = 0; i < nraw; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(raw, (double)i);
    JS_SetPropertyUint32(ctx, hdrs, (uint32_t)i, JS_NewStringLen(ctx, s->data, s->len));
    scr_str_release(s);
  }
  scr_arr_release(raw);
  ScrStr *stext = scr_http_req_status_message(res);
  ScrStr *final_url = fx_url_serialize(t->url, false);
  JSValue argv[5] = {
      JS_NewInt32(ctx, status),
      JS_NewStringLen(ctx, stext ? stext->data : "", stext ? stext->len : 0),
      hdrs,
      JS_NewStringLen(ctx, final_url->data, final_url->len),
      JS_NewBool(ctx, t->redirected),
  };
  if (stext) scr_str_release(stext);
  scr_str_release(final_url);
  fx_call(t, "onResponse", 5, argv);
  for (int i = 0; i < 5; i++) JS_FreeValue(ctx, argv[i]);

  /* body listeners (registered inside the 'response' emit — the parser
   * delivers body bytes only after this returns, ended bodies fire 'end'
   * right behind us) */
  scr_http_req_on_data(res, fx_closure(t, (void *)&fx_on_data), &fx_on_data, false);
  scr_http_req_on_end(res, fx_closure(t, (void *)&fx_on_end), false);
  scr_http_req_on_error(res, fx_closure(t, (void *)&fx_on_res_error), &fx_on_res_error, false);

  scr_http_req_release(res);
  fx_release(t);
}

/* Pre-response failure on the hop client: classify into Node's causes. */
static void fx_on_client_error(ScrClosure *cb, ScrStr *msg /*borrowed*/) {
  FxTransfer *t = fx_from(cb);
  if (t == NULL) return;
  if (t->done || t->cancelled || t->responded) {
    fx_release(t);
    return;
  }
  const char *detail = msg->data;
  const char *code = NULL;
  char codebuf[32];
  if (msg->len > 8 && memcmp(detail, "connect E", 9) == 0) {
    /* "connect ECONNREFUSED ip:port" and family: the code is the token */
    const char *s = detail + 8;
    size_t n = 0;
    while (s[n] != '\0' && s[n] != ' ' && n < sizeof codebuf - 1) n++;
    memcpy(codebuf, s, n);
    codebuf[n] = '\0';
    code = codebuf;
  } else if (msg->len > 12 && memcmp(detail, "getaddrinfo E", 13) == 0) {
    const char *s = detail + 12;
    size_t n = 0;
    while (s[n] != '\0' && s[n] != ' ' && n < sizeof codebuf - 1) n++;
    memcpy(codebuf, s, n);
    codebuf[n] = '\0';
    code = codebuf;
  } else if (fx_eq_ci(detail, msg->len, "socket hang up")) {
    /* undici's cause for a server that died before the response head */
    detail = "other side closed";
    code = "UND_ERR_SOCKET";
  }
  fx_error(t, detail, code);
  fx_release(t);
}

static void fx_on_upgrade(
    ScrClosure *cb, ScrHttpReq *res, ScrNetSocket *socket,
    ScrBytes *head) {
  FxTransfer *t = fx_from(cb);
  scr_http_req_release(res);
  scr_bytes_release(head);
  scr_net_sock_destroy(socket);
  scr_net_sock_release(socket);
  if (t == NULL) return;
  if (!t->done && !t->cancelled) {
    fx_error(t, "unexpected server response", NULL);
  } else {
    fx_settle(t);
  }
  fx_release(t);
}

/* ── host functions (called by the fetch glue, inside the engine) ────── */

/* host.start({url, method, headers: [n,v,...], body: Uint8Array|undefined},
 * cbs) → transfer id. Everything is copied out of the engine before the
 * net stack sees it. An unparsable URL throws the engine TypeError the
 * promise executor turns into Node's rejection shape. */
static JSValue fx_host_start(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  JSValueConst req = argv[0];

  JSValue urlv = JS_GetPropertyStr(ctx, req, "url");
  const char *url = JS_ToCString(ctx, urlv);
  JS_FreeValue(ctx, urlv);
  if (!url) return JS_EXCEPTION;
  ScrStr *urlstr = scr_str_new(url, strlen(url));
  ScrUrl *u = fx_url_parse(urlstr);
  scr_str_release(urlstr);
  if (u == NULL) {
    JSValue e = JS_ThrowTypeError(ctx, "Failed to parse URL from %s", url);
    JS_FreeCString(ctx, url);
    return e;
  }
  JS_FreeCString(ctx, url);
  if (!(fx_str_is(u->scheme, "http") || fx_str_is(u->scheme, "https"))) {
    scr_url_release(u);
    return JS_ThrowTypeError(ctx, "fetch failed");
  }

  FxTransfer *t = calloc(1, sizeof *t);
  if (!t) fx_oom();
  t->rc = 1; /* the registry's */
  t->ctx = ctx;
  t->id = fx_next_id++;
  t->cbs = JS_DupValue(ctx, argv[1]);
  t->cbs_live = true;
  t->url = u;

  JSValue methodv = JS_GetPropertyStr(ctx, req, "method");
  const char *method = JS_ToCString(ctx, methodv);
  JS_FreeValue(ctx, methodv);
  t->method = scr_str_new(method ? method : "GET", method ? strlen(method) : 3);
  if (method) JS_FreeCString(ctx, method);

  JSValue hdrs = JS_GetPropertyStr(ctx, req, "headers");
  JSValue lenv = JS_GetPropertyStr(ctx, hdrs, "length");
  uint32_t hn = 0;
  JS_ToUint32(ctx, &hn, lenv);
  JS_FreeValue(ctx, lenv);
  t->headers = scr_arr_new(SCR_ELEM_STR, hn);
  for (uint32_t i = 0; i + 1 < hn; i += 2) {
    JSValue nv = JS_GetPropertyUint32(ctx, hdrs, i);
    JSValue vv = JS_GetPropertyUint32(ctx, hdrs, i + 1);
    size_t nlen = 0, vlen = 0;
    const char *hname = JS_ToCStringLen(ctx, &nlen, nv);
    const char *hvalue = JS_ToCStringLen(ctx, &vlen, vv);
    if (hname && hvalue) {
      scr_arr_push_ref(t->headers, scr_str_new(hname, nlen));
      scr_arr_push_ref(t->headers, scr_str_new(hvalue, vlen));
    }
    if (hname) JS_FreeCString(ctx, hname);
    if (hvalue) JS_FreeCString(ctx, hvalue);
    JS_FreeValue(ctx, nv);
    JS_FreeValue(ctx, vv);
  }
  JS_FreeValue(ctx, hdrs);

  JSValue bodyv = JS_GetPropertyStr(ctx, req, "body");
  if (!JS_IsUndefined(bodyv) && !JS_IsNull(bodyv)) {
    size_t blen = 0;
    uint8_t *bytes = JS_GetUint8Array(ctx, &blen, bodyv);
    if (bytes != NULL || blen == 0) {
      t->body = scr_bytes_new(SCR_BYTES_U8, (double)blen);
      if (blen > 0) memcpy(t->body->data, bytes, blen);
    }
  }
  JS_FreeValue(ctx, bodyv);

  t->next = fx_live;
  fx_live = t;
  fx_nlive++;
  fx_start_hop(t);
  return JS_NewInt32(ctx, t->id);
}

/* host.abort(id): the island aborted the fetch or cancelled the response
 * body stream. The transfer dies quietly — no onError, no onEnd. */
static JSValue fx_host_abort(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  for (FxTransfer *t = fx_live; t; t = t->next) {
    if (t->id == id) {
      t->cancelled = true;
      if (t->client) scr_http_client_destroy(t->client);
      fx_settle(t);
      break;
    }
  }
  return JS_UNDEFINED;
}

/* ── the JS half (UNCHANGED from the curl bridge — the island surface,
 * abort wiring, and error shaping are the contract the fixture suite
 * pins) ──────────────────────────────────────────────────────────────── */

static const char fx_glue[] =
    "(host) => {\n"
    "  'use strict';\n"
    "  const g = globalThis;\n"
    "  const NULL_BODY = { 204: true, 205: true, 304: true };\n"
    "  g.fetch = function fetch(input, init) {\n"
    "    return new Promise((resolve, reject) => {\n"
    "      let url;\n"
    "      let method = 'GET';\n"
    "      let headers = null;\n"
    "      let body = null;\n"
    "      let signal = null;\n"
    "      if (input instanceof g.Request) {\n"
    "        url = input.url;\n"
    "        method = input.method;\n"
    "        headers = new g.Headers(input.headers);\n"
    "        body = input._body instanceof Uint8Array ? input._body : null;\n"
    "        signal = input._signal;\n"
    "      } else {\n"
    "        url = String(input);\n"
    "      }\n"
    "      init = init === undefined || init === null ? {} : init;\n"
    "      // An explicit init.signal overrides the Request's, null included.\n"
    "      if (init.signal !== undefined) {\n"
    "        if (init.signal !== null && !(init.signal instanceof g.AbortSignal)) {\n"
    "          throw new TypeError('fetch init.signal must be an AbortSignal or null');\n"
    "        }\n"
    "        signal = init.signal;\n"
    "      }\n"
    "      if (init.redirect !== undefined && init.redirect !== 'follow') {\n"
    "        throw new Error(\"scriptc: only redirect: 'follow' is supported by the embedded fetch\");\n"
    "      }\n"
    "      // Reuse Request's init handling: method normalization, header\n"
    "      // collection, body coercion with its implicit content-type, and the\n"
    "      // GET/HEAD-with-body TypeError.\n"
    "      const reqInit = {};\n"
    "      if (init.method !== undefined) reqInit.method = init.method;\n"
    "      if (init.headers !== undefined) reqInit.headers = init.headers;\n"
    "      if (init.body !== undefined && init.body !== null) reqInit.body = init.body;\n"
    "      if (reqInit.method !== undefined || reqInit.headers !== undefined || reqInit.body !== undefined || headers === null) {\n"
    "        const base = input instanceof g.Request ? input : url;\n"
    "        const r = new g.Request(base, reqInit);\n"
    "        method = r.method;\n"
    "        headers = r.headers;\n"
    "        if (r._body instanceof Uint8Array) body = r._body;\n"
    "      }\n"
    "      if (body !== null && !(body instanceof Uint8Array)) {\n"
    "        throw new TypeError('streaming request bodies are not supported in the scriptc island');\n"
    "      }\n"
    "      // An already-aborted signal rejects with ITS reason before any\n"
    "      // transfer starts (Node: validation above still throws first).\n"
    "      if (signal !== null && signal.aborted) {\n"
    "        reject(signal.reason);\n"
    "        return;\n"
    "      }\n"
    "      let controller = null;\n"
    "      let resolved = false;\n"
    "      let done = false;\n"
    "      let id = 0;\n"
    "      // The transfer is over (delivered, failed, cancelled, or aborted):\n"
    "      // a later signal abort must not touch it.\n"
    "      const finish = () => {\n"
    "        done = true;\n"
    "        if (signal !== null) signal.removeEventListener('abort', onAbort);\n"
    "      };\n"
    "      const onAbort = () => {\n"
    "        if (done) return;\n"
    "        finish();\n"
    "        host.abort(id); // the C side dies quietly; rejection is ours\n"
    "        if (!resolved) {\n"
    "          resolved = true;\n"
    "          reject(signal.reason);\n"
    "        } else if (controller !== null) {\n"
    "          // Mid-stream: pending and future reads reject with the reason,\n"
    "          // exactly Node's aborted-body behavior.\n"
    "          try { controller.error(signal.reason); } catch (_e) { /* already closed */ }\n"
    "          controller = null;\n"
    "        }\n"
    "      };\n"
    "      const flat = [];\n"
    "      for (const pair of headers) { flat.push(pair[0], pair[1]); }\n"
    "      id = host.start(\n"
    "        { url, method, headers: flat, body: body === null ? undefined : body },\n"
    "        {\n"
    "          onResponse(status, statusText, raw, finalUrl, redirected) {\n"
    "            resolved = true;\n"
    "            const h = new g.Headers();\n"
    "            for (let i = 0; i + 1 < raw.length; i += 2) {\n"
    "              try { h.append(raw[i], raw[i + 1]); } catch (_e) { /* junk line */ }\n"
    "            }\n"
    "            let stream = null;\n"
    "            if (method !== 'HEAD' && NULL_BODY[status] !== true) {\n"
    "              stream = new g.ReadableStream({\n"
    "                start(c) { controller = c; },\n"
    "                cancel() { controller = null; finish(); host.abort(id); },\n"
    "              });\n"
    "            }\n"
    "            resolve(g.__scr_mk_response(status, statusText, h, finalUrl, redirected, stream));\n"
    "          },\n"
    "          onData(chunk) {\n"
    "            if (controller !== null) {\n"
    "              try { controller.enqueue(chunk); } catch (_e) { /* consumer went away */ }\n"
    "            }\n"
    "          },\n"
    "          onEnd() {\n"
    "            finish();\n"
    "            if (controller !== null) {\n"
    "              try { controller.close(); } catch (_e) { /* already errored */ }\n"
    "              controller = null;\n"
    "            }\n"
    "          },\n"
    "          onError(detail, code) {\n"
    "            finish();\n"
    "            if (!resolved) {\n"
    "              // Node's shape: TypeError 'fetch failed' with a CAUSE the\n"
    "              // wrappers classify (message + code for the network cases).\n"
    "              const cause = new Error(String(detail));\n"
    "              if (code !== undefined) cause.code = code;\n"
    "              if (code === 'ECONNREFUSED') cause.syscall = 'connect';\n"
    "              else if (code === 'ENOTFOUND') cause.syscall = 'getaddrinfo';\n"
    "              const err = new TypeError('fetch failed');\n"
    "              err.cause = cause;\n"
    "              reject(err);\n"
    "            } else if (controller !== null) {\n"
    "              try { controller.error(new TypeError('terminated')); } catch (_e) { /* already closed */ }\n"
    "              controller = null;\n"
    "            }\n"
    "          },\n"
    "        },\n"
    "      );\n"
    "      if (signal !== null) signal.addEventListener('abort', onAbort, { once: true });\n"
    "    });\n"
    "  };\n"
    "}\n";

/* ── boot / teardown (registered with the island) ────────────────────── */

static void fx_boot(void *jsctx) {
  JSContext *ctx = (JSContext *)jsctx;
  JSValue fn = JS_Eval(ctx, fx_glue, sizeof fx_glue - 1, "<scr-fetch>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(fn)) {
    fprintf(stderr, "scriptc: island fetch glue failed to evaluate\n");
    abort();
  }
  JSValue host = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, host, "start", JS_NewCFunction(ctx, fx_host_start, "start", 2));
  JS_SetPropertyStr(ctx, host, "abort", JS_NewCFunction(ctx, fx_host_abort, "abort", 1));
  JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, (JSValueConst *)&host);
  JS_FreeValue(ctx, host);
  JS_FreeValue(ctx, fn);
  if (JS_IsException(r)) {
    fprintf(stderr, "scriptc: island fetch glue failed to run\n");
    abort();
  }
  JS_FreeValue(ctx, r);
}

/* Engine teardown with transfers still live (process.exit mid-request, or
 * an exit with an abandoned body stream): free their engine values FIRST
 * so the island's counting allocator returns to zero. The net/http exit
 * cleanups (registered later, so they run earlier — atexit LIFO) have
 * already dropped the listener closures; whatever the registry still
 * holds settles here. */
static void fx_teardown(void) {
  while (fx_live) fx_settle(fx_live);
}

/* The emitted main calls this (before any island entry) in builds whose
 * embedded graph references fetch. No pending/poll hooks: transfers live
 * on real sockets the loop's own poller sleeps on, and armed island
 * timers cap that sleep through the loop's island-deadline hook. */
void scr_fetch_install(void) {
  static bool installed = false;
  if (installed) return;
  installed = true;
  /* The net unit's loop hooks (pending/dispatch/pollfd): the emitted main
   * registers them only for programs that USE node:net — a fetch-only
   * build must register them itself or its sockets would neither keep
   * the loop alive nor dispatch. */
  scr_net_install();
  /* The island's node:http/https client bridge rides the same units and
   * is always compiled beside the native fetch (cc.ts) — embedded graphs
   * that require node:http/https get working clients, not refusals. */
  scr_net_island_install();
  scr_island_set_fetch(fx_boot, NULL, NULL, fx_teardown);
}

#endif /* SCR_DYNAMIC */
