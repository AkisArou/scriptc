/* Native IR opaque handles. The foreign pointer never becomes a TypeScript
 * value: generated code owns this refcounted cell and asks it for a borrowed
 * pointer only for the duration of one validated native call.
 *
 * Most handles remain lean malloc cells. A handle type becomes collector-
 * visible only when generated ownership edges can put it in a managed cycle:
 * receiver-owned child handles and callback anchors are then traced exactly
 * like fields on an ordinary ScriptC object. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>

typedef struct ScrNativeLifecycleEdge {
  ScrNativeLifecycleKind kind;
  void *context;
  ScrNativeLifecycleFn commit;
  ScrNativeLifecycleFn abandon;
  ScrNativeLifecycleFn begin;
  ScrNativeLifecycleFn complete;
  ScrNativeLifecycleTraceFn trace;
  ScrNativeLifecycleFn collect_begin;
  ScrNativeLifecycleFn collect_complete;
  ScrNativeLifecycleFn destroy_context;
  struct ScrNativeLifecycleEdge *next;
  bool cancelling;
} ScrNativeLifecycleEdge;

typedef struct ScrNativeOwnerEdge {
  struct ScrNativeHandle *owner;
  struct ScrNativeHandle *child;
  struct ScrNativeOwnerEdge *previous;
  struct ScrNativeOwnerEdge *next;
  bool committed;
} ScrNativeOwnerEdge;

typedef enum {
  SCR_NATIVE_HANDLE_PREPARED,
  SCR_NATIVE_HANDLE_LIVE,
  SCR_NATIVE_HANDLE_DISPOSING,
  SCR_NATIVE_HANDLE_DISPOSED,
} ScrNativeHandleState;

struct ScrNativeHandle {
  size_t rc;
  void *foreign;
  ScrNativeDestructor destructor;
  const ScrNativeHandleType *type;
  const char *type_name;
  ScrNativeLifecycleEdge *lifecycle;
  ScrNativeOwnerEdge *owner_edge;
  ScrNativeOwnerEdge *children;
  ScrNativeHandleState state;
};

/* Identity map for interned handle types.
 *
 * Chained buckets keyed by the pointer alone. Not by pointer and type: one
 * object read as a Box and again as a Widget is one object, and keying on the
 * static type would mint a second cell for it — the exact split this map
 * exists to prevent. A cell carries its own type, and an identity upcast
 * already lets a Box cell stand where a Widget is expected.
 *
 * The entry does not own the handle: an owning entry would keep every projected
 * object alive forever. It is removed the moment the cell stops being live,
 * which is the single place a foreign pointer is dropped, so a disposed cell is
 * never handed back.
 *
 * Unsynchronised on purpose. A native handle is owner-confined, so every
 * projection of one runs on the thread that owns it. */
#define SCR_NATIVE_IDENTITY_BUCKETS 64u

typedef struct ScrNativeIdentityEntry {
  void *foreign;
  ScrNativeHandle *handle;
  struct ScrNativeIdentityEntry *next;
} ScrNativeIdentityEntry;

static ScrNativeIdentityEntry
    *scr_native_identity[SCR_NATIVE_IDENTITY_BUCKETS];

static size_t scr_native_identity_bucket(const void *foreign) {
  return (size_t)(((uintptr_t)foreign >> 4) % SCR_NATIVE_IDENTITY_BUCKETS);
}

ScrNativeHandle *scr_native_handle_interned(const ScrNativeHandleType *type,
                                            void *foreign) {
  if (type == NULL || !type->interned || foreign == NULL) return NULL;
  size_t bucket = scr_native_identity_bucket(foreign);
  for (ScrNativeIdentityEntry *entry = scr_native_identity[bucket];
       entry != NULL; entry = entry->next) {
    if (entry->foreign == foreign) return scr_native_handle_retain(entry->handle);
  }
  return NULL;
}

static void scr_native_identity_insert(ScrNativeHandle *handle) {
  size_t bucket = scr_native_identity_bucket(handle->foreign);
  for (ScrNativeIdentityEntry *entry = scr_native_identity[bucket];
       entry != NULL; entry = entry->next) {
    if (entry->foreign == handle->foreign) {
      /* Two live cells for one object is the state interning exists to
       * prevent, and continuing would leave equality answering by luck. */
      scr_trap("scriptc: native handle interned twice for one object\n");
    }
  }
  ScrNativeIdentityEntry *entry = calloc(1, sizeof *entry);
  if (entry == NULL) scr_trap("scriptc: out of memory interning a native handle\n");
  entry->foreign = handle->foreign;
  entry->handle = handle;
  entry->next = scr_native_identity[bucket];
  scr_native_identity[bucket] = entry;
}

static void scr_native_identity_remove(const void *foreign) {
  size_t bucket = scr_native_identity_bucket(foreign);
  ScrNativeIdentityEntry **link = &scr_native_identity[bucket];
  while (*link != NULL) {
    ScrNativeIdentityEntry *entry = *link;
    if (entry->foreign == foreign) {
      *link = entry->next;
      free(entry);
      return;
    }
    link = &entry->next;
  }
}

static bool scr_native_handle_traced(const ScrNativeHandle *handle) {
  return handle->type->cycle_collected;
}

void scr_native_handle_trace_v(void *opaque, ScrTraceVisit visit,
                               void *visit_context) {
  ScrNativeHandle *handle = opaque;
  for (ScrNativeLifecycleEdge *edge = handle->lifecycle; edge != NULL;
       edge = edge->next) {
    if (edge->trace != NULL) edge->trace(edge->context, visit, visit_context);
  }
  for (ScrNativeOwnerEdge *edge = handle->children; edge != NULL;
       edge = edge->next) {
    visit(edge->child, visit_context);
  }
}

static void scr_native_handle_destroy_foreign(ScrNativeHandle *handle,
                                              bool collecting,
                                              bool run_destructor);

static void scr_native_handle_gc_free(void *opaque) {
  ScrNativeHandle *handle = opaque;
  if (handle->state == SCR_NATIVE_HANDLE_PREPARED) {
    scr_trap("scriptc: collector reached an unpublished native handle\n");
  }
  scr_native_handle_destroy_foreign(handle, true, true);
  scr_obj_free_note();
  scr_cyc_free(handle);
}

static void scr_native_handle_type_error(const ScrNativeHandle *handle,
                                         const char *operation,
                                         const char *detail) {
  const char *name = handle && handle->type_name ? handle->type_name : "native handle";
  const char *op = operation ? operation : "native operation";
  char message[384];
  int len = snprintf(message, sizeof message, "%s cannot use %s: %s", op, name, detail);
  size_t n = len < 0 ? 0 : (size_t)len < sizeof message ? (size_t)len : sizeof message - 1;
  scr_throw_error_msg(SCR_ERR_TYPE, message, n);
}

ScrNativeHandle *scr_native_handle_prepare(ScrNativeDestructor destructor,
                                           const ScrNativeHandleType *type,
                                           const char *type_name) {
  if (!destructor || !type) scr_trap("scriptc: invalid native handle metadata\n");
  ScrNativeHandle *handle = type->cycle_collected
                                ? scr_cyc_alloc(sizeof *handle,
                                                &scr_native_handle_trace_v,
                                                &scr_native_handle_gc_free)
                                : calloc(1, sizeof *handle);
  if (!handle) scr_trap("scriptc: out of memory\n");
  handle->rc = 1;
  handle->destructor = destructor;
  handle->type = type;
  handle->type_name = type_name;
  handle->state = SCR_NATIVE_HANDLE_PREPARED;
  scr_obj_alloc_note();
  return handle;
}

ScrNativeHandle *scr_native_handle_retain(ScrNativeHandle *handle) {
  if (handle && handle->rc != SIZE_MAX) {
    if (scr_native_handle_traced(handle)) scr_cyc_mark_live(handle);
    handle->rc++;
  }
  return handle;
}

ScrNativeHandle *scr_native_handle_retain_live(ScrNativeHandle *handle) {
  if (handle == NULL || handle->state != SCR_NATIVE_HANDLE_LIVE) {
    scr_trap("scriptc: retained callback source owner is not live\n");
  }
  return scr_native_handle_retain(handle);
}

static void scr_native_owner_unlink(ScrNativeOwnerEdge *edge) {
  ScrNativeHandle *owner = edge->owner;
  if (edge->previous != NULL) edge->previous->next = edge->next;
  else owner->children = edge->next;
  if (edge->next != NULL) edge->next->previous = edge->previous;
  edge->child->owner_edge = NULL;
  edge->committed = false;
}

static void scr_native_handle_detach_owner(ScrNativeHandle *handle,
                                           bool release_child) {
  ScrNativeOwnerEdge *edge = handle->owner_edge;
  if (edge == NULL) return;
  scr_native_owner_unlink(edge);
  free(edge);
  if (release_child) scr_native_handle_release(handle);
}

static void scr_native_handle_destroy_prepared(ScrNativeHandle *handle) {
  ScrNativeLifecycleEdge *lifecycle = handle->lifecycle;
  handle->lifecycle = NULL;
  if (handle->owner_edge != NULL) {
    if (handle->owner_edge->committed) {
      scr_trap("scriptc: prepared native handle has a committed owner\n");
    }
    free(handle->owner_edge);
    handle->owner_edge = NULL;
  }
  handle->state = SCR_NATIVE_HANDLE_DISPOSED;
  while (lifecycle != NULL) {
    ScrNativeLifecycleEdge *next = lifecycle->next;
    lifecycle->abandon(lifecycle->context);
    lifecycle->destroy_context(lifecycle->context);
    free(lifecycle);
    lifecycle = next;
  }
}

static bool scr_native_handle_doomed(const ScrNativeHandle *handle) {
  return scr_native_handle_traced(handle) &&
         scr_cyc_hdr((void *)handle)->color == SCR_CYC_DOOMED;
}

static void scr_native_handle_destroy_children(ScrNativeHandle *handle,
                                               bool collecting) {
  while (handle->children != NULL) {
    ScrNativeOwnerEdge *edge = handle->children;
    ScrNativeHandle *child = edge->child;
    bool child_doomed = collecting && scr_native_handle_doomed(child);
    scr_native_owner_unlink(edge);
    free(edge);
    if (!child_doomed) {
      /* A collector survivor is still disconnected with ordinary teardown;
       * only the already trial-deleted owner -> child +1 is omitted. A child
       * owns its own object, so its destructor runs whatever became of the
       * parent's reference. */
      scr_native_handle_destroy_foreign(child, false, true);
    }
    if (!collecting) scr_native_handle_release(child);
  }
}

/* The teardown of a live cell. `run_destructor` is false for exactly one
 * caller: a foreign function that takes the reference from us. Everything
 * else about the teardown is the same, because everything else is about this
 * side of the boundary — the identity entry stops naming a pointer we no
 * longer hold, the owner edge and children go, and the lifecycle hooks run in
 * the order they would for any disposal. What differs is only who frees the
 * object, and after a transfer that is not us. */
static void scr_native_handle_destroy_foreign(ScrNativeHandle *handle,
                                              bool collecting,
                                              bool run_destructor) {
  if (handle->state != SCR_NATIVE_HANDLE_LIVE) return;
  ScrNativeLifecycleEdge *lifecycle = handle->lifecycle;
  handle->lifecycle = NULL;
  void *foreign = handle->foreign;
  handle->foreign = NULL;
  handle->state = SCR_NATIVE_HANDLE_DISPOSING;
  /* Before the destructor runs, so a reentrant projection during teardown
   * cannot be handed a cell that is on its way out. */
  if (handle->type->interned) {
    scr_native_identity_remove(foreign);
  }

  for (ScrNativeLifecycleEdge *edge = lifecycle; edge != NULL;
       edge = edge->next) {
    (collecting ? edge->collect_begin : edge->begin)(edge->context);
  }
  scr_native_handle_destroy_children(handle, collecting);
  if (run_destructor) handle->destructor(foreign);
  handle->state = SCR_NATIVE_HANDLE_DISPOSED;
  while (lifecycle != NULL) {
    ScrNativeLifecycleEdge *next = lifecycle->next;
    (collecting ? lifecycle->collect_complete : lifecycle->complete)(
        lifecycle->context);
    lifecycle->destroy_context(lifecycle->context);
    free(lifecycle);
    lifecycle = next;
  }
}

void scr_native_handle_prepare_lifecycle(
    ScrNativeHandle *handle, ScrNativeLifecycleKind kind, void *context,
    ScrNativeLifecycleFn commit,
    ScrNativeLifecycleFn abandon, ScrNativeLifecycleFn begin,
    ScrNativeLifecycleFn complete, ScrNativeLifecycleTraceFn trace,
    ScrNativeLifecycleFn collect_begin,
    ScrNativeLifecycleFn collect_complete,
    ScrNativeLifecycleFn destroy_context) {
  if (handle == NULL || handle->state != SCR_NATIVE_HANDLE_PREPARED ||
      context == NULL || commit == NULL || abandon == NULL || begin == NULL ||
      complete == NULL || collect_begin == NULL || collect_complete == NULL ||
      destroy_context == NULL) {
    scr_trap("scriptc: invalid native lifecycle edge\n");
  }
  ScrNativeLifecycleEdge *edge = malloc(sizeof *edge);
  if (edge == NULL) scr_trap("scriptc: out of memory\n");
  edge->kind = kind;
  edge->context = context;
  edge->commit = commit;
  edge->abandon = abandon;
  edge->begin = begin;
  edge->complete = complete;
  edge->trace = trace;
  edge->collect_begin = collect_begin;
  edge->collect_complete = collect_complete;
  edge->destroy_context = destroy_context;
  edge->next = handle->lifecycle;
  edge->cancelling = false;
  handle->lifecycle = edge;
}

void scr_native_handle_prepare_owner(ScrNativeHandle *child,
                                     ScrNativeHandle *owner) {
  if (child == NULL || owner == NULL || child == owner ||
      child->state != SCR_NATIVE_HANDLE_PREPARED ||
      owner->state != SCR_NATIVE_HANDLE_LIVE || child->owner_edge != NULL ||
      !scr_native_handle_traced(child) || !scr_native_handle_traced(owner)) {
    scr_trap("scriptc: invalid native receiver ownership edge\n");
  }
  ScrNativeOwnerEdge *edge = calloc(1, sizeof *edge);
  if (edge == NULL) scr_trap("scriptc: out of memory\n");
  edge->owner = owner;
  edge->child = child;
  child->owner_edge = edge;
}

void scr_native_handle_commit(ScrNativeHandle *handle, void *foreign) {
  if (handle == NULL || handle->state != SCR_NATIVE_HANDLE_PREPARED ||
      foreign == NULL) {
    scr_trap("scriptc: invalid native handle commit\n");
  }
  handle->foreign = foreign;
  handle->state = SCR_NATIVE_HANDLE_LIVE;
  if (handle->type->interned) scr_native_identity_insert(handle);
  if (handle->owner_edge != NULL) {
    ScrNativeOwnerEdge *edge = handle->owner_edge;
    ScrNativeHandle *owner = edge->owner;
    if (owner->state != SCR_NATIVE_HANDLE_LIVE || edge->committed) {
      scr_trap("scriptc: native receiver disappeared during registration\n");
    }
    edge->next = owner->children;
    if (edge->next != NULL) edge->next->previous = edge;
    owner->children = edge;
    edge->committed = true;
    (void)scr_native_handle_retain(handle);
  }
  for (ScrNativeLifecycleEdge *edge = handle->lifecycle; edge != NULL;
       edge = edge->next) {
    edge->commit(edge->context);
  }
}

void scr_native_handle_abandon(ScrNativeHandle *handle) {
  if (handle == NULL || handle->state != SCR_NATIVE_HANDLE_PREPARED ||
      handle->rc != 1) {
    scr_trap("scriptc: invalid native handle abandonment\n");
  }
  scr_native_handle_release(handle);
}

void scr_native_handle_release(ScrNativeHandle *handle) {
  if (!handle || handle->rc == SIZE_MAX) return;
  if (--handle->rc != 0) {
    if (scr_native_handle_traced(handle)) {
      scr_cyc_on_release(handle); /* may collect; handle is done */
    }
    return;
  }
  if (scr_native_handle_traced(handle)) scr_cyc_on_dead(handle);
  if (handle->state == SCR_NATIVE_HANDLE_PREPARED) {
    scr_native_handle_destroy_prepared(handle);
  } else {
    scr_native_handle_destroy_foreign(handle, false, true);
  }
  scr_obj_free_note();
  if (scr_native_handle_traced(handle)) scr_cyc_free(handle);
  else free(handle);
}

void *scr_native_handle_retain_v(void *handle) {
  return scr_native_handle_retain(handle);
}

void scr_native_handle_release_v(void *handle) {
  scr_native_handle_release(handle);
}

static bool scr_native_handle_type_is(const ScrNativeHandleType *actual,
                                      const ScrNativeHandleType *expected) {
  if (actual == expected) return true;
  if (actual == NULL) return false;
  for (size_t index = 0; index < actual->identity_upcast_count; index++) {
    if (scr_native_handle_type_is(actual->identity_upcasts[index], expected)) {
      return true;
    }
  }
  return false;
}

static bool scr_native_handle_valid_type(ScrNativeHandle *handle,
                                         const ScrNativeHandleType *type,
                                         const char *operation) {
  bool valid = handle != NULL && scr_native_handle_type_is(handle->type, type);
  if (!valid) {
    scr_native_handle_type_error(handle, operation, "the handle has the wrong nominal type");
    return false;
  }
  return true;
}

bool scr_native_handle_callbacks_begin(ScrNativeHandle *handle,
                                       const ScrNativeHandleType *type,
                                       const char *operation) {
  if (!scr_native_handle_valid_type(handle, type, operation)) return false;
  if (handle->state != SCR_NATIVE_HANDLE_LIVE) {
    scr_native_handle_type_error(handle, operation, "the handle is already disposed");
    return false;
  }
  bool began = false;
  for (ScrNativeLifecycleEdge *edge = handle->lifecycle; edge != NULL;
       edge = edge->next) {
    if (edge->kind != SCR_NATIVE_LIFECYCLE_CALLBACK) continue;
    if (edge->cancelling) {
      scr_trap("scriptc: reentrant native callback cancellation\n");
    }
    edge->cancelling = true;
    edge->begin(edge->context);
    began = true;
  }
  return began;
}

void scr_native_handle_callbacks_complete(ScrNativeHandle *handle) {
  if (handle == NULL || handle->state != SCR_NATIVE_HANDLE_LIVE) {
    scr_trap("scriptc: invalid native callback cancellation completion\n");
  }
  bool completed = false;
  ScrNativeLifecycleEdge **cursor = &handle->lifecycle;
  while (*cursor != NULL) {
    ScrNativeLifecycleEdge *edge = *cursor;
    if (edge->kind != SCR_NATIVE_LIFECYCLE_CALLBACK || !edge->cancelling) {
      cursor = &edge->next;
      continue;
    }
    edge->complete(edge->context);
    *cursor = edge->next;
    edge->destroy_context(edge->context);
    free(edge);
    completed = true;
  }
  if (!completed) {
    scr_trap("scriptc: native callback cancellation was not begun\n");
  }
}

void *scr_native_handle_require(ScrNativeHandle *handle,
                                const ScrNativeHandleType *type,
                                const char *operation) {
  if (!scr_native_handle_valid_type(handle, type, operation)) return NULL;
  if (handle->state != SCR_NATIVE_HANDLE_LIVE) {
    scr_native_handle_type_error(handle, operation, "the handle is already disposed");
    return NULL;
  }
  return handle->foreign;
}

void scr_native_handle_dispose(ScrNativeHandle *handle,
                               const ScrNativeHandleType *type,
                               const char *operation) {
  if (!scr_native_handle_valid_type(handle, type, operation)) return;
  if (handle->state != SCR_NATIVE_HANDLE_LIVE) return;
  /* Detaching can release the receiver's +1 and trigger a collection. The
   * guard is an external root across that operation and callback teardown. */
  (void)scr_native_handle_retain(handle);
  scr_native_handle_detach_owner(handle, true);
  scr_native_handle_destroy_foreign(handle, false, true);
  scr_native_handle_release(handle);
}

/* A foreign function that takes the reference. The cell gives up the pointer
 * and everything it owned around it, exactly as an explicit disposal does,
 * and the one thing it does not do is free the object: the callee owns it
 * now. Using the handle afterwards is a use-after-dispose for the same reason
 * it is after `dispose()` — this side no longer holds a reference, and the
 * error says so rather than letting a stale pointer cross the boundary. */
void *scr_native_handle_surrender(ScrNativeHandle *handle,
                                  const ScrNativeHandleType *type,
                                  const char *operation) {
  void *foreign = scr_native_handle_require(handle, type, operation);
  if (foreign == NULL) return NULL;
  /* Detaching can release the receiver's +1 and trigger a collection. The
   * guard is an external root across that operation and callback teardown. */
  (void)scr_native_handle_retain(handle);
  scr_native_handle_detach_owner(handle, true);
  scr_native_handle_destroy_foreign(handle, false, false);
  scr_native_handle_release(handle);
  return foreign;
}
